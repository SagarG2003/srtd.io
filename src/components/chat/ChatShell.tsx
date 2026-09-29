import type { ReactElement } from 'react';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable } from '@/components/chat/ChatUnavailable';

interface ChatShellProps {
  status: ChatStatus;
  client: ChatConnection | null;
  workspaceId: string;
  currentUserId: string;
}

/**
 * Status dispatcher for the chat surface. Hookless on purpose: the branches
 * render without touching React state, so they are unit-testable by calling
 * this function directly. ChatConnected stays mounted in every state that has a
 * workspace and a user (Postgres is the record, so the thread list, history and
 * sending work with no live connection). There is no connection-state UI: a
 * dropped connection surfaces only per message (clock while pending, 'Not sent'
 * plus retry on failure). Only when there is no workspace or user to show does
 * the full unavailable panel render.
 */
export function ChatShell(props: ChatShellProps): ReactElement {
  if (props.status === 'unavailable' && (props.workspaceId === '' || props.currentUserId === '')) {
    return <ChatUnavailable />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ChatConnected
          client={props.client}
          status={props.status}
          workspaceId={props.workspaceId}
          currentUserId={props.currentUserId}
        />
      </div>
    </div>
  );
}
