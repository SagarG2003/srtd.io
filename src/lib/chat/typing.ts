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
import type { ChannelTarget, ThreadChatType } from '@/lib/chat/thread';
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
  target: ChannelTarget,
  channelId: string | undefined,
): boolean {
  const named = typingChannelId((msg as { ext?: unknown }).ext);
  if (named !== null && channelId !== undefined) return named === channelId;
  return cmdBelongsToTarget(msg, target);
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
  const message = params.createCmd({
    chatType: params.target.chatType,
    type: 'cmd',
    to: params.target.targetId,
    action: TYPING_ACTION,
    ...(params.channelId !== undefined ? { ext: { [TYPING_CHANNEL_KEY]: params.channelId } } : {}),
  });
  return params.connection.send(message);
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
  const message = params.createCmd({
    chatType: params.target.chatType,
    type: 'cmd',
    to: params.target.targetId,
    action: SIGNAL_ACTION,
    ext: params.ext,
  });
  return params.connection.send(message);
}

/**
 * Subscribe to live typing commands for one channel and return the teardown.
 * Registers the 'chat-typing' handler (distinct from the thread handler) and
 * removes exactly it on teardown, so leaving a channel or unmounting leaves
 * nothing dangling. Own echoes and unmappable senders are ignored.
 */
export function subscribeTyping(params: {
  connection: TypingConnection;
  target: ChannelTarget;
  /** The open Sorted channel; a command naming another channel is dropped. */
  channelId?: string;
  currentUserId: string;
  onTypingFrom: (userId: string) => void;
}): () => void {
  const { connection, target, channelId, currentUserId, onTypingFrom } = params;
  connection.addEventHandler(TYPING_EVENT_HANDLER_ID, {
    onCmdMessage: (msg) => {
      if (msg.action !== TYPING_ACTION) return;
      if (!typingForChannel(msg, target, channelId)) return;
      if (msg.from === undefined) return;
      const mapped = userIdFromAgoraUsername(msg.from);
      if (mapped.ok && mapped.userId !== currentUserId) onTypingFrom(mapped.userId);
    },
  });
  return () => connection.removeEventHandler(TYPING_EVENT_HANDLER_ID);
}
