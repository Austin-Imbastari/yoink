import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

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
  thumbnailUrl: string;
}

// ---- pure arg builders (unit-tested) ----

export function buildInfoArgs(url: string): string[] {
  return ["--dump-single-json", "--no-playlist", url];
}

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
    "-o",
    outTemplate,
    url,
  ];
}

/** Best-effort delete; never throws (used to tidy temp downloads after import). */
export async function removeFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})));
}

export function buildPreviewArgs(srcPath: string, outPath: string): string[] {
  return ["-y", "-i", srcPath, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", outPath];
}

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
    thumbnailUrl: (j.thumbnail as string) ?? "",
  };
}

/** Downloads best-audio and returns the absolute path yt-dlp actually wrote. */
export async function downloadAudio(url: string, outTemplate: string): Promise<string> {
  const { stdout } = await run(resolveBin("yt-dlp"), buildDownloadArgs(url, outTemplate), runOpts());
  const path = stdout.trim().split("\n").pop()?.trim();
  if (!path) throw new Error("yt-dlp produced no output path");
  return path;
}

export async function makePreview(srcPath: string, outPath: string): Promise<string> {
  await run(resolveBin("ffmpeg"), buildPreviewArgs(srcPath, outPath), runOpts());
  return outPath;
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
