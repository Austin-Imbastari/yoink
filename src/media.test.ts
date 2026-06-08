import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInfoArgs, buildDownloadArgs, buildPreviewArgs, buildTrimArgs } from "./media.ts";

test("buildInfoArgs: single-json, no playlist", () => {
  assert.deepEqual(buildInfoArgs("URL"), ["--dump-single-json", "--no-playlist", "URL"]);
});

test("buildDownloadArgs: bestaudio, prints the final written path", () => {
  assert.deepEqual(buildDownloadArgs("URL", "/tmp/src.%(ext)s"), [
    "-f", "bestaudio/best", "--no-playlist", "--no-simulate", "--print", "after_move:filepath",
    "-o", "/tmp/src.%(ext)s", "URL",
  ]);
});

test("buildPreviewArgs: mono mp3 96k", () => {
  assert.deepEqual(buildPreviewArgs("/tmp/a.webm", "/tmp/p.mp3"), [
    "-y", "-i", "/tmp/a.webm", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", "/tmp/p.mp3",
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
