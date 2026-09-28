import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat } from '@/components/ui/icons';
import { useChat } from '@/lib/chat/chat-context';

/**
 * The unavailable panel as a pure view, so the Retry wiring is unit-testable
 * without a provider: the shared EmptyState with a 44px-tall primary Retry.
 */
export function chatUnavailableView(props: { onRetry: () => void }): ReactElement {
  return (
    <EmptyState
      icon={<IconChat size={22} />}
      title="Chat unavailable"
      description="We could not connect to chat right now. The rest of Sorted keeps working."
      action={
        <Button variant="primary" size="lg" className="min-w-[120px]" onClick={props.onRetry}>
          Retry
        </Button>
      }
    />
  );
}

/**
 * Shown only when there is no chat surface to render at all (no workspace or no
 * signed-in user). A refused or unreachable token endpoint keeps the Postgres
 * chat surface mounted under a "Chat unavailable" banner instead (ChatShell).
 * Retry restarts the connection loop.
 */
export function ChatUnavailable(): ReactElement {
  const { retry } = useChat();
  return chatUnavailableView({ onRetry: retry });
}
