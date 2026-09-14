import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { prettyPlatform, createPcmSink } from "./util.ts";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// A GUI-spawned Extension Host often gets a bare PATH (no Homebrew), so resolve the
// tools to absolute paths and also widen PATH for the child env — yt-dlp itself shells
// out to ffmpeg, so ffmpeg must be findable on the child's PATH too.
const EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

const binCache = new Map<string, string>();
function resolveBin(name: string): string {
  const cached = binCache.get(name);
  if (cached) return cached;
  let resolved = name; // fall back to PATH lookup
  try {
    for (const dir of EXTRA_PATHS) {
      const p = `${dir}/${name}`;
      if (existsSync(p)) {
        resolved = p;
        break;
      }
    }
  } catch {
    /* keep the bare name */
  }
  binCache.set(name, resolved);
  return resolved;
}

// Built lazily (inside calls) so nothing touches the filesystem or env at module load.
function runOpts() {
  return {
    maxBuffer: MAX_BUFFER,
    encoding: "utf8" as const,
    env: { ...process.env, PATH: [...EXTRA_PATHS, process.env.PATH ?? ""].filter(Boolean).join(":") },
  };
}

export interface VideoInfo {
  title: string;
  channel: string;
  duration: number; // seconds
  platform: string; // tidy label for the source site, e.g. "YouTube", "SoundCloud"
}

// ---- pure arg builders (unit-tested) ----

export function buildInfoArgs(url: string): string[] {
  // Print only the fields we use — --dump-single-json is MBs of format lists to buffer and parse.
  return ["--no-playlist", "-O", "%(.{title,channel,uploader,duration,extractor_key,extractor})j", url];
}

/** Prefix of the machine-readable progress lines yt-dlp prints to stdout during a download. */
const PROGRESS_TAG = "[yoink-progress]";

/**
 * `outTemplate` should contain `%(ext)s` (e.g. `/tmp/src.%(ext)s`) since yt-dlp picks the
 * container. `--no-simulate --print after_move:filepath` makes it download AND print the
 * actual file it wrote, so the caller never has to guess the extension.
 */
export function buildDownloadArgs(url: string, outTemplate: string): string[] {
  return [
    "-f",
    "bestaudio/best", // fall back to a combined stream when no pure-audio format exists
    "--no-playlist",
    "--no-simulate",
    "--print",
    "after_move:filepath",
    // --print implies --quiet; turn progress back on as one parseable stdout line per update.
    "--progress",
    "--newline",
    "--progress-template",
    `download:${PROGRESS_TAG} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`,
    "-o",
    outTemplate,
    url,
  ];
}

/**
 * Download fraction (0–1) from one of our progress lines, or null for any other line. yt-dlp
 * prints "NA" for unknown sizes; its size estimate stands in when the exact total is unknown.
 */
export function parseProgress(line: string): number | null {
  if (!line.startsWith(PROGRESS_TAG)) return null;
  const [done, total, estimate] = line.slice(PROGRESS_TAG.length).trim().split(/\s+/).map(Number);
  const size = total > 0 ? total : estimate;
  if (!(size > 0) || !(done >= 0)) return null;
  return Math.min(1, done / size);
}

/**
 * Audition-only preview, inlined into the trim dialog as base64 — so it's kept small (mono,
 * 32 kHz, 64 kbps ≈ 29 MB/hour). The final WAV is cut from the original download, not this.
 * `-vn` drops any video stream (the `best` fallback format can carry one).
 */
export function buildPreviewArgs(srcPath: string, outPath: string): string[] {
  return ["-y", "-i", srcPath, "-vn", "-ac", "1", "-ar", "32000", "-c:a", "libmp3lame", "-b:a", "64k", outPath];
}

/** Decode to mono 32-bit-float PCM at 11025 Hz — the input for peaks and BPM/key analysis. */
export function buildPcmArgs(srcPath: string, outPath: string): string[] {
  return ["-y", "-i", srcPath, "-ac", "1", "-ar", "11025", "-f", "f32le", outPath];
}

export const PCM_SAMPLE_RATE = 11025;
/** Upper bound on waveform peaks (1 byte each) sent to the trim dialog. */
const MAX_PEAKS = 1_000_000;
/** Seconds of audio kept for BPM/key detection. */
export const ANALYSIS_SEC = 90;

export function buildTrimArgs(
  srcPath: string,
  outPath: string,
  startSec: number,
  endSec: number,
  sampleRate: number,
): string[] {
  const args = ["-y", "-i", srcPath, "-ss", String(startSec)];
  if (endSec > startSec) args.push("-t", String(endSec - startSec));
  args.push("-ar", String(sampleRate), "-c:a", "pcm_s16le", outPath);
  return args;
}

// ---- thin subprocess wrappers (manually verified) ----

export async function fetchInfo(url: string): Promise<VideoInfo> {
  const { stdout } = await run(resolveBin("yt-dlp"), buildInfoArgs(url), runOpts());
  const j = JSON.parse(stdout) as Record<string, unknown>;
  return {
    title: (j.title as string) ?? "untitled",
    channel: (j.channel as string) ?? (j.uploader as string) ?? "",
    duration: Number(j.duration ?? 0),
    platform: prettyPlatform((j.extractor_key as string) ?? (j.extractor as string) ?? ""),
  };
}

/**
 * Downloads best-audio and returns the absolute path yt-dlp actually wrote. `onProgress` gets
 * the download fraction (0–1) as yt-dlp reports it. Aborting `signal` kills yt-dlp and rejects
 * with an `AbortError` once the process has exited (so its files are closed before cleanup).
 */
export function downloadAudio(
  url: string,
  outTemplate: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBin("yt-dlp"), buildDownloadArgs(url, outTemplate), {
      env: runOpts().env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let pending = ""; // partial line carried over between chunks
    let path = "";
    let stderr = "";
    const handleLine = (raw: string) => {
      const line = raw.trim();
      const fraction = parseProgress(line);
      if (fraction !== null) onProgress?.(fraction);
      else if (line) path = line; // the after_move:filepath line is printed last
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (e) => {
      if (!signal?.aborted) reject(e); // e.g. spawn ENOENT; aborts settle in "close"
    });
    child.on("close", (code) => {
      if (signal?.aborted) return reject(Object.assign(new Error("download cancelled"), { name: "AbortError" }));
      handleLine(pending);
      if (code !== 0) return reject(Object.assign(new Error(`yt-dlp failed (exit ${code})`), { stderr }));
      if (!path) return reject(new Error("yt-dlp produced no output path"));
      resolve(path);
    });
  });
}

export async function makePreview(srcPath: string, outPath: string): Promise<string> {
  await run(resolveBin("ffmpeg"), buildPreviewArgs(srcPath, outPath), runOpts());
  return outPath;
}

export interface AudioAnalysis {
  peaks: Uint8Array; // waveform: one byte (max |amplitude|) per 1/peakRate seconds
  peakRate: number; // peaks per second
  seconds: number; // decoded length
  window: Float32Array; // up to ANALYSIS_SEC of PCM from windowStartSec, for BPM/key
  windowStartSec: number;
}

/**
 * Decode `srcPath` once, streamed from ffmpeg's stdout, into waveform peaks + one analysis
 * window. The whole track is never in memory: usage is ≤ ~1 MB of peaks + the ~4 MB window,
 * whatever the track length.
 */
export function analyzeAudio(srcPath: string, durationHint: number, windowStartSec: number): Promise<AudioAnalysis> {
  const rate = PCM_SAMPLE_RATE;
  const expected = Math.max(0, durationHint) * rate;
  const samplesPerPeak = Math.max(5, Math.ceil(expected / MAX_PEAKS));
  const winStart = Math.max(0, Math.floor(windowStartSec * rate));
  const sink = createPcmSink(samplesPerPeak, expected, winStart, ANALYSIS_SEC * rate);

  return new Promise((resolve, reject) => {
    const child = spawn(resolveBin("ffmpeg"), buildPcmArgs(srcPath, "pipe:1"), {
      env: runOpts().env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let carry = Buffer.alloc(0); // 0–3 bytes of a sample split across chunks
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 4);
      // Copy into a fresh, aligned buffer (stream chunks can start at any byte offset).
      // f32le matches the host's native little-endian byte order.
      const samples = new Float32Array(whole / 4);
      new Uint8Array(samples.buffer).set(buf.subarray(0, whole));
      sink.push(samples);
      carry = Buffer.from(buf.subarray(whole));
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", reject); // e.g. spawn ENOENT when ffmpeg isn't installed
    child.on("close", (code) => {
      if (code !== 0) return reject(Object.assign(new Error(`ffmpeg decode failed (exit ${code})`), { stderr }));
      const { peaks, window, totalSamples } = sink.finish();
      resolve({
        peaks,
        peakRate: rate / samplesPerPeak,
        seconds: totalSamples / rate,
        window,
        windowStartSec: winStart / rate,
      });
    });
  });
}

export async function trimToWav(
  srcPath: string,
  outPath: string,
  startSec: number,
  endSec: number,
  sampleRate: number,
): Promise<string> {
  await run(resolveBin("ffmpeg"), buildTrimArgs(srcPath, outPath, startSec, endSec, sampleRate), runOpts());
  return outPath;
}

/** Read an mp3 file as a base64 `data:` URI for inlining in the trim dialog. */
export async function fileToDataUri(path: string, mime = "audio/mpeg"): Promise<string> {
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
