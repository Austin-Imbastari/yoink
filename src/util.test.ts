import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaUrl, prettyPlatform, resolveTrackHandle, secondsToBeats, selectionStartBeats, detectBpm, goertzelMagnitude, chromaToKey, detectKey, secondsToClock, clockToSeconds, sanitizeFilename, escapeHtml, fillTemplate } from "./util.ts";

// Krumhansl–Schmuckler major/minor profiles (tonic = C), used to build fixtures.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const rotateProfile = (profile: number[], tonic: number) => profile.map((_, p) => profile[(p - tonic + 12) % 12]);

function sine(sampleRate: number, durationSec: number, freq: number) {
  const n = Math.floor(sampleRate * durationSec);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return a;
}

test("goertzelMagnitude: peaks at the signal's frequency", () => {
  const sr = 11025;
  const s = sine(sr, 1, 440);
  const atTone = goertzelMagnitude(s, 440, sr);
  const offTone = goertzelMagnitude(s, 466.16, sr); // A#4, a semitone up
  assert.ok(atTone > offTone * 5, `440Hz (${atTone}) should dominate 466Hz (${offTone})`);
});

test("chromaToKey: Krumhansl major profile resolves to C maj", () => {
  assert.equal(chromaToKey(KS_MAJOR), "C maj");
});

test("chromaToKey: Krumhansl minor profile resolves to C min", () => {
  assert.equal(chromaToKey(KS_MINOR), "C min");
});

test("chromaToKey: a profile rotated to A resolves to A maj", () => {
  assert.equal(chromaToKey(rotateProfile(KS_MAJOR, 9)), "A maj");
});

test("detectKey: returns a well-formed key label", () => {
  const key = detectKey(sine(11025, 2, 440), 11025);
  assert.match(key, /^[A-G]#? (maj|min)$/);
});

test("detectKey: empty input returns empty string", () => {
  assert.equal(detectKey(new Float32Array(0), 11025), "");
});

/** A synthetic click track: a short decaying impulse on every beat at the given tempo. */
function clickTrack(sampleRate: number, durationSec: number, bpm: number): Float32Array {
  const n = Math.floor(sampleRate * durationSec);
  const a = new Float32Array(n);
  const period = (sampleRate * 60) / bpm; // samples per beat
  for (let t = 0; t < n; t += period) {
    const i = Math.round(t);
    for (let k = 0; k < 24 && i + k < n; k++) a[i + k] = Math.exp(-k / 5);
  }
  return a;
}

test("detectBpm: finds 120 BPM on a click track, grid aligned to the beats", () => {
  const sr = 11025;
  const { bpm, phase } = detectBpm(clickTrack(sr, 10, 120), sr);
  assert.ok(Math.abs(bpm - 120) <= 3, `expected ~120, got ${bpm}`);
  // Phase is only meaningful modulo the beat period (0.5s @120). Check the detected grid
  // lands within ~1 frame-or-two of a true beat; exact phase is approximate by design.
  const period = 0.5;
  const err = Math.min(phase % period, period - (phase % period));
  assert.ok(err < 0.12, `grid misaligned by ${err}s`);
});

test("detectBpm: finds 90 BPM on a click track", () => {
  const sr = 11025;
  const { bpm } = detectBpm(clickTrack(sr, 10, 90), sr);
  assert.ok(Math.abs(bpm - 90) <= 3, `expected ~90, got ${bpm}`);
});

test("detectBpm: empty/too-short input returns 0 bpm", () => {
  assert.equal(detectBpm(new Float32Array(0), 11025).bpm, 0);
});

test("secondsToBeats: converts using tempo (120bpm => 2 beats/sec)", () => {
  assert.equal(secondsToBeats(1, 120), 2);
  assert.equal(secondsToBeats(4, 120), 8);
  assert.equal(secondsToBeats(2, 90), 3);
});

test("secondsToBeats: negative or NaN inputs clamp to 0", () => {
  assert.equal(secondsToBeats(-5, 120), 0);
  assert.equal(secondsToBeats(NaN, 120), 0);
  assert.equal(secondsToBeats(2, NaN), 0);
});

test("selectionStartBeats: reads time_selection_start from a selection", () => {
  assert.equal(selectionStartBeats({ time_selection_start: 12.5, time_selection_end: 16, selected_lanes: [] }), 12.5);
});

test("selectionStartBeats: bare handle / null / missing => 0", () => {
  assert.equal(selectionStartBeats({ id: 5n }), 0);
  assert.equal(selectionStartBeats(null), 0);
  assert.equal(selectionStartBeats(undefined), 0);
});

test("resolveTrackHandle: bare AudioTrack handle is returned as-is", () => {
  const handle = { id: 5n };
  assert.equal(resolveTrackHandle(handle), handle);
});

test("resolveTrackHandle: ArrangementSelection returns its first selected lane", () => {
  const lane = { id: 1n };
  const selection = { time_selection_start: 0, time_selection_end: 4, selected_lanes: [lane, { id: 2n }] };
  assert.equal(resolveTrackHandle(selection), lane);
});

test("resolveTrackHandle: ArrangementSelection with no lanes returns null", () => {
  const selection = { time_selection_start: 0, time_selection_end: 4, selected_lanes: [] };
  assert.equal(resolveTrackHandle(selection), null);
});

test("resolveTrackHandle: null / undefined return null", () => {
  assert.equal(resolveTrackHandle(null), null);
  assert.equal(resolveTrackHandle(undefined), null);
});

test("prettyPlatform: maps known extractor keys to tidy labels", () => {
  assert.equal(prettyPlatform("Youtube"), "YouTube");
  assert.equal(prettyPlatform("soundcloud"), "SoundCloud");
  assert.equal(prettyPlatform("TikTok"), "TikTok");
  assert.equal(prettyPlatform("Instagram"), "Instagram");
});

test("prettyPlatform: strips sub-extractor suffix (youtube:tab)", () => {
  assert.equal(prettyPlatform("youtube:tab"), "YouTube");
});

test("prettyPlatform: unknown key falls back to the raw name", () => {
  assert.equal(prettyPlatform("SomeNewSite"), "SomeNewSite");
});

test("prettyPlatform: empty stays empty", () => {
  assert.equal(prettyPlatform(""), "");
});

test("parseMediaUrl: standard youtube watch url is returned verbatim", () => {
  assert.deepEqual(parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    startSeconds: null,
  });
});

test("parseMediaUrl: youtu.be short url with numeric t", () => {
  assert.deepEqual(parseMediaUrl("https://youtu.be/dQw4w9WgXcQ?t=92"), {
    url: "https://youtu.be/dQw4w9WgXcQ?t=92",
    startSeconds: 92,
  });
});

test("parseMediaUrl: t with 1m30s format", () => {
  assert.equal(parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")?.startSeconds, 90);
});

test("parseMediaUrl: t with trailing s", () => {
  assert.equal(parseMediaUrl("https://youtu.be/abcdefghijk?t=45s")?.startSeconds, 45);
});

test("parseMediaUrl: tiktok url accepted, no timestamp", () => {
  assert.deepEqual(parseMediaUrl("https://www.tiktok.com/@user/video/7234567890123456789"), {
    url: "https://www.tiktok.com/@user/video/7234567890123456789",
    startSeconds: null,
  });
});

test("parseMediaUrl: instagram reel accepted", () => {
  assert.equal(
    parseMediaUrl("https://www.instagram.com/reel/CabcdEfghIj/")?.url,
    "https://www.instagram.com/reel/CabcdEfghIj/",
  );
});

test("parseMediaUrl: soundcloud track accepted", () => {
  assert.deepEqual(parseMediaUrl("https://soundcloud.com/artist/some-track"), {
    url: "https://soundcloud.com/artist/some-track",
    startSeconds: null,
  });
});

test("parseMediaUrl: trims surrounding whitespace", () => {
  assert.equal(parseMediaUrl("  https://soundcloud.com/a/b  ")?.url, "https://soundcloud.com/a/b");
});

test("parseMediaUrl: plain text returns null", () => {
  assert.equal(parseMediaUrl("not a url"), null);
});

test("parseMediaUrl: empty string returns null", () => {
  assert.equal(parseMediaUrl(""), null);
});

test("parseMediaUrl: non-http scheme returns null", () => {
  assert.equal(parseMediaUrl("ftp://example.com/x"), null);
});

test("parseMediaUrl: bare domain without scheme returns null", () => {
  assert.equal(parseMediaUrl("soundcloud.com/artist/track"), null);
});

test("secondsToClock: under a minute pads seconds", () => {
  assert.equal(secondsToClock(3), "0:03");
});
test("secondsToClock: minutes and seconds", () => {
  assert.equal(secondsToClock(92), "1:32");
});
test("secondsToClock: over an hour", () => {
  assert.equal(secondsToClock(3723), "1:02:03");
});
test("clockToSeconds: m:ss", () => {
  assert.equal(clockToSeconds("1:32"), 92);
});
test("clockToSeconds: h:mm:ss", () => {
  assert.equal(clockToSeconds("1:02:03"), 3723);
});
test("clockToSeconds: garbage returns null", () => {
  assert.equal(clockToSeconds("abc"), null);
  assert.equal(clockToSeconds(""), null);
});

test("sanitizeFilename: spaces and punctuation to hyphens", () => {
  assert.equal(sanitizeFilename("Rick Astley - Never Gonna!"), "rick-astley-never-gonna");
});
test("sanitizeFilename: strips symbols, collapses hyphens", () => {
  assert.equal(sanitizeFilename("Lo-Fi @ 2am ♥"), "lo-fi-2am");
});
test("sanitizeFilename: empty falls back to 'sample'", () => {
  assert.equal(sanitizeFilename("   "), "sample");
  assert.equal(sanitizeFilename("♥♥♥"), "sample");
});
test("sanitizeFilename: caps length at 60", () => {
  assert.ok(sanitizeFilename("a".repeat(200)).length <= 60);
});

test("escapeHtml: escapes the five special chars", () => {
  assert.equal(escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
});
test("fillTemplate: replaces every occurrence of a token", () => {
  assert.equal(fillTemplate("__A__ and __A__ and __B__", { A: "x", B: "y" }), "x and x and y");
});
test("fillTemplate: leaves unknown tokens untouched", () => {
  assert.equal(fillTemplate("__A__ __Z__", { A: "x" }), "x __Z__");
});
