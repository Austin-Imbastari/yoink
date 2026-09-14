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

/** In-place iterative radix-2 FFT. `re` and `im` must share a power-of-two length. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const wr = Math.cos((-2 * Math.PI) / len);
    const wi = Math.sin((-2 * Math.PI) / len);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Hann-windowed magnitude spectrum of every `hop`-spaced frame of `n` samples (a power of two).
 * `onFrame` receives a reused buffer of n/2 bin magnitudes — copy anything you keep.
 */
function forEachSpectrum(samples: Float32Array, n: number, hop: number, onFrame: (mag: Float64Array) => void): void {
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2);
  for (let s = 0; s + n <= samples.length; s += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = samples[s + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(mag);
  }
}

const ONSET_FFT = 1024;

/**
 * Onset-strength envelope, one value per `hop`-sample frame: log-compressed spectral flux (the
 * summed per-bin increase since the previous frame) minus a ~1 s moving average, half-wave
 * rectified. Unlike a plain loudness change, flux also catches hi-hats and note attacks.
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number, hop = 128): Float64Array {
  const flux: number[] = [];
  const prev = new Float64Array(ONSET_FFT / 2);
  forEachSpectrum(samples, ONSET_FFT, hop, (mag) => {
    let sum = 0;
    for (let k = 0; k < mag.length; k++) {
      const v = Math.log1p(100 * mag[k]);
      if (flux.length > 0) sum += Math.max(0, v - prev[k]);
      prev[k] = v;
    }
    flux.push(sum);
  });
  const w = Math.round(sampleRate / hop / 2);
  const prefix = new Float64Array(flux.length + 1);
  for (let i = 0; i < flux.length; i++) prefix[i + 1] = prefix[i] + flux[i];
  const env = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(flux.length, i + w + 1);
    env[i] = Math.max(0, flux[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  return env;
}

/**
 * Estimate tempo (BPM) and beat phase (seconds to the first beat) from raw mono PCM.
 * Autocorrelates the onset envelope over 50–240 BPM and scores each candidate period by its
 * own correlation plus half the correlation at twice the period (a real beat also repeats every
 * two beats), weighted by a log-normal preference for tempos near 130 BPM. There's no fixed
 * folding range, so fast tracks (155, 171) aren't halved. Still best-effort — half/double-time
 * mistakes can happen, and the trim window lets the user correct them. Constants were picked on
 * a set of reference tracks. Returns `{ bpm: 0, phase: 0 }` for input shorter than ~2.5 s.
 */
export function detectBpm(samples: Float32Array, sampleRate: number): { bpm: number; phase: number } {
  if (sampleRate <= 0) return { bpm: 0, phase: 0 };
  const hop = 128;
  const env = onsetEnvelope(samples, sampleRate, hop);
  const envRate = sampleRate / hop;
  const minLag = Math.max(2, Math.floor((60 * envRate) / 240));
  const maxLag = Math.ceil((60 * envRate) / 50);
  if (env.length <= 2 * maxLag + 1) return { bpm: 0, phase: 0 };

  const ac = new Float64Array(2 * maxLag + 2);
  for (let lag = minLag - 1; lag < ac.length; lag++) {
    let sum = 0;
    for (let i = lag; i < env.length; i++) sum += env[i] * env[i - lag];
    ac[lag] = sum / (env.length - lag); // per-overlap mean, so short lags aren't favored
  }
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const prior = Math.exp(-0.5 * (Math.log2((60 * envRate) / lag / 130) / 0.8) ** 2);
    const score = (ac[lag] + 0.5 * ac[2 * lag]) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Parabolic interpolation around the chosen lag for sub-frame precision.
  const lm = ac[bestLag - 1];
  const lp = ac[bestLag + 1];
  const denom = lm - 2 * ac[bestLag] + lp;
  const offset = denom !== 0 ? (0.5 * (lm - lp)) / denom : 0;
  const period = bestLag + Math.max(-0.5, Math.min(0.5, offset));

  // Phase: which beat offset best lines up with the onset peaks.
  let bestOff = 0;
  let bestOffVal = -1;
  for (let off = 0; off < period; off++) {
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
  // A flux frame peaks when the onset reaches the middle of its FFT window.
  const phase = (bestOff * hop + ONSET_FFT / 2) / sampleRate;
  return { bpm: Math.round(((60 * envRate) / period) * 10) / 10, phase };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Scale-degree weights: tonic 2, third and fifth 1.5, other scale notes 1. On the reference
// tracks these beat the Krumhansl and Temperley profiles, which weight chromatic notes.
const MAJOR_PROFILE = [2, 0, 1, 0, 1.5, 1, 0, 1.5, 0, 1, 0, 1];
const MINOR_PROFILE = [2, 0, 1, 1.5, 0, 1, 0, 1.5, 1, 0, 1, 0.5];
const KEY_FFT = 4096;

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

/**
 * 12-bin pitch-class profile built from spectral peaks between 100 Hz and 5 kHz. Only local
 * maxima at ≥1% of the frame's loudest bin count, which keeps broadband drum energy out; each
 * peak's interpolated frequency is rounded to the nearest semitone.
 */
export function chromaVector(samples: Float32Array, sampleRate: number): number[] {
  const chroma = new Array(12).fill(0);
  if (sampleRate <= 0) return chroma;
  forEachSpectrum(samples, KEY_FFT, KEY_FFT / 2, (mag) => {
    let max = 0;
    for (let k = 0; k < mag.length; k++) if (mag[k] > max) max = mag[k];
    for (let k = 2; k < mag.length - 1; k++) {
      const m = mag[k];
      if (m <= mag[k - 1] || m < mag[k + 1] || m < max * 0.01) continue;
      // Parabolic interpolation on log magnitudes for the true peak frequency.
      const la = Math.log(mag[k - 1] + 1e-12);
      const lb = Math.log(m + 1e-12);
      const lc = Math.log(mag[k + 1] + 1e-12);
      const d = la - 2 * lb + lc;
      const freq = ((k + (d !== 0 ? (0.5 * (la - lc)) / d : 0)) * sampleRate) / KEY_FFT;
      if (freq < 100 || freq > 5000) continue;
      chroma[((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12] += m;
    }
  });
  return chroma;
}

/**
 * Best-matching key for a 12-bin chroma vector, by correlation against the major/minor
 * profiles rotated to all 12 tonics. Returns e.g. "A min".
 */
export function chromaToKey(chroma: number[]): string {
  let bestScore = -Infinity;
  let bestName = "";
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [profile, mode] of [
      [MAJOR_PROFILE, "maj"],
      [MINOR_PROFILE, "min"],
    ] as const) {
      const score = pearson(chroma, chroma.map((_, p) => profile[(p - tonic + 12) % 12]));
      if (score > bestScore) {
        bestScore = score;
        bestName = `${NOTE_NAMES[tonic]} ${mode}`;
      }
    }
  }
  return bestName;
}

/**
 * Detect the musical key of raw mono PCM. Returns "" when there's too little audio to analyze.
 * Best-effort: the usual misses are the fifth or the relative major/minor.
 */
export function detectKey(samples: Float32Array, sampleRate: number): string {
  const chroma = chromaVector(samples, sampleRate);
  return chroma.some((v) => v > 0) ? chromaToKey(chroma) : "";
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

export const SKINS = ["luna", "dolphin", "plumbob"] as const; // keep in sync with ui/*.html
export type Skin = (typeof SKINS)[number];

/**
 * A known skin name, else the default "luna". Skin values come back from the dialogs and go
 * into HTML/JS templates, so only allowlisted names get through.
 */
export function normalizeSkin(value: unknown): Skin {
  return SKINS.includes(value as Skin) ? (value as Skin) : "luna";
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

/**
 * Fill every `__KEY__` token in an HTML template and return it as a `data:text/html,` URL.
 * The template and `text` values are percent-encoded; `raw` values (big base64 payloads) go in
 * as-is — base64 has no `%` or `#`, so it needs no encoding, and skipping encodeURIComponent
 * saves another full copy of a many-MB string. Substituted values are never re-scanned for
 * tokens. Unknown tokens are left as-is.
 */
export function htmlDataUrl(template: string, text: Record<string, string>, raw: Record<string, string> = {}): string {
  const parts = template.split(/__([A-Z0-9_]+)__/); // odd indices are token keys
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (i % 2 === 0) parts[i] = encodeURIComponent(s);
    else if (s in raw) parts[i] = raw[s];
    else parts[i] = encodeURIComponent(s in text ? text[s] : `__${s}__`);
  }
  return "data:text/html," + parts.join("");
}

/**
 * Streaming sink for decoded mono PCM, so a long track never sits in memory whole. Keeps one
 * byte per `samplesPerPeak` samples (max |amplitude| → 0–255, for the waveform) plus a copy of
 * the samples in `[winStart, winStart + winLen)` (for BPM/key detection). `expectedSamples` only
 * sizes the first allocation; the peak buffer grows if the stream runs longer.
 */
export function createPcmSink(samplesPerPeak: number, expectedSamples: number, winStart: number, winLen: number) {
  let peaks = new Uint8Array(Math.ceil(Math.max(1, expectedSamples) / samplesPerPeak));
  let nPeaks = 0;
  let cur = 0; // running max of the peak being built
  let pos = 0; // samples seen so far
  const win = new Float32Array(Math.max(0, winLen));

  function flush() {
    if (nPeaks === peaks.length) {
      const grown = new Uint8Array(peaks.length * 2);
      grown.set(peaks);
      peaks = grown;
    }
    peaks[nPeaks++] = Math.min(255, Math.round(cur * 255));
    cur = 0;
  }

  return {
    push(chunk: Float32Array) {
      const a = Math.max(winStart, pos);
      const b = Math.min(winStart + win.length, pos + chunk.length);
      if (b > a) win.set(chunk.subarray(a - pos, b - pos), a - winStart);
      for (let i = 0; i < chunk.length; i++) {
        const v = Math.abs(chunk[i]);
        if (v > cur) cur = v;
        if ((pos + i + 1) % samplesPerPeak === 0) flush();
      }
      pos += chunk.length;
    },
    finish() {
      if (pos % samplesPerPeak !== 0) flush(); // trailing partial peak
      return {
        peaks: peaks.subarray(0, nPeaks),
        window: win.subarray(0, Math.max(0, Math.min(win.length, pos - winStart))),
        totalSamples: pos,
      };
    },
  };
}
