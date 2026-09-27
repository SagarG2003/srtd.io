// Marks surfaces for the open thread: the count strip under the header, the
// three-tab sheet it opens, and the pending priority chooser. Rows come from the
// channel's mark rows (one read per open) plus the marked messages; a body-less
// message shows its shared post or brief title, resolved in ONE batched read per
// kind while the sheet is open. Tapping a row closes the sheet and jumps to the
// message; pending rows carry a 44x44 Resolve. Colours are design tokens only.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconPin } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { readPostsByIds } from '@srtdio/posts';
import type { ChatProfile } from '@/lib/chat-reads';
import { readBriefsByIds } from '@/lib/chat/briefs';
import { formatMessageTime } from '@/lib/chat/time-format';
import type { WriteResult } from '@/lib/chat/record';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  MARK_TABS,
  markCounts,
  markRowText,
  marksForTab,
  markStripLabel,
  priorityLabel,
  type ChatMark,
  type MarkPriority,
  type MarkTab,
} from '@/lib/chat/marks';

/** The count strip; renders nothing when every count is zero. */
export function MarkStrip(props: {
  marks: Map<string, ChatMark>;
  onOpen: () => void;
}): ReactElement {
  const label = markStripLabel(markCounts(props.marks.values()));
  if (label === '') return <></>;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex min-h-[44px] w-full shrink-0 items-center gap-2 border-b border-border bg-panel-2 px-4 text-left text-xs text-fg-2 transition-colors hover:bg-panel-3"
    >
      <IconPin size={14} className="shrink-0 text-fg-3" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function messageTime(mark: ChatMark, message: ThreadMessage | undefined): number {
  if (message !== undefined && message.createdAt !== '') return message.time;
  const t = Date.parse(mark.markedAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Titles for shared posts and briefs of body-less marked messages, keyed by message id. */
function useCardTitles(open: boolean, messages: readonly ThreadMessage[]): Map<string, string> {
  const { workspaceId } = useWorkspace();
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const bodyless = useMemo(
    () =>
      messages.filter(
        (m) => m.body.trim() === '' && (m.sharedPostIds.length > 0 || m.sharedBriefIds.length > 0),
      ),
    [messages],
  );
  const key = bodyless.map((m) => m.id).join(',');
  useEffect(() => {
    if (!open || workspaceId === null || bodyless.length === 0) return;
    let cancelled = false;
    const postIds = [...new Set(bodyless.flatMap((m) => m.sharedPostIds))];
    const briefIds = [...new Set(bodyless.flatMap((m) => m.sharedBriefIds))];
    void Promise.all([
      readPostsByIds(supabase, { workspaceId, ids: postIds }),
      readBriefsByIds(supabase, { workspaceId, ids: briefIds }),
    ]).then(([posts, briefs]) => {
      if (cancelled) return;
      const byId = new Map<string, string>();
      if (posts.ok) for (const p of posts.data) byId.set(p.id, p.title);
      if (briefs.ok) for (const b of briefs.data) byId.set(b.id, b.title);
      const next = new Map<string, string>();
      for (const m of bodyless) {
        const first = [...m.sharedPostIds, ...m.sharedBriefIds].find((id) => byId.has(id));
        if (first !== undefined) next.set(m.id, byId.get(first) ?? '');
      }
      setTitles(next);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for the body-less id set; `bodyless` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, key]);
  return titles;
}

export function MarksSheet(props: {
  open: boolean;
  onClose: () => void;
  marks: Map<string, ChatMark>;
  /** The marked message, from the loaded thread or the marks read. */
  messageFor: (messageId: string) => ThreadMessage | undefined;
  profiles: Map<string, ChatProfile>;
  timeZone: string;
  onJump: (messageId: string) => void;
  onResolve: (messageId: string) => Promise<WriteResult>;
}): ReactElement {
  const [tab, setTab] = useState<MarkTab>('commitment');
  const [resolving, setResolving] = useState<string | null>(null);
  const toast = useToast();
  const { messageFor } = props;

  const rows = useMemo(
    () => marksForTab(props.marks.values(), tab, (m) => messageTime(m, messageFor(m.messageId))),
    [props.marks, tab, messageFor],
  );
  const openMessages = useMemo(() => {
    const list: ThreadMessage[] = [];
    for (const mark of props.marks.values()) {
      if (mark.resolved) continue;
      const message = messageFor(mark.messageId);
      if (message !== undefined) list.push(message);
    }
    return list;
  }, [props.marks, messageFor]);
  const titles = useCardTitles(props.open, openMessages);
  const counts = markCounts(props.marks.values());
  const tabCount: Record<MarkTab, number> = {
    commitment: counts.commitments,
    decision: counts.decisions,
    pending: counts.pending,
  };

  async function resolve(messageId: string): Promise<void> {
    if (resolving !== null) return;
    setResolving(messageId);
    const result = await props.onResolve(messageId);
    setResolving(null);
    if (!result.ok) toast.show({ title: result.message });
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Marked messages">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="tablist">
          {MARK_TABS.map((option) => (
            <Chip
              key={option.key}
              label={`${option.label} (${tabCount[option.key]})`}
              size="tap"
              selected={tab === option.key}
              onClick={() => setTab(option.key)}
            />
          ))}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconPin size={22} />}
            title="Nothing here"
            description="No messages carry this mark."
          />
        ) : (
          <ul className="flex max-h-[55vh] flex-col overflow-y-auto">
            {rows.map((mark) => {
              const message = messageFor(mark.messageId);
              const sender =
                message === undefined
                  ? 'Member'
                  : message.mine
                    ? 'You'
                    : ((message.senderUserId !== null
                        ? props.profiles.get(message.senderUserId)?.displayName
                        : undefined) ?? 'Member');
              const when =
                message !== undefined && message.createdAt !== ''
                  ? formatMessageTime(message.createdAt, props.timeZone)
                  : formatMessageTime(mark.markedAt, props.timeZone);
              return (
                <li key={mark.messageId} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => props.onJump(mark.messageId)}
                    className="flex min-h-[44px] min-w-0 flex-1 flex-col rounded-md px-2 py-2 text-left transition-colors hover:bg-panel-2"
                  >
                    <span className="flex items-center gap-2 text-xs text-fg-3">
                      <span className="truncate font-medium text-fg">{sender}</span>
                      {mark.type === 'pending' && mark.priority !== null ? (
                        <span className="rounded-full border border-warn px-1.5 text-[10px] text-warn">
                          {priorityLabel(mark.priority)}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0">{when}</span>
                    </span>
                    <span className="line-clamp-2 [overflow-wrap:anywhere] text-sm text-fg-2">
                      {markRowText(message, titles.get(mark.messageId))}
                    </span>
                  </button>
                  {mark.type === 'pending' ? (
                    <button
                      type="button"
                      aria-label="Resolve"
                      disabled={resolving !== null}
                      onClick={() => void resolve(mark.messageId)}
                      className={cn(
                        'flex h-11 min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-fg-2 transition-colors hover:bg-panel-2',
                        resolving === mark.messageId && 'opacity-50',
                      )}
                    >
                      <IconCheck size={14} />
                      <span>Resolve</span>
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

const PRIORITY_OPTIONS: ReadonlyArray<{ value: MarkPriority; label: string }> = [
  { value: 1, label: 'P1' },
  { value: 2, label: 'P2' },
  { value: null, label: 'No priority' },
];

/** Priority chooser for marking as pending, or changing an open pending mark. */
export function PrioritySheet(props: {
  open: boolean;
  title: string;
  current: MarkPriority | undefined;
  busy: boolean;
  onChoose: (priority: MarkPriority) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <Button variant="ghost" size="lg" className="ml-auto" onClick={props.onClose}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {PRIORITY_OPTIONS.map((option) => (
          <Chip
            key={option.label}
            label={option.label}
            size="tap"
            selected={props.current !== undefined && props.current === option.value}
            onClick={() => {
              if (!props.busy) props.onChoose(option.value);
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}
