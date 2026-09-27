// The single place the real agora-chat browser SDK is constructed. Isolated here
// so the lifecycle controller and the hook depend on the ChatConnection
// interface (and inject a factory in tests) rather than the SDK directly.

import websdk from 'agora-chat';
import type { ChatConnection, CreateConnection } from '@/lib/chat/types';

/** SDK-level socket reconnect attempts before it reports a disconnect to the controller. */
const AUTO_RECONNECT_NUM_MAX = 10;

/** Construct an agora-chat Connection bound to the worker-provided App Key. */
export const createAgoraConnection: CreateConnection = (appKey): ChatConnection =>
  new websdk.connection({ appKey, delivery: true, autoReconnectNumMax: AUTO_RECONNECT_NUM_MAX });
