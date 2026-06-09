import { initialize, AudioTrack, type ActivationContext, type Handle, type ExtensionContext } from "@ableton-extensions/sdk";
import { join } from "node:path";

import pasteHtml from "../ui/paste.html";
import trimHtml from "../ui/trim.html";

import { parseMediaUrl, resolveTrackHandle, sanitizeFilename, escapeHtml, fillTemplate, secondsToClock } from "./util.ts";
import * as media from "./media.ts";

type Ctx = ExtensionContext<"1.0.0">;

interface TrimResult {
  start: number;
  end: number;
  name: string;
  target: "selected" | "new";
  sampleRate: number;
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
  if (/ENOENT|not found|spawn/.test(msg)) return "can't find yt-dlp / ffmpeg 🔧";
  if (/yt-dlp/i.test(msg)) return "couldn't reach that one 😿 (is it private / unavailable?)";
  if (/ffmpeg/i.test(msg)) return "something glitched converting 💔";
  return "hmm, that didn't work 😿 — try another link";
}

async function showPaste(ctx: Ctx, prefillUrl: string, errorMsg: string): Promise<string> {
  const html = fillTemplate(pasteHtml, { URL: escapeHtml(prefillUrl), ERROR: escapeHtml(errorMsg) });
  const url = "data:text/html," + encodeURIComponent(html);
  return ctx.ui.showModalDialog(url, 380, 230);
}

async function showTrim(
  ctx: Ctx,
  info: media.VideoInfo,
  audioDataUri: string,
  startSeconds: number,
): Promise<TrimResult | null> {
  const html = fillTemplate(trimHtml, {
    TITLE: escapeHtml(info.title),
    CHANNEL: escapeHtml(info.channel),
    PLATFORM: escapeHtml(info.platform),
    DURATION: String(info.duration),
    START_SEC: String(startSeconds),
    NAME: escapeHtml(sanitizeFilename(info.title)),
    AUDIO_SRC: audioDataUri,
  });
  // Use a data: URL — the same transport as the paste window, whose close_and_send works.
  const url = "data:text/html," + encodeURIComponent(html);
  const raw = await ctx.ui.showModalDialog(url, 410, 580);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrimResult;
  } catch (e) {
    console.error("[yoink] could not parse trim result:", errDetail(e));
    return null;
  }
}

async function importClip(ctx: Ctx, handle: Handle, fullPath: string, tempDir: string, r: TrimResult): Promise<void> {
  const wavPath = join(tempDir, `${sanitizeFilename(r.name)}.wav`);
  await media.trimToWav(fullPath, wavPath, r.start, r.end, r.sampleRate);
  const imported = await ctx.resources.importIntoProject(wavPath);
  // Live now has its own copy in the project — our temp WAV is no longer needed.
  await media.removeFiles([wavPath]);
  const track =
    r.target === "new"
      ? await ctx.application.song.createAudioTrack()
      : ctx.getObjectFromHandle(handle, AudioTrack);
  // Drop into the Arrangement timeline at bar 1.
  const clip = await track.createAudioClip({ filePath: imported, startTime: 0, isWarped: false });
  clip.name = r.name;
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
    runYoink(context, handle).catch((e) => console.log("[yoink] runYoink crashed:", e));
  });

  // Register under both scopes so Yoink appears whether the user right-clicks the audio
  // track itself or a selection in its arrangement timeline.
  void context.ui.registerContextMenuAction("AudioTrack", "Open Yoink ♡", "yt-ableton.openYoink");
  void context.ui.registerContextMenuAction("AudioTrack.ArrangementSelection", "Open Yoink ♡", "yt-ableton.openYoink");
}

async function runYoink(context: Ctx, handle: Handle): Promise<void> {
  const tempDir = context.environment.tempDirectory ?? "/tmp";
  // The URL field starts empty by design — the user explicitly pastes their link.
  // We deliberately don't read the system clipboard automatically: silently
  // ingesting clipboard contents is a privacy/security footgun.
  let prefill = "";

  let errorMsg = "";
  // Retry loop: paste → download → trim → import. Errors loop back to the paste window.
  for (;;) {
    const url = await showPaste(context, prefill, errorMsg);
    if (!url) return; // cancelled
    const parsed = parseMediaUrl(url);
    if (!parsed) {
      prefill = url;
      errorMsg = "that doesn't look like a link 🤔";
      continue;
    }

    // yt-dlp auto-detects the platform from the URL — pass it through unchanged.
    try {
      const result = (await context.ui.withinProgressDialog(
        "looking it up…",
        { progress: 0 },
        async (update) => {
          const info = await media.fetchInfo(parsed.url);
          await update(`grabbing audio… (${secondsToClock(info.duration)})`, 40);
          const fullPath = await media.downloadAudio(parsed.url, join(tempDir, "yoink-%(id)s.%(ext)s"));
          await update("almost there…", 80);
          const previewPath = join(tempDir, "yoink-preview.mp3");
          await media.makePreview(fullPath, previewPath);
          const audioDataUri = await media.fileToDataUri(previewPath);
          return { info, fullPath, previewPath, audioDataUri };
        },
      )) as { info: media.VideoInfo; fullPath: string; previewPath: string; audioDataUri: string };

      const trim = await showTrim(context, result.info, result.audioDataUri, parsed.startSeconds ?? 0);
      if (!trim) {
        // Cancelled — still tidy up the temp download + preview.
        await media.removeFiles([result.fullPath, result.previewPath]);
        return;
      }

      await importClip(context, handle, result.fullPath, tempDir, trim);
      // Drop succeeded; the sample lives in the project now. Remove the full download + preview.
      await media.removeFiles([result.fullPath, result.previewPath]);
      return; // done ♡
    } catch (e) {
      console.error("[yoink] pipeline failed:", errDetail(e));
      prefill = url;
      errorMsg = friendlyError(e);
      continue;
    }
  }
}
