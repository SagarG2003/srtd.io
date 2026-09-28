import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { createStatusGate, type BannerState, type StatusGate } from '@/lib/chat/controller';
import { useChat } from '@/lib/chat/chat-context';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable } from '@/components/chat/ChatUnavailable';

interface ChatShellProps {
  status: ChatStatus;
  client: ChatConnection | null;
  workspaceId: string;
  currentUserId: string;
}

/**
 * The banner copy for a banner state; '' when there is nothing to say. A slow
 * first connect never gets its own wording: past the grace it reads as
 * "Reconnecting" like any other gap.
 */
export function connectionBannerText(banner: BannerState): string {
  if (banner === 'reconnecting') return 'Reconnecting';
  if (banner === 'unavailable') return 'Live updates paused. Messages still send.';
  if (banner === 'kicked') return 'Signed in on another device';
  return '';
}

/** The tap label for a banner that needs the user to act; '' when none. */
export function connectionBannerAction(banner: BannerState): string {
  if (banner === 'unavailable') return 'Retry';
  if (banner === 'kicked') return 'Reconnect';
  return '';
}

/**
 * Thin status strip laid over the top of the chat surface while live delivery
 * is really down. It is absolutely positioned, so showing or hiding it never
 * moves the thread. History and sends keep working against Postgres underneath
 * it. The unavailable and kicked states carry a 44px tap target that restarts
 * the connection. Token colours only, so light and dark stay at parity.
 */
export function ConnectionBanner({
  banner,
  onRetry,
}: {
  banner: BannerState;
  onRetry?: () => void;
}): ReactElement | null {
  const text = connectionBannerText(banner);
  if (text === '') return null;
  const action = connectionBannerAction(banner);
  return (
    <div
      role="status"
      className="absolute inset-x-0 top-0 z-10 flex min-h-[36px] items-center justify-center gap-2 border-b border-border bg-panel-2 px-4 py-1.5 text-xs text-fg-2"
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          banner === 'reconnecting' ? 'animate-pulse bg-warn' : 'bg-bad',
        )}
      />
      <span>{text}</span>
      {action !== '' && onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[44px] min-w-[44px] rounded-md px-2 text-xs font-medium text-accent hover:bg-panel-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The raw status run through the grace gate. First paint is always 'none'
 * (a kick excepted): nothing shows until the connection has been down for
 * STATUS_GRACE_MS. A new resetKey (workspace switch) or a Retry tap starts a
 * fresh grace period.
 */
export function GatedConnectionBanner({
  status,
  resetKey,
  onRetry,
}: {
  status: ChatStatus;
  resetKey: string;
  onRetry: () => void;
}): ReactElement | null {
  const [banner, setBanner] = useState<BannerState>(status === 'kicked' ? 'kicked' : 'none');
  const gateRef = useRef<StatusGate | null>(null);

  useEffect(() => {
    const gate = createStatusGate({ onChange: setBanner });
    gateRef.current = gate;
    return () => {
      gate.dispose();
      gateRef.current = null;
    };
  }, [resetKey]);

  useEffect(() => {
    gateRef.current?.update(status);
  }, [status, resetKey]);

  const retry = useCallback(() => {
    gateRef.current?.reset();
    onRetry();
  }, [onRetry]);

  return <ConnectionBanner banner={banner} onRetry={retry} />;
}

/** The gated banner wired to the shared connection's retry (the tap reconnects). */
export function ChatStatusBanner({
  status,
  workspaceId,
}: {
  status: ChatStatus;
  workspaceId: string;
}): ReactElement | null {
  const { retry } = useChat();
  return <GatedConnectionBanner status={status} resetKey={workspaceId} onRetry={retry} />;
}

/**
 * Status dispatcher for the chat surface. Hookless on purpose: the branches
 * render without touching React state, so they are unit-testable by calling
 * this function directly. ChatConnected stays mounted in every state that has a
 * workspace and a user (Postgres is the record, so the thread list, history and
 * sending work with no live connection) under a gated overlay banner. Only when
 * there is no workspace or user to show does the full unavailable panel render.
 */
export function ChatShell(props: ChatShellProps): ReactElement {
  if (props.status === 'unavailable' && (props.workspaceId === '' || props.currentUserId === '')) {
    return <ChatUnavailable />;
  }
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ChatStatusBanner status={props.status} workspaceId={props.workspaceId} />
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
