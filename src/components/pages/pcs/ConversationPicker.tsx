// F8 conversation picker: pick one of the user's existing chat conversations and
// send the current post into it. The list comes verbatim from the existing
// listChannelSummaries (the same read the Chat page uses); sending goes through
// the existing Agora sendText with sharedPostIds set to [postId], which is NOT a
// Sorted RPC, so this surface makes no Postgres write and starts no new trace.
// The Agora connection is provided by a ChatProvider mounted around this picker
// (see PostActionSheet), exactly as the Chat page scopes its own connection.
// The list renders from Postgres whatever the connection state (no
// connection-gated UI); while the read is in flight, skeleton rows hold the
// final row height, and the body keeps one fixed height in every state.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { supabase } from '@/lib/supabase';
import { useChat } from '@/lib/chat';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import {
  sendText,
  targetFromSummary,
  type ChannelTarget,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { createTextMessage } from '@/lib/chat/message-factory';
import { ActionRow } from '@/components/ui/ActionRow';
import { IconChat } from '@/components/ui/icons';

interface ConversationPickerProps {
  /** The post being shared into a conversation. */
  postId: string;
  workspaceId: string;
  currentUserId: string;
  /** Surface a success/failure toast (the page owns the toast stack). */
  onToast: (message: string) => void;
  /** Called after a successful send so the parent can close the sheet. */
  onSent: () => void;
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; channels: ChannelSummary[] }
  | { status: 'error' };

/** Human label for a conversation's type, beneath its title. */
function channelTypeLabel(channel: ChannelSummary): string {
  return channel.channelType === 'group' ? 'Group' : 'Direct message';
}

export function ConversationPicker({
  postId,
  workspaceId,
  currentUserId,
  onToast,
  onSent,
}: ConversationPickerProps) {
  const { client } = useChat();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [sendingId, setSendingId] = useState<string | null>(null);

  // Populate the list from the existing channel read. An empty workspace/user id
  // (no active workspace) simply yields no conversations, handled by the empty
  // state below rather than a thrown error.
  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    void listChannelSummaries(supabase, { workspaceId, currentUserId }).then((result) => {
      if (cancelled) return;
      setLoad(result.ok ? { status: 'ready', channels: result.data } : { status: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUserId]);

  async function send(channel: ChannelSummary): Promise<void> {
    if (sendingId !== null) return;
    const target: ChannelTarget | null = targetFromSummary(channel);
    if (target === null || client === null) {
      onToast('That conversation is not ready yet. Try again in a moment.');
      return;
    }
    setSendingId(channel.channelId);
    try {
      await sendText({
        connection: client as ThreadConnection,
        target,
        text: '',
        attachments: [],
        sharedPostIds: [postId],
        reply: null,
        createMessage: createTextMessage,
      });
      onToast('Post sent to chat.');
      onSent();
    } catch {
      onToast('Could not send the post. Please try again.');
    } finally {
      setSendingId(null);
    }
  }

  return conversationPickerBody(load, sendingId, (channel) => void send(channel));
}

/**
 * The sheet body's fixed height in every state (loading, list, empty, error),
 * so nothing shifts when the read settles; a longer list scrolls inside it.
 * Keep in step with BODY_BOX.
 */
export const CONVERSATION_BODY_PX = 288;

/** One ActionRow's box: py-2 plus the text-sm and text-xs snug line boxes. */
const CONVERSATION_ROW_PX = 16 + 14 * 1.375 + 12 * 1.375;
/** The gap-1 between rows. */
const CONVERSATION_ROW_GAP_PX = 4;

/** Skeleton rows while the list loads: enough to fill the fixed body. */
export const CONVERSATION_SKELETON_ROWS = Math.ceil(
  (CONVERSATION_BODY_PX + CONVERSATION_ROW_GAP_PX) /
    (CONVERSATION_ROW_PX + CONVERSATION_ROW_GAP_PX),
);

/** The fixed body box shared by all four states. */
const BODY_BOX = 'h-[288px] overflow-y-auto';

/**
 * One placeholder with an ActionRow's box (padding, min height, the label and
 * sub line boxes at their line heights), so the rows swap in without a shift.
 */
function ConversationSkeletonRow(): ReactElement {
  return (
    <div
      data-conversation-skeleton=""
      className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2"
    >
      <span className="h-[18px] w-[18px] shrink-0 rounded bg-panel-2" />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium leading-snug">
          <span className="inline-block h-3 w-32 rounded bg-panel-2 align-middle" />
        </span>
        <span className="text-xs leading-snug">
          <span className="inline-block h-2.5 w-20 rounded bg-panel-2 align-middle" />
        </span>
      </span>
    </div>
  );
}

/**
 * The picker's body for a load state: skeleton rows while loading, the error
 * or empty line, else one row per conversation. Never reads the connection.
 * Hook-free.
 */
export function conversationPickerBody(
  load: LoadState,
  sendingId: string | null,
  onSend: (channel: ChannelSummary) => void,
): ReactElement {
  if (load.status === 'loading') {
    return (
      <div className={BODY_BOX}>
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading conversations"
          className="flex h-full flex-col gap-1 overflow-hidden"
        >
          {Array.from({ length: CONVERSATION_SKELETON_ROWS }).map((_, i) => (
            <ConversationSkeletonRow key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (load.status === 'error' || load.channels.length === 0) {
    return (
      <div className={BODY_BOX}>
        <p className="flex h-full items-center justify-center px-3 text-center text-sm text-fg-3">
          {load.status === 'error'
            ? 'Could not load conversations. Please try again.'
            : 'No conversations yet'}
        </p>
      </div>
    );
  }

  return (
    <div className={BODY_BOX}>
      <div className="flex flex-col gap-1">
        {load.channels.map((channel) => (
          <ActionRow
            key={channel.channelId}
            icon={<IconChat size={18} />}
            label={channel.title}
            sub={sendingId === channel.channelId ? 'Sending' : channelTypeLabel(channel)}
            onClick={() => onSend(channel)}
          />
        ))}
      </div>
    </div>
  );
}
