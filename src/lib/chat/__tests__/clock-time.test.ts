import { describe, expect, it } from 'vitest';
import { formatClockTime } from '@/lib/chat/time-format';

// F11: one clock formatter for every chat time, in the workspace zone and the
// device locale's hour cycle (hour12 never forced).
describe('formatClockTime', () => {
  const instant = '2026-09-22T18:45:00Z';

  it('en-IN reads a 12-hour clock', () => {
    expect(formatClockTime(instant, 'UTC', 'en-IN')).toBe('6:45 pm');
  });

  it('en-GB reads a 24-hour clock', () => {
    expect(formatClockTime(instant, 'UTC', 'en-GB')).toBe('18:45');
  });

  it('keeps the workspace zone whatever the locale', () => {
    expect(formatClockTime(instant, 'Asia/Kolkata', 'en-GB')).toMatch(/^0?0:15$/);
    expect(formatClockTime(instant, 'Asia/Kolkata', 'en-IN')).toBe('12:15 am');
  });

  it('with no locale it follows the runtime default hour cycle', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(instant));
    expect(formatClockTime(instant, 'UTC')).toBe(expected);
  });

  it('unparseable input is empty', () => {
    expect(formatClockTime('not a date', 'UTC', 'en-GB')).toBe('');
  });
});
