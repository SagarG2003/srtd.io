import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

// R1: the chat sheets' clock times use the device hour cycle, never a forced 24h.
describe('R1: chat surfaces format clock time with formatClockTime', () => {
  const surfaces = [
    'src/components/chat/ContactSheet.tsx',
    'src/components/chat/MarksSheet.tsx',
    'src/components/chat/post-sheet.ts',
  ];

  it.each(surfaces)('%s imports formatClockTime, not the 24-hour formatter', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(
      /import \{[^}]*\bformatClockTime\b[^}]*\} from '@\/lib\/chat\/time-format'/,
    );
    expect(source).not.toContain('formatMessageTime');
  });

  it('post sheet approved row reads 12h on en-IN and 24h on en-GB', () => {
    const iso = '2026-10-01T14:05:00Z';
    expect(formatClockTime(iso, 'UTC', 'en-IN')).toBe('2:05 pm');
    expect(formatClockTime(iso, 'UTC', 'en-GB')).toBe('14:05');
  });
});
