export interface ParsedYouTubeUrl {
  videoId: string;
  startSeconds: number | null;
}

/** Parse a `t`/`start` value: "92", "92s", "1m30s", "1h2m3s" → seconds. */
function parseTimeParam(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Validate a YouTube URL and extract its video id + optional start time. Returns null if not YouTube.
 *
 * Parsed by hand rather than via `new URL(...)`: Ableton's embedded Extension Host runtime does
 * not reliably expose the `URL` global, so relying on it made every link fail with a catch→null.
 */
export function parseYouTubeUrl(raw: string): ParsedYouTubeUrl | null {
  const m = raw.trim().match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/^www\./, "");
  const path = m[2] || "";
  const query = m[3] || "";

  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? "" : pair.slice(eq + 1);
    const decodedKey = safeDecode(key);
    if (!params.has(decodedKey)) params.set(decodedKey, safeDecode(val));
  }

  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = path.replace(/^\//, "").split("/")[0] || null;
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (path === "/watch") videoId = params.get("v") ?? null;
    else if (path.startsWith("/shorts/")) videoId = path.split("/")[2] ?? null;
  }
  if (!videoId || !/^[\w-]{6,}$/.test(videoId)) return null;
  const startSeconds = parseTimeParam(params.get("t") ?? params.get("start") ?? null);
  return { videoId, startSeconds };
}

/** Seconds → "m:ss" (or "h:mm:ss" past an hour). Negative/NaN clamp to 0. */
export function secondsToClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/** "m:ss" or "h:mm:ss" → seconds. Returns null on malformed input. */
export function clockToSeconds(clock: string): number | null {
  const parts = clock.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  return parts.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1];
}

/** Title → safe lowercase hyphenated filename stem (no extension). Falls back to "sample". */
export function sanitizeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "sample";
}

/** Escape a string for safe insertion into HTML text or a double/single-quoted attribute. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Replace every `__KEY__` token in `template` with `values[KEY]`. Unknown tokens are left as-is. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/__([A-Z0-9_]+)__/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
}
