import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInfoArgs, buildDownloadArgs, buildPreviewArgs, buildTrimArgs, buildPcmArgs, parseProgress } from "./media.ts";

test("buildInfoArgs: prints only the needed fields, no playlist", () => {
  assert.deepEqual(buildInfoArgs("URL"), [
    "--no-playlist", "-O", "%(.{title,channel,uploader,duration,extractor_key,extractor})j", "URL",
  ]);
});

test("buildPcmArgs: mono f32le at 11025 Hz", () => {
  assert.deepEqual(buildPcmArgs("/tmp/a.mp3", "/tmp/a.pcm"), [
    "-y", "-i", "/tmp/a.mp3", "-ac", "1", "-ar", "11025", "-f", "f32le", "/tmp/a.pcm",
  ]);
});

test("buildDownloadArgs: bestaudio, prints the final path and parseable progress", () => {
  assert.deepEqual(buildDownloadArgs("URL", "/tmp/src.%(ext)s"), [
    "-f", "bestaudio/best", "--no-playlist", "--no-simulate", "--print", "after_move:filepath",
    "--progress", "--newline", "--progress-template",
    "download:[yoink-progress] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
    "-o", "/tmp/src.%(ext)s", "URL",
  ]);
});

test("parseProgress: exact total, estimate fallback, unknown size, other lines", () => {
  assert.equal(parseProgress("[yoink-progress] 512 1024 NA"), 0.5);
  assert.equal(parseProgress("[yoink-progress] 300 NA 1200"), 0.25);
  assert.equal(parseProgress("[yoink-progress] 2048 1024 NA"), 1); // clamped
  assert.equal(parseProgress("[yoink-progress] 10 NA NA"), null);
  assert.equal(parseProgress("/tmp/yoink-abc/src.webm"), null);
});

test("buildPreviewArgs: audio-only mono mp3, 32 kHz 64k", () => {
  assert.deepEqual(buildPreviewArgs("/tmp/a.webm", "/tmp/p.mp3"), [
    "-y", "-i", "/tmp/a.webm", "-vn", "-ac", "1", "-ar", "32000", "-c:a", "libmp3lame", "-b:a", "64k", "/tmp/p.mp3",
  ]);
});

test("buildTrimArgs: accurate seek + duration + sample rate + pcm", () => {
  assert.deepEqual(buildTrimArgs("/tmp/a.webm", "/tmp/o.wav", 92, 125, 48000), [
    "-y", "-i", "/tmp/a.webm", "-ss", "92", "-t", "33", "-ar", "48000", "-c:a", "pcm_s16le", "/tmp/o.wav",
  ]);
});

test("buildTrimArgs: zero-length region clamps to whole remainder (no -t)", () => {
  assert.deepEqual(buildTrimArgs("/tmp/a.webm", "/tmp/o.wav", 0, 0, 44100), [
    "-y", "-i", "/tmp/a.webm", "-ss", "0", "-ar", "44100", "-c:a", "pcm_s16le", "/tmp/o.wav",
  ]);
});
