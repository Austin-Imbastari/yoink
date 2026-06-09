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

/** Convert a real-time duration in seconds to musical beats at the given tempo (BPM). */
export function secondsToBeats(seconds: number, tempo: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(tempo) || seconds <= 0 || tempo <= 0) return 0;
  return (seconds * tempo) / 60;
}

/**
 * The arrangement drop position (in beats) from a context-menu command argument. The
 * `"AudioTrack.ArrangementSelection"` scope passes a selection with `time_selection_start`;
 * the `"AudioTrack"` scope passes a bare handle with none. Returns 0 (bar 1) when absent.
 */
export function selectionStartBeats(arg: unknown): number {
  if (arg && typeof arg === "object") {
    const start = (arg as { time_selection_start?: unknown }).time_selection_start;
    if (typeof start === "number" && Number.isFinite(start) && start > 0) return start;
  }
  return 0;
}

/**
 * Half-wave-rectified energy-novelty envelope: per `hop`-sample frame, how much louder it
 * got than the previous frame. Onsets (drum hits, note attacks) show up as positive spikes.
 */
export function onsetEnvelope(samples: Float32Array, hop = 512): Float32Array {
  const nFrames = Math.floor(samples.length / hop);
  if (nFrames < 2) return new Float32Array(0);
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let j = 0; j < hop; j++) {
      const s = samples[base + j];
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / hop);
  }
  const env = new Float32Array(nFrames);
  env[0] = rms[0]; // treat pre-signal as silence so an onset on frame 0 still registers
  for (let f = 1; f < nFrames; f++) env[f] = Math.max(0, rms[f] - rms[f - 1]);
  return env;
}

/**
 * Estimate tempo (BPM) and beat phase (seconds to the first beat) from raw mono PCM, by
 * autocorrelating the onset envelope. Best-effort: prone to half/double-time errors (folded
 * into a preferred 70–140 range) and an approximate phase — the trim window's tap-tempo
 * lets the user correct both. Returns `{ bpm: 0, phase: 0 }` when the input is too short.
 */
export function detectBpm(samples: Float32Array, sampleRate: number, hop = 512): { bpm: number; phase: number } {
  const env = onsetEnvelope(samples, hop);
  if (env.length < 8 || sampleRate <= 0) return { bpm: 0, phase: 0 };
  const envRate = sampleRate / hop;

  const minLag = Math.max(1, Math.round((60 * envRate) / 180));
  const maxLag = Math.min(env.length - 1, Math.round((60 * envRate) / 60));
  const ac = new Float32Array(maxLag + 2);
  let bestLag = minLag;
  let bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < env.length; i++) sum += env[i] * env[i - lag];
    const norm = sum / (env.length - lag); // remove the bias toward shorter lags
    ac[lag] = norm;
    if (norm > bestVal) {
      bestVal = norm;
      bestLag = lag;
    }
  }
  // Parabolic interpolation around the peak for sub-frame lag precision.
  let refined = bestLag;
  const lm = ac[bestLag - 1] ?? 0;
  const lp = ac[bestLag + 1] ?? 0;
  const denom = lm - 2 * ac[bestLag] + lp;
  if (denom !== 0) refined = bestLag + (0.5 * (lm - lp)) / denom;

  let bpm = (60 * envRate) / refined;
  while (bpm < 70) bpm *= 2;
  while (bpm > 140) bpm /= 2;

  // Phase: which beat offset best lines up with the onset peaks.
  const period = refined;
  let bestOff = 0;
  let bestOffVal = -1;
  for (let off = 0; off < period; off += 1) {
    let sum = 0;
    // Window ±1 frame so beat positions still catch a spike despite fractional-period rounding.
    for (let pos = off; pos < env.length; pos += period) {
      const c = Math.round(pos);
      sum += Math.max(env[c - 1] ?? 0, env[c] ?? 0, env[c + 1] ?? 0);
    }
    if (sum > bestOffVal) {
      bestOffVal = sum;
      bestOff = off;
    }
  }
  const phase = (bestOff * hop) / sampleRate;
  return { bpm: Math.round(bpm * 10) / 10, phase };
}

/**
 * Goertzel magnitude — the energy of `samples` at a single frequency, normalized by length.
 * Cheaper than a full FFT when you only need a handful of target frequencies (the semitones).
 */
export function goertzelMagnitude(samples: Float32Array, freq: number, sampleRate: number): number {
  if (samples.length === 0 || sampleRate <= 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / samples.length;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Sum Goertzel energy per semitone (MIDI 36–83) into 12 pitch-class bins. */
export function chromaVector(samples: Float32Array, sampleRate: number): number[] {
  const chroma = new Array(12).fill(0);
  if (samples.length === 0 || sampleRate <= 0) return chroma;
  // Key is stable; analyzing the first ~60s keeps Goertzel fast and numerically sane.
  const slice = samples.length > sampleRate * 60 ? samples.subarray(0, sampleRate * 60) : samples;
  for (let midi = 36; midi <= 83; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    if (freq >= sampleRate / 2) continue;
    chroma[midi % 12] += goertzelMagnitude(slice, freq, sampleRate);
  }
  return chroma;
}

/**
 * Best-matching key for a 12-bin chroma vector, via correlation against the
 * Krumhansl–Schmuckler major/minor profiles rotated to all 12 tonics. Returns e.g. "A min".
 * Best-effort (~70%): relative major/minor are easily confused.
 */
export function chromaToKey(chroma: number[]): string {
  let bestScore = -Infinity;
  let bestName = "";
  for (let tonic = 0; tonic < 12; tonic++) {
    const maj = chroma.map((_, p) => KRUMHANSL_MAJOR[(p - tonic + 12) % 12]);
    const sMaj = pearson(chroma, maj);
    if (sMaj > bestScore) {
      bestScore = sMaj;
      bestName = `${NOTE_NAMES[tonic]} maj`;
    }
    const min = chroma.map((_, p) => KRUMHANSL_MINOR[(p - tonic + 12) % 12]);
    const sMin = pearson(chroma, min);
    if (sMin > bestScore) {
      bestScore = sMin;
      bestName = `${NOTE_NAMES[tonic]} min`;
    }
  }
  return bestName;
}

/** Detect the musical key of raw mono PCM. Returns "" for empty input. Best-effort (~70%). */
export function detectKey(samples: Float32Array, sampleRate: number): string {
  if (samples.length === 0 || sampleRate <= 0) return "";
  return chromaToKey(chromaVector(samples, sampleRate));
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
