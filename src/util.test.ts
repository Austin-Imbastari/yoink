import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaUrl, prettyPlatform, secondsToClock, clockToSeconds, sanitizeFilename, escapeHtml, fillTemplate } from "./util.ts";

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
