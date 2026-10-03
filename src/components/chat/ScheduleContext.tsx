// What the open chat's composer needs to schedule: provided by ChatConnected
// around the thread, read by the Composer whose channelId matches. The thread
// view's composer (no channelId) never matches, so it schedules nothing and
// shows no strip.

import { createContext, useContext } from 'react';
import type { ScheduledRow } from '@/lib/chat/scheduled';

/** One draft as the scheduler takes it: the same parts the normal send carries. */
export interface ScheduleDraft {
  /** Serialized body (mention tokens kept). */
  body: string;
  sharedPostIds: string[];
  sharedBriefIds: string[];
  replyToMessageId: string | null;
}

/** A schedule write's outcome: ok, or the mapped copy (null: refetched silently). */
export type ScheduleOutcome = { ok: true } | { ok: false; copy: string | null };

export interface ChatSchedule {
  channelId: string;
  /** The chat's name for the sheet's "To <chat name>: ..." preview. */
  chatName: string;
  /** The caller's scheduled rows for this chat, soonest first. */
  rows: readonly ScheduledRow[];
  /** True once the rows are read AND the thread's first page paints (same frame). */
  stripVisible: boolean;
  schedule: (draft: ScheduleDraft, sendAt: Date) => Promise<ScheduleOutcome>;
  /** Open "Scheduled in this chat". */
  openList: () => void;
}

const ChatScheduleContext = createContext<ChatSchedule | null>(null);

export const ChatScheduleProvider = ChatScheduleContext.Provider;

/** The schedule wiring for a composer on `channelId`; null when none applies. */
export function useChatSchedule(channelId: string | undefined): ChatSchedule | null {
  const value = useContext(ChatScheduleContext);
  if (value === null || channelId === undefined || value.channelId !== channelId) return null;
  return value;
}
