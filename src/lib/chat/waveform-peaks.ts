// A voice note's waveform, drawn from the real audio. voice-peaks.ts decodes
// the finished recording and takes the RMS level of each PEAK_SAMPLE_MS
// window; the levels are folded into exactly PEAK_COUNT integers 0..100,
// normalised to the note's own peak, and carried as the attachment meta key `peaks`. Readers
// validate them (parsePeaks): anything that is not an array of up to
// PEAK_COUNT finite numbers is absent, and the note draws the fixed bars.
// Pure: no audio API here, so every step is unit-tested directly.

/** How many peaks a note carries. */
export const PEAK_COUNT = 48;

/** The length of one level window read from the decoded recording. */
export const PEAK_SAMPLE_MS = 50;

/** A sample as a usable level: non-finite or negative reads as silence. */
function level(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold level samples into `count` buckets (each the loudest sample in its
 * slice), then scale to 0..100 against the loudest bucket. Fewer samples than
 * buckets repeat the nearest sample; no samples, or silence, give all zeros
 * (never NaN). Pure.
 */
export function downsamplePeaks(samples: readonly number[], count: number = PEAK_COUNT): number[] {
  const size = Math.max(0, Math.floor(count));
  const n = samples.length;
  if (size === 0) return [];
  if (n === 0) return new Array<number>(size).fill(0);
  const buckets: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const from = Math.floor((i * n) / size);
    const to = Math.max(from + 1, Math.floor(((i + 1) * n) / size));
    let loudest = 0;
    for (let j = from; j < to && j < n; j += 1) loudest = Math.max(loudest, level(samples[j]));
    buckets.push(loudest);
  }
  const peak = Math.max(...buckets);
  if (!(peak > 0)) return buckets.map(() => 0);
  return buckets.map((value) => Math.min(100, Math.max(0, Math.round((value / peak) * 100))));
}

/**
 * Read a `peaks` value from any source (DB meta, live ext, stored outbox): an
 * array of 1..PEAK_COUNT finite numbers, each clamped to 0..100; anything else
 * is absent (undefined). Pure.
 */
export function parsePeaks(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > PEAK_COUNT) return undefined;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return undefined;
    out.push(Math.min(100, Math.max(0, item)));
  }
  return out;
}

/**
 * Resample peaks to the number of bars drawn: each bar is the loudest peak in
 * its slice (a bar between two peaks takes the nearest). Pure.
 */
export function resamplePeaks(peaks: readonly number[], bars: number): number[] {
  const size = Math.max(0, Math.floor(bars));
  const n = peaks.length;
  if (size === 0) return [];
  if (n === 0) return new Array<number>(size).fill(0);
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const from = Math.floor((i * n) / size);
    const to = Math.max(from + 1, Math.floor(((i + 1) * n) / size));
    let loudest = 0;
    for (let j = from; j < to && j < n; j += 1) loudest = Math.max(loudest, level(peaks[j]));
    out.push(Math.min(100, loudest));
  }
  return out;
}
