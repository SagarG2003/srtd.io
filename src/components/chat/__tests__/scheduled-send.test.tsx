import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { canScheduleDraft, scheduledToast } from '@/components/chat/Composer';
import {
  ScheduleMenu,
  ScheduleOptions,
  schedulePreview,
  SCHEDULE_HELPER,
  zoneLine,
} from '@/components/chat/ScheduleSheet';
import { ScheduledStrip, ScheduleModeStrip } from '@/components/chat/ScheduledStrip';
import { scheduledPreviewText } from '@/components/chat/ScheduledListSheet';
import { IconCalendarClock } from '@/components/ui/icons';
import type { ScheduledRow } from '@/lib/chat/scheduled';

const EM_DASH = String.fromCharCode(0x2014);
// Built from char codes so this file passes the chat token-hygiene scan itself.
const HEX = new RegExp(`${String.fromCharCode(35)}[0-9a-fA-F]{3,8}\\b`);
const DARK = new RegExp(`\\b${'da'}rk${String.fromCharCode(58)}`);

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

function row(partial: Partial<ScheduledRow>): ScheduledRow {
  return {
    id: 'r1',
    channel_id: 'c1',
    workspace_id: 'w1',
    sender_user_id: 'u1',
    body: null,
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: new Date(Date.now() + 86_400_000).toISOString(),
    status: 'scheduled',
    failure_reason: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

describe('S2: when a draft may be scheduled', () => {
  it('only with the wiring, a sendable draft, no files, not editing', () => {
    const ok = { scheduling: true, editing: false, canSend: true, fileCount: 0 };
    expect(canScheduleDraft(ok)).toBe(true);
    expect(canScheduleDraft({ ...ok, scheduling: false })).toBe(false);
    expect(canScheduleDraft({ ...ok, editing: true })).toBe(false);
    expect(canScheduleDraft({ ...ok, canSend: false })).toBe(false);
    expect(canScheduleDraft({ ...ok, fileCount: 1 })).toBe(false);
  });
});

describe('S2: phone hold and laptop chevron wiring', () => {
  const composer = source('../Composer.tsx');
  it('the hold reuses useLongPress and only rides Send on touch', () => {
    expect(composer).toContain("from '@/components/ui/useLongPress'");
    expect(composer).toContain("const holdToSchedule = layout === 'touch' && schedulable;");
    expect(composer).toContain('{...(holdToSchedule ? sendHold.handlers : {})}');
    // No iOS selection or callout, no context menu, and the hold never submits.
    expect(composer).toContain('holdToSchedule && NO_TOUCH_SELECT');
    expect(composer).toContain('onContextMenu={holdToSchedule ? (event) => event.preventDefault()');
    expect(composer).toContain('if (sendHold.consumeClickSuppression()) event.preventDefault();');
    expect(composer).toContain('swallowTrailingClick();');
  });

  it('the chevron is laptop only, 44px, labelled', () => {
    expect(composer).toContain("const showChevron = layout === 'laptop' && schedulable;");
    expect(composer).toContain('aria-label="Schedule options"');
    expect(composer).toContain("'w-11 shrink-0 rounded-l-none px-0'".slice(1, -1));
  });

  it('the camera input is gone (Photos still offers Take Photo)', () => {
    expect(composer).not.toContain('cameraInputRef');
    expect(composer).not.toContain('capture="environment"');
  });

  it('schedule mode swaps the Send icon and label', () => {
    expect(composer).toContain("scheduling ? 'Schedule message' : 'Send'");
    expect(composer).toContain('<IconCalendarClock size={18} />');
  });
});

describe('S3: the Schedule options', () => {
  it('rows: Tomorrow and Monday with mono times, then Custom time', () => {
    const html = renderToStaticMarkup(
      <ScheduleOptions preview="To Ops: hello" onPick={() => undefined} />,
    );
    expect(html).toContain('data-schedule-row="tomorrow"');
    expect(html).toContain('data-schedule-row="monday"');
    expect(html).toContain('data-schedule-row="custom"');
    expect(html).toContain('Custom time');
    expect(html).toContain('font-mono');
    expect(html).toContain('min-h-[56px]');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('To Ops: hello');
    expect(html).toMatch(/9:00 AM/);
  });

  it('no preview without a draft', () => {
    const html = renderToStaticMarkup(<ScheduleOptions preview={null} onPick={() => undefined} />);
    expect(html).not.toContain('data-schedule-preview');
    expect(schedulePreview('Ops', '   ')).toBeNull();
    expect(schedulePreview('Ops', 'hi\nthere')).toBe('To Ops: hi there');
  });

  it('the footer names the device zone from Intl', () => {
    expect(zoneLine(new Date())).toMatch(/^Times are in your time zone/);
    expect(SCHEDULE_HELPER).toBe('Any time from 1 minute to 1 year ahead.');
  });

  it('the laptop menu fades only (no translate)', () => {
    const html = renderToStaticMarkup(
      <ScheduleMenu open onClose={() => undefined} preview={null} onPick={() => undefined} />,
    );
    expect(html).toContain('data-schedule-menu');
    const surface = /data-schedule-menu="" class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(surface).toContain('transition-opacity');
    expect(surface).not.toMatch(/translate-|rotate-|scale-/);
    expect(html).toContain('right-3');
    expect(html).toContain('bottom-full');
  });
});

describe('S4 / S6: strips', () => {
  it('schedule mode: "Sends <label>" and a 44px x', () => {
    const html = renderToStaticMarkup(
      <ScheduleModeStrip label="tomorrow 9:00 AM" onStop={() => undefined} />,
    );
    expect(html).toContain('Sends tomorrow 9:00 AM');
    expect(html).toContain('aria-label="Stop scheduling"');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('bg-accent-soft');
    const surface = /data-schedule-mode="" class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(surface).toContain('translate-y-full');
    expect(surface).toContain('transition-transform');
    expect(surface).not.toMatch(/translate-x|rotate-|scale-|opacity/);
  });

  it('scheduled strip: 48px button, count, next time in mono, nothing when empty', () => {
    const now = new Date(2026, 9, 3, 12);
    const one = renderToStaticMarkup(
      <ScheduledStrip
        rows={[row({ send_at: new Date(2026, 9, 4, 9).toISOString() })]}
        onOpen={() => undefined}
        now={now}
      />,
    );
    expect(one).toContain('h-12');
    expect(one).toContain('bg-accent-soft');
    expect(one).toContain('border-t');
    expect(one).toContain('1 scheduled message<');
    expect(one).toContain('Tomorrow 9:00 AM');
    expect(one).toContain('font-mono');
    expect(one).not.toMatch(/transition|animate-/);
    const two = renderToStaticMarkup(
      <ScheduledStrip
        rows={[
          row({ id: 'a', send_at: new Date(2026, 9, 7, 11, 30).toISOString() }),
          row({ id: 'b', send_at: new Date(2026, 9, 8, 9).toISOString() }),
        ]}
        onOpen={() => undefined}
        now={now}
      />,
    );
    expect(two).toContain('2 scheduled messages');
    expect(two).toContain('Wed 7 Oct, 11:30 AM');
    expect(renderToStaticMarkup(<ScheduledStrip rows={[]} onOpen={() => undefined} />)).toBe('');
  });
});

describe('S7: card previews', () => {
  const nameOf = (id: string) =>
    id === '0190a000-0000-7000-8000-000000000001' ? 'Asha' : undefined;
  it('body with names, else the attachment / shared post label', () => {
    expect(
      scheduledPreviewText(row({ body: 'hi @[0190a000-0000-7000-8000-000000000001]' }), nameOf),
    ).toBe('hi @Asha');
    expect(scheduledPreviewText(row({ attachment_asset_ids: ['a'] }), nameOf)).toBe('Attachment');
    expect(scheduledPreviewText(row({ shared_post_ids: ['p'] }), nameOf)).toBe('Shared post');
  });
});

describe('icon and toast copy', () => {
  it('IconCalendarClock: a calendar with a clock, stroke 1.7', () => {
    const html = renderToStaticMarkup(<IconCalendarClock />);
    expect(html).toContain('stroke-width="1.7"');
    expect(html).toContain('<circle');
  });

  it('toast reads "Scheduled for tomorrow 9:00 AM"', () => {
    expect(scheduledToast(new Date(2026, 9, 4, 9), new Date(2026, 9, 3, 12))).toBe(
      'Scheduled for tomorrow 9:00 AM',
    );
  });
});

describe('S10: tokens only, no em-dash', () => {
  const files = [
    '../ScheduleSheet.tsx',
    '../ScheduledStrip.tsx',
    '../ScheduledListSheet.tsx',
    '../ScheduleContext.tsx',
    '../../../lib/chat/scheduled.ts',
  ];
  it.each(files)('%s', (file) => {
    const src = source(file);
    expect(src).not.toMatch(HEX);
    expect(src).not.toMatch(DARK);
    expect(src).not.toContain(EM_DASH);
  });
});
