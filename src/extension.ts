import {
  initialize,
  AudioTrack,
  type ActivationContext,
  type Handle,
  type ExtensionContext,
} from "@ableton-extensions/sdk";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import pasteHtml from "../ui/paste.html";
import trimHtml from "../ui/trim.html";

import {
  parseMediaUrl,
  resolveTrackHandle,
  selectionStartBeats,
  detectBpm,
  detectKey,
  sanitizeFilename,
  escapeHtml,
  htmlDataUrl,
  secondsToClock,
  normalizeSkin,
  type Skin,
} from "./util.ts";
import * as media from "./media.ts";

type Ctx = ExtensionContext<"1.0.0">;

// The preview is inlined into the trim dialog as base64, so its memory grows with track length.
// Capped here; raise it if longer sources (DJ mixes) matter more than memory.
const MAX_MINUTES = 60;

interface TrimResult {
  start: number;
  end: number;
  name: string;
  target: "selected" | "new";
  sampleRate: number;
  warp: boolean;
  loop: boolean;
  skin?: unknown; // skin picked in the trim window; normalized before use
}

/** Last meaningful line of a subprocess failure — stderr beats the generic "Command failed" message. */
function errDetail(e: unknown): string {
  const any = e as { stderr?: string; message?: string };
  const raw = (any?.stderr && String(any.stderr).trim()) || String(any?.message ?? e);
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.pop() ?? "").slice(0, 180);
}

function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/too long/.test(msg)) return `that one's over ${MAX_MINUTES} min 😿 — try a shorter link`;
  if (/ENOENT|not found|spawn/.test(msg)) return "can't find yt-dlp / ffmpeg 🔧 please install it!";
  if (/yt-dlp/i.test(msg)) return "couldn't reach that one 😿 (is it private / unavailable?)";
  if (/ffmpeg/i.test(msg)) return "something glitched converting 💔";
  return "hmm, that didn't work 😿 — try another link";
}

// ---- skin: picked from either window's Skin menu, remembered in the extension's storage dir ----
let currentSkin: Skin = "luna";

function settingsPath(ctx: Ctx): string | null {
  const dir = ctx.environment.storageDirectory;
  return dir ? join(dir, "settings.json") : null;
}

async function loadSkin(ctx: Ctx): Promise<void> {
  const path = settingsPath(ctx);
  if (!path) return;
  try {
    currentSkin = normalizeSkin(JSON.parse(await readFile(path, "utf8")).skin);
  } catch {
    // first run, or an unreadable file: keep the current skin
  }
}

/** Dialogs report their skin in the result; persist it when it changed. */
async function saveSkin(ctx: Ctx, picked: unknown): Promise<void> {
  const next = normalizeSkin(picked);
  if (next === currentSkin) return;
  currentSkin = next;
  const path = settingsPath(ctx);
  if (!path) return; // no storage dir: remembered for this session only
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ skin: next }));
  } catch (e) {
    console.log("[yoink] could not save skin:", errDetail(e));
  }
}

/** The pasted URL ("" when cancelled) and the skin the window ended on. */
async function showPaste(ctx: Ctx, prefillUrl: string, errorMsg: string): Promise<{ url: string; skin: unknown }> {
  const page = htmlDataUrl(pasteHtml, {
    URL: escapeHtml(prefillUrl),
    ERROR: escapeHtml(errorMsg),
    SKIN: currentSkin,
  });
  const raw = await ctx.ui.showModalDialog(page, 440, 285);
  try {
    const r = JSON.parse(raw) as { url?: unknown; skin?: unknown };
    return { url: typeof r.url === "string" ? r.url : "", skin: r.skin };
  } catch {
    return { url: "", skin: currentSkin }; // closed with the window's own ✕: a cancel
  }
}

/**
 * Build the trim dialog's data: URL. The preview and peaks go in as raw base64 (no
 * percent-encoding copy), and the preview's base64 string is garbage once this returns.
 */
async function trimPageUrl(
  info: media.VideoInfo,
  previewPath: string,
  analysis: media.AudioAnalysis,
  startSeconds: number,
  detected: { bpm: number; phase: number; key: string },
): Promise<string> {
  const p = analysis.peaks;
  return htmlDataUrl(
    trimHtml,
    {
      TITLE: escapeHtml(info.title),
      CHANNEL: escapeHtml(info.channel),
      PLATFORM: escapeHtml(info.platform),
      DURATION: String(analysis.seconds || info.duration),
      START_SEC: String(startSeconds),
      NAME: escapeHtml(sanitizeFilename(info.title)),
      PEAK_RATE: String(analysis.peakRate),
      BPM: String(detected.bpm),
      PHASE: String(detected.phase),
      KEY: escapeHtml(detected.key),
      SKIN: currentSkin,
    },
    {
      AUDIO_SRC: await media.fileToDataUri(previewPath),
      PEAKS: Buffer.from(p.buffer, p.byteOffset, p.length).toString("base64"),
    },
  );
}

async function showTrim(ctx: Ctx, pageUrl: string): Promise<TrimResult | null> {
  const raw = await ctx.ui.showModalDialog(pageUrl, 470, 590);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrimResult;
  } catch (e) {
    console.error("[yoink] could not parse trim result:", errDetail(e));
    return null;
  }
}

async function importClip(
  ctx: Ctx,
  handle: Handle,
  fullPath: string,
  workDir: string,
  r: TrimResult,
  dropBeats: number,
  key: string,
): Promise<void> {
  // Tag the clip name with the detected key (e.g. "vocal-loop-amin") when we have one.
  const clipName = key ? `${r.name}-${key}` : r.name;
  const wavPath = join(workDir, `${sanitizeFilename(clipName)}.wav`);
  await media.trimToWav(fullPath, wavPath, r.start, r.end, r.sampleRate);
  const imported = await ctx.resources.importIntoProject(wavPath);
  const track =
    r.target === "new" ? await ctx.application.song.createAudioTrack() : ctx.getObjectFromHandle(handle, AudioTrack);

  // Looping requires a warped clip (SDK constraint), so loop forces warp on.
  const clip = await track.createAudioClip({
    filePath: imported,
    startTime: dropBeats, // selection start in beats, or 0 (bar 1)
    isWarped: r.warp || r.loop,
  });
  clip.name = clipName;
  // Turn looping on after creation so Live sizes the loop from its own warp of the file.
  // Beat markers computed from the Set tempo looped short/long whenever the sample's
  // tempo differed from the Set's.
  if (r.loop) clip.looping = true;
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // An extension error must never take down the host process — log and stay alive.
  // Guarded in case the embedded runtime doesn't expose process.on.
  if (typeof process?.on === "function") {
    process.on("unhandledRejection", (reason) => console.log("[yoink] unhandledRejection:", reason));
    process.on("uncaughtException", (err) => console.log("[yoink] uncaughtException:", err));
  }

  context.commands.registerCommand("yt-ableton.openYoink", (...args: unknown[]) => {
    // The command is reachable from two scopes with different first args: the "AudioTrack"
    // scope passes the track Handle directly; the "AudioTrack.ArrangementSelection" scope
    // passes a selection whose first lane is the track. Normalize both to a track handle.
    const handle = resolveTrackHandle<Handle>(args[0]);
    if (!handle) {
      console.log("[yoink] openYoink: no target track in", args[0]);
      return;
    }
    // From a timeline selection, drop at its start; from the track menu, bar 1 (0).
    const dropBeats = selectionStartBeats(args[0]);
    runYoink(context, handle, dropBeats).catch((e) => console.log("[yoink] runYoink crashed:", e));
  });

  // Register under both scopes so Yoink appears whether the user right-clicks the audio
  // track itself or a selection in its arrangement timeline.
  void context.ui.registerContextMenuAction("AudioTrack", "Open Yoink ♡", "yt-ableton.openYoink");
  void context.ui.registerContextMenuAction("AudioTrack.ArrangementSelection", "Open Yoink ♡", "yt-ableton.openYoink");
}

async function runYoink(context: Ctx, handle: Handle, dropBeats: number): Promise<void> {
  const tempDir = context.environment.tempDirectory ?? "/tmp";
  // The URL field starts empty by design — the user explicitly pastes their link.
  // We deliberately don't read the system clipboard automatically: silently
  // ingesting clipboard contents is a privacy/security footgun.
  let prefill = "";

  let errorMsg = "";
  await loadSkin(context);
  // Retry loop: paste → download → trim → import. Errors loop back to the paste window.
  for (;;) {
    const pasted = await showPaste(context, prefill, errorMsg);
    await saveSkin(context, pasted.skin);
    const url = pasted.url;
    if (!url) return; // cancelled
    const parsed = parseMediaUrl(url);
    if (!parsed) {
      prefill = url;
      errorMsg = "that doesn't look like a link 🤔";
      continue;
    }

    // One private dir per attempt: concurrent Yoink windows can't clobber each other's files, and
    // `finally` removes everything (download, preview, WAV) on success, cancel, and error alike.
    const workDir = await mkdtemp(join(tempDir, "yoink-"));
    try {
      // yt-dlp auto-detects the platform from the URL — pass it through unchanged.
      const { fullPath, key, pageUrl } = (await context.ui.withinProgressDialog(
        "looking it up…",
        { progress: 0 },
        async (update, signal) => {
          const info = await media.fetchInfo(parsed.url);
          if (info.duration > MAX_MINUTES * 60) throw new Error("too long");
          const length = secondsToClock(info.duration);
          await update(`grabbing audio… 0% (${length})`, 10);
          // The download is the slow part: map its real 0–100% onto 10–75% of the bar, and only
          // message Live when the whole percent changes (yt-dlp can report many times a second).
          let shownPct = 0;
          const fullPath = await media.downloadAudio(
            parsed.url,
            join(workDir, "src.%(ext)s"),
            (fraction) => {
              const pct = Math.floor(fraction * 100);
              if (pct === shownPct) return;
              shownPct = pct;
              update(`grabbing audio… ${pct}% (${length})`, Math.round(10 + fraction * 65)).catch(() => {});
            },
            signal,
          );
          await update("finding the groove…", 75);

          // Analyze around the link's timestamp if it has one, else mid-track (intros are often beatless).
          const want = parsed.startSeconds ?? info.duration / 2 - media.ANALYSIS_SEC / 2;
          const winStart = Math.max(0, Math.min(want, info.duration - media.ANALYSIS_SEC));
          const previewPath = join(workDir, "preview.mp3");
          // Two independent ffmpeg jobs — run them side by side.
          const [, analysis] = await Promise.all([
            media.makePreview(fullPath, previewPath),
            media.analyzeAudio(fullPath, info.duration, winStart),
          ]);
          signal.throwIfAborted(); // cancelled during analysis: don't open the trim window
          // Best-effort tempo/key detection (bpm 0 / "" when it can't tell).
          const { bpm, phase } = detectBpm(analysis.window, media.PCM_SAMPLE_RATE);
          const key = detectKey(analysis.window, media.PCM_SAMPLE_RATE);
          // detectBpm's phase is relative to the window; shift it to the track start.
          const beatSec = bpm > 0 ? 60 / bpm : 0;
          const trackPhase = beatSec ? (analysis.windowStartSec + phase) % beatSec : 0;

          const pageUrl = await trimPageUrl(info, previewPath, analysis, parsed.startSeconds ?? 0, {
            bpm,
            phase: trackPhase,
            key,
          });
          return { fullPath, key, pageUrl };
        },
      )) as { fullPath: string; key: string; pageUrl: string };

      const trim = await showTrim(context, pageUrl);
      // Cancelled. Closing the window sends no result, so a skin picked there isn't kept.
      if (!trim) return;
      await saveSkin(context, trim.skin);

      await importClip(context, handle, fullPath, workDir, trim, dropBeats, key);
      return; // done ♡
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // cancelled from the progress dialog
      console.error("[yoink] pipeline failed:", errDetail(e));
      prefill = url;
      errorMsg = friendlyError(e);
    } finally {
      // Live has its own copy of the sample by now; nothing in here is needed anymore.
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
