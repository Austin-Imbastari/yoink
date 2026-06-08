import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeUrl, secondsToClock, clockToSeconds, sanitizeFilename, escapeHtml, fillTemplate } from "./util.ts";

test("parseYouTubeUrl: standard watch url", () => {
  assert.deepEqual(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
    videoId: "dQw4w9WgXcQ",
    startSeconds: null,
  });
});

test("parseYouTubeUrl: youtu.be short url with numeric t", () => {
  assert.deepEqual(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=92"), {
    videoId: "dQw4w9WgXcQ",
    startSeconds: 92,
  });
});

test("parseYouTubeUrl: t with 1m30s format", () => {
  assert.deepEqual(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"), {
    videoId: "dQw4w9WgXcQ",
    startSeconds: 90,
  });
});

test("parseYouTubeUrl: t with trailing s", () => {
  assert.equal(parseYouTubeUrl("https://youtu.be/abcdefghijk?t=45s")?.startSeconds, 45);
});

test("parseYouTubeUrl: watch url with radio-mix &list= keeps the v= id", () => {
  assert.equal(
    parseYouTubeUrl("https://www.youtube.com/watch?v=5Sp1Xkay52E&list=RD5Sp1Xkay52E")?.videoId,
    "5Sp1Xkay52E",
  );
});

test("parseYouTubeUrl: non-youtube url returns null", () => {
  assert.equal(parseYouTubeUrl("https://example.com/watch?v=x"), null);
});

test("parseYouTubeUrl: garbage returns null", () => {
  assert.equal(parseYouTubeUrl("not a url"), null);
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
