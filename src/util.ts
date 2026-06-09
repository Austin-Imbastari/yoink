export interface ParsedMediaUrl {
  url: string;
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
 * Validate that `raw` is an http(s) URL and extract an optional start time. Returns the
 * trimmed URL unchanged so it can be handed straight to yt-dlp, which auto-detects the
 * platform — there is no host allowlist. Returns null if `raw` is not an http(s) URL.
 *
 * Parsed by hand rather than via `new URL(...)`: Ableton's embedded Extension Host runtime
 * does not reliably expose the `URL` global, so relying on it made every link fail.
 */
export function parseMediaUrl(raw: string): ParsedMediaUrl | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;
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

  const startSeconds = parseTimeParam(params.get("t") ?? params.get("start") ?? null);
  return { url: trimmed, startSeconds };
}

const PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  tiktok: "TikTok",
  instagram: "Instagram",
  vimeo: "Vimeo",
  bandcamp: "Bandcamp",
  twitter: "Twitter/X",
};

/**
 * Turn a yt-dlp extractor name (e.g. "Youtube", "soundcloud", "youtube:tab") into a tidy
 * display label. Falls back to the raw name for sites we don't have a nice label for, and
 * returns "" for an empty input.
 */
export function prettyPlatform(extractor: string): string {
  const trimmed = extractor.trim();
  if (!trimmed) return "";
  const key = trimmed.toLowerCase().split(/[:_]/)[0];
  return PLATFORM_LABELS[key] ?? trimmed;
}

/**
 * Normalize a context-menu command argument to a target track handle. The `"AudioTrack"`
 * scope passes a bare `Handle` ({ id }); the `"AudioTrack.ArrangementSelection"` scope passes
 * a selection whose `selected_lanes[0]` is the track. Returns null when no track can be
 * derived (e.g. an empty selection). Kept SDK-type-agnostic (generic `H`) so it stays pure
 * and unit-testable without importing the SDK.
 */
export function resolveTrackHandle<H>(arg: unknown): H | null {
  if (arg && typeof arg === "object") {
    const lanes = (arg as { selected_lanes?: unknown }).selected_lanes;
    if (Array.isArray(lanes)) return lanes.length > 0 ? (lanes[0] as H) : null;
  }
  return (arg ?? null) as H | null;
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
