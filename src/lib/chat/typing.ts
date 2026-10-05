// Live-only typing signals, driven entirely by the Agora SDK and carried as
// command (`cmd`) messages so nothing touches Postgres or the schema. This
// mirrors thread.ts's ethos: the SDK connection and message factory are
// injected, so every branch is unit-tested under the node test job with the SDK
// fully mocked and no DOM.
//
// Agora type names are taken verbatim from the installed agora-chat 1.3.1
// typings (`import type { AgoraChat }`): a command message is built with
// `message.create({ type: 'cmd', chatType, to, action, ext? })`, sent via
// `connection.send(MessageBody)`, and received on the `onCmdMessage(CmdMsgBody)`
// event. The factory is injected as `createCmd` so this module stays SDK-free.
// The same factory carries the thread's reaction and read signals (see
// thread.ts), which ride `ext` on a command message.

import type { AgoraChat } from 'agora-chat';
import type { ChatConnection } from '@/lib/chat/types';
import {
  mapLiveTextMessage,
  sendRouted,
  type ChannelTarget,
  type ThreadChatType,
} from '@/lib/chat/thread';
import { userIdFromAgoraUsername } from '@/lib/chat/agora-identity';

/** Our own SDK event-handler id, distinct from the thread/Foundation handlers. */
export const TYPING_EVENT_HANDLER_ID = 'chat-typing';

/** The `action` value our typing command messages carry. */
export const TYPING_ACTION = 'typing';

/** The `action` value the thread's live signals (reaction, read) carry. */
export const SIGNAL_ACTION = 'sorted_signal';

/**
 * The connection surface typing drives: the Foundation ChatConnection plus the
 * `send` member it does not expose. Extends ChatConnection so the Foundation
 * client casts to it structurally, without `unknown` or `any`.
 */
export interface TypingConnection extends ChatConnection {
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
}

/** Injected `AgoraChat.message.create` for command messages; keeps the SDK out. */
export type CreateCmdMessage = (options: {
  chatType: ThreadChatType;
  type: 'cmd';
  to: string;
  action: string;
  /** Custom extension; the thread's live signals ride here. */
  ext?: Record<string, unknown>;
  /**
   * Agora's online-only delivery flag. The SDK default (false) queues the cmd
   * for an offline recipient and replays it on reconnect; omitted keeps it.
   */
  deliverOnlineOnly?: boolean;
}) => AgoraChat.MessageBody;

/** Whether a live command message belongs to the open channel. */
export function cmdBelongsToTarget(msg: AgoraChat.CmdMsgBody, target: ChannelTarget): boolean {
  if (target.chatType === 'groupChat') {
    return msg.chatType === 'groupChat' && msg.to === target.targetId;
  }
  return (
    msg.chatType === 'singleChat' && (msg.from === target.targetId || msg.to === target.targetId)
  );
}

/**
 * Drop an inbound typing cmd older than this (by its `time` against the local
 * clock). Generous rather than INBOUND_CLEAR_MS-tight so device clock skew never
 * hides a live signal; it exists to drop cmds queued offline and replayed.
 */
export const TYPING_MAX_AGE_MS = 30000;

/**
 * Whether a typing cmd is too old to show. A future-dated time (skew) is fresh;
 * a missing or non-number time is accepted, since typing is a live hint only.
 */
export function typingCmdIsStale(time: unknown, now: number): boolean {
  if (typeof time !== 'number' || !Number.isFinite(time)) return false;
  return now - time > TYPING_MAX_AGE_MS;
}

/** The `ext` key a typing command carries the Sorted channel id under. */
export const TYPING_CHANNEL_KEY = 'channelId';

/** The Sorted channel id a typing command names in its ext; null when absent (older client). */
export function typingChannelId(ext: unknown): string | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const value = (ext as Record<string, unknown>)[TYPING_CHANNEL_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether an inbound typing command is for the open chat. A command naming a
 * channel id must name this one; one without (an older client) falls back to
 * the Agora from / to match.
 */
export function typingForChannel(
  msg: AgoraChat.CmdMsgBody,
  target: ChannelTarget | null,
  channelId: string | undefined,
): boolean {
  const named = typingChannelId((msg as { ext?: unknown }).ext);
  if (named !== null && channelId !== undefined) return named === channelId;
  // An older client (no channel id) only matches a known Agora target.
  return target !== null && cmdBelongsToTarget(msg, target);
}

/**
 * Build a typing command for the channel and send it via the SDK. With a
 * channelId it rides ext { channelId } so the receiver scopes it to that chat.
 */
export function sendTyping(params: {
  connection: TypingConnection;
  target: ChannelTarget;
  createCmd: CreateCmdMessage;
  channelId?: string;
}): Promise<AgoraChat.SendMsgResult> {
  const ext =
    params.channelId !== undefined ? { ext: { [TYPING_CHANNEL_KEY]: params.channelId } } : {};
  return sendRouted(params.connection, params.target, (to, chatType) =>
    params.createCmd({
      chatType,
      type: 'cmd',
      to,
      action: TYPING_ACTION,
      ...ext,
      // Typing is live only: never queue it for an offline peer to replay later.
      deliverOnlineOnly: true,
    }),
  );
}

/**
 * The typing ids a chat may show: in a DM only the peer, in a group only its
 * members (none until the member list is known). Pure.
 */
export function visibleTypingIds(input: {
  ids: readonly string[];
  isGroup: boolean;
  peerUserId: string | null;
  memberIds: ReadonlySet<string> | null;
}): string[] {
  if (input.isGroup) {
    const members = input.memberIds;
    return members === null ? [] : input.ids.filter((id) => members.has(id));
  }
  return input.peerUserId === null ? [] : input.ids.filter((id) => id === input.peerUserId);
}

/** Build a live signal command (reaction / read) for the channel and send it. */
export function sendSignal(params: {
  connection: TypingConnection;
  target: ChannelTarget;
  createCmd: CreateCmdMessage;
  ext: Record<string, unknown>;
}): Promise<AgoraChat.SendMsgResult> {
  return sendRouted(params.connection, params.target, (to, chatType) =>
    params.createCmd({ chatType, type: 'cmd', to, action: SIGNAL_ACTION, ext: params.ext }),
  );
}

/**
 * Subscribe to live typing commands for one channel and return the teardown.
 * Registers the 'chat-typing' handler (distinct from the thread handler) and
 * removes exactly it on teardown, so leaving a channel or unmounting leaves
 * nothing dangling. Own echoes, unmappable senders and stale (replayed) cmds
 * are ignored. A peer's text message landing in the open channel fires
 * onMessageFrom so their typing row clears with the message, not a timer later.
 */
export function subscribeTyping(params: {
  connection: TypingConnection;
  /** The open chat's Agora target, for older clients' commands; null routes by channel id only. */
  target: ChannelTarget | null;
  /** The open Sorted channel; a command naming another channel is dropped. */
  channelId?: string;
  currentUserId: string;
  onTypingFrom: (userId: string) => void;
  /** A peer's text message arrived in the open channel; their typing is over. */
  onMessageFrom: (userId: string) => void;
}): () => void {
  const { connection, target, channelId, currentUserId, onTypingFrom, onMessageFrom } = params;
  connection.addEventHandler(TYPING_EVENT_HANDLER_ID, {
    onCmdMessage: (msg) => {
      if (msg.action !== TYPING_ACTION) return;
      if (typingCmdIsStale((msg as { time?: unknown }).time, Date.now())) return;
      if (!typingForChannel(msg, target, channelId)) return;
      if (msg.from === undefined) return;
      const mapped = userIdFromAgoraUsername(msg.from);
      if (mapped.ok && mapped.userId !== currentUserId) onTypingFrom(mapped.userId);
    },
    onTextMessage: (msg) => {
      if (channelId === undefined) return;
      const mapped = mapLiveTextMessage(msg, currentUserId);
      if (!mapped.ok || mapped.channelId !== channelId) return;
      const sender = mapped.message.senderUserId;
      if (sender !== null && sender !== currentUserId) onMessageFrom(sender);
    },
  });
  return () => connection.removeEventHandler(TYPING_EVENT_HANDLER_ID);
}
