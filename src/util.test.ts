import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaUrl, prettyPlatform, resolveTrackHandle, selectionStartBeats, detectBpm, chromaToKey, detectKey, secondsToClock, sanitizeFilename, escapeHtml, htmlDataUrl, createPcmSink, normalizeSkin } from "./util.ts";

const rotate = (profile: number[], tonic: number) => profile.map((_, p) => profile[(p - tonic + 12) % 12]);

/** Sum of sines at the given MIDI notes, each with its own amplitude. */
function notes(sampleRate: number, durationSec: number, parts: [midi: number, amp: number][]) {
  const n = Math.floor(sampleRate * durationSec);
  const a = new Float32Array(n);
  for (const [midi, amp] of parts) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < n; i++) a[i] += (amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)) / parts.length;
  }
  return a;
}

test("chromaToKey: tonic/fifth-weighted C major scale resolves to C maj", () => {
  assert.equal(chromaToKey([4, 0, 2, 0, 3, 2, 0, 3, 0, 2, 0, 2]), "C maj");
});

test("chromaToKey: the same shape rotated to A resolves to A maj", () => {
  assert.equal(chromaToKey(rotate([4, 0, 2, 0, 3, 2, 0, 3, 0, 2, 0, 2], 9)), "A maj");
});

test("chromaToKey: natural-minor shape on D resolves to D min", () => {
  assert.equal(chromaToKey(rotate([4, 0, 2, 3, 0, 2, 0, 3, 2, 0, 2, 1], 2)), "D min");
});

test("detectKey: a C major scale with a loud C–E–G triad is C maj", () => {
  // C4 E4 G4 loud; D4 F4 A4 B4 quieter.
  const audio = notes(11025, 3, [[60, 1], [64, 1], [67, 1], [62, 0.5], [65, 0.5], [69, 0.5], [71, 0.5]]);
  assert.equal(detectKey(audio, 11025), "C maj");
});

test("detectKey: too-short or empty input returns empty string", () => {
  assert.equal(detectKey(new Float32Array(0), 11025), "");
  assert.equal(detectKey(new Float32Array(1000), 11025), "");
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
test("htmlDataUrl: encodes text, inserts raw base64 verbatim, never re-scans values", () => {
  const url = htmlDataUrl("<p>__T__</p><i>__B__</i>__Z__ #", { T: "a b% __B__" }, { B: "ab+/=" });
  assert.equal(url, "data:text/html,%3Cp%3Ea%20b%25%20__B__%3C%2Fp%3E%3Ci%3Eab+/=%3C%2Fi%3E__Z__%20%23");
  assert.equal(decodeURIComponent(url.slice("data:text/html,".length)), "<p>a b% __B__</p><i>ab+/=</i>__Z__ #");
});

test("createPcmSink: peaks + window survive arbitrary chunk splits; peak buffer grows", () => {
  const samples = Float32Array.from([0.1, -0.5, 0.2, 1, 0, -0.25, 0.3, 0.8, -0.1, 0.4]);
  const sink = createPcmSink(3, 1, 2, 4); // expectedSamples=1 forces growth
  sink.push(samples.subarray(0, 2));
  sink.push(samples.subarray(2, 7));
  sink.push(samples.subarray(7));
  const { peaks, window, totalSamples } = sink.finish();
  assert.deepEqual([...peaks], [128, 255, 204, 102]); // max|x| per 3 samples ×255; last is partial
  assert.deepEqual([...window], [0.2, 1, 0, -0.25].map(Math.fround));
  assert.equal(totalSamples, 10);
});

test("createPcmSink: window past the end is truncated", () => {
  const sink = createPcmSink(5, 10, 8, 5);
  sink.push(new Float32Array(10).fill(0.5));
  assert.equal(sink.finish().window.length, 2);
});

test("normalizeSkin: known skins pass, anything else falls back to luna", () => {
  assert.equal(normalizeSkin("dolphin"), "dolphin");
  assert.equal(normalizeSkin("plumbob"), "plumbob");
  assert.equal(normalizeSkin("luna"), "luna");
  assert.equal(normalizeSkin('"><script>'), "luna");
  assert.equal(normalizeSkin(undefined), "luna");
  assert.equal(normalizeSkin(42), "luna");
});
