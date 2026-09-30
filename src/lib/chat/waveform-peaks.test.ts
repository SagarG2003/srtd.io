import { describe, expect, it } from 'vitest';
import { PEAK_COUNT, downsamplePeaks, parsePeaks, resamplePeaks } from '@/lib/chat/waveform-peaks';

describe('downsamplePeaks (T1)', () => {
  it('folds any number of samples into exactly 48 integers 0..100', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => Math.abs(Math.sin(i / 20)) * 0.3);
    const peaks = downsamplePeaks(samples);
    expect(peaks).toHaveLength(PEAK_COUNT);
    for (const p of peaks) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it('normalises to the note own peak: the loudest bucket is 100', () => {
    const samples = Array.from({ length: 96 }, (_, i) => (i === 50 ? 0.2 : 0.05));
    const peaks = downsamplePeaks(samples);
    expect(Math.max(...peaks)).toBe(100);
    expect(peaks[25]).toBe(100);
    expect(peaks[0]).toBe(25);
  });

  it('silence gives all zeros without NaN', () => {
    const peaks = downsamplePeaks(new Array<number>(200).fill(0));
    expect(peaks).toEqual(new Array<number>(PEAK_COUNT).fill(0));
    expect(peaks.some(Number.isNaN)).toBe(false);
  });

  it('non-finite samples read as silence', () => {
    const peaks = downsamplePeaks([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]);
    expect(peaks.some(Number.isNaN)).toBe(false);
    expect(Math.max(...peaks)).toBe(100);
  });

  it('short input (fewer samples than buckets) still yields 48 values', () => {
    const peaks = downsamplePeaks([0.1, 0.4]);
    expect(peaks).toHaveLength(PEAK_COUNT);
    expect(peaks[0]).toBe(25);
    expect(peaks[PEAK_COUNT - 1]).toBe(100);
  });

  it('no samples gives 48 zeros', () => {
    expect(downsamplePeaks([])).toEqual(new Array<number>(PEAK_COUNT).fill(0));
  });
});

describe('parsePeaks', () => {
  it('keeps up to 48 finite numbers, clamped 0..100', () => {
    expect(parsePeaks([0, 50, 150, -3])).toEqual([0, 50, 100, 0]);
    expect(parsePeaks(new Array<number>(48).fill(7))).toHaveLength(48);
  });

  it('anything else is absent', () => {
    expect(parsePeaks(undefined)).toBeUndefined();
    expect(parsePeaks('1,2')).toBeUndefined();
    expect(parsePeaks([])).toBeUndefined();
    expect(parsePeaks(new Array<number>(49).fill(1))).toBeUndefined();
    expect(parsePeaks([1, 'x'])).toBeUndefined();
    expect(parsePeaks([1, Number.NaN])).toBeUndefined();
    expect(parsePeaks({ 0: 1 })).toBeUndefined();
  });
});

describe('resamplePeaks', () => {
  it('resamples to the bar count drawn', () => {
    const peaks = Array.from({ length: 48 }, (_, i) => (i === 47 ? 100 : 10));
    const bars = resamplePeaks(peaks, 20);
    expect(bars).toHaveLength(20);
    expect(bars[19]).toBe(100);
    expect(bars[0]).toBe(10);
  });

  it('stretches fewer peaks over more bars', () => {
    expect(resamplePeaks([20, 80], 4)).toEqual([20, 20, 80, 80]);
  });
});
