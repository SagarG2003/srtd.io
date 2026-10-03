// The scheduled strip above the composer: shown only while the viewer has 1+
// scheduled messages in this chat. One 48px button on accent-soft with a top
// border: the calendar-clock in accent, "N scheduled message(s)", the next
// send time in mono, a chevron. It paints with the thread's first frame (no
// animation) and opens "Scheduled in this chat". Tokens only.
//
// Also the composer's schedule-mode strip ("Sends tomorrow 9:00 AM" with a
// 44px x), which slides on translateY only.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { IconCalendarClock, IconChevronRight, IconX } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { formatSendLabel, scheduledCountLabel, type ScheduledRow } from '@/lib/chat/scheduled';

export function ScheduledStrip(props: {
  rows: readonly ScheduledRow[];
  onOpen: () => void;
  /** Override for tests. */
  now?: Date;
}): ReactElement | null {
  const next = props.rows[0];
  if (next === undefined) return null;
  return (
    <button
      type="button"
      data-scheduled-strip=""
      onClick={props.onOpen}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'flex h-12 w-full shrink-0 items-center gap-3 border-t border-border bg-accent-soft px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        NO_TOUCH_SELECT,
      )}
    >
      <IconCalendarClock size={20} className="shrink-0 text-accent" />
      <span className="truncate text-sm font-semibold text-fg">
        {scheduledCountLabel(props.rows.length)}
      </span>
      <span className="ml-auto truncate font-mono text-xs tabular-nums text-fg-2">
        {formatSendLabel(new Date(next.send_at), props.now ?? new Date())}
      </span>
      <IconChevronRight size={16} className="shrink-0 text-fg-2" />
    </button>
  );
}

/** The composer in schedule mode: "Sends <label>" and an x that leaves it. */
export function ScheduleModeStrip(props: { label: string; onStop: () => void }): ReactElement {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="overflow-hidden rounded-md">
      <div
        data-schedule-mode=""
        className={cn(
          'flex min-w-0 items-center gap-2 bg-accent-soft pl-3 transition-transform duration-[180ms] ease-out motion-reduce:transition-none',
          entered ? 'translate-y-0' : 'translate-y-full',
          NO_TOUCH_SELECT,
        )}
      >
        <IconCalendarClock size={18} className="shrink-0 text-accent" />
        <span className="flex-1 truncate text-sm font-medium text-fg">Sends {props.label}</span>
        <IconButton label="Stop scheduling" className="shrink-0" onClick={props.onStop}>
          <IconX size={16} />
        </IconButton>
      </div>
    </div>
  );
}
