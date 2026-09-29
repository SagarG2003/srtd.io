// Bottom bar for selection mode: the selected count, a 44px Forward (any
// recorded message), a 44x44 Delete that opens the confirm dialog (own, unmarked
// messages only; disabled otherwise), and Cancel. The confirm dialog runs
// the delete; on failure the proc's message shows as a toast and the selection
// is kept (the caller only clears it on success). Design tokens only.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconForward, IconTrash } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

export function SelectionBar(props: {
  count: number;
  /** False when a selected message is not the caller's own unmarked one. */
  canDelete?: boolean;
  /** Opens the forward picker for the selection; absent hides Forward. */
  onForward?: () => void;
  onCancel: () => void;
  /** Runs the delete; resolves ok, or the proc's message. */
  onDelete: () => Promise<{ ok: true } | { ok: false; message: string }>;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const result = await props.onDelete();
    setBusy(false);
    setConfirming(false);
    if (!result.ok) toast.show({ title: result.message });
  }

  return (
    <div className="flex items-center gap-2 border-t border-border bg-panel px-4 py-3">
      <span className="flex-1 text-sm text-fg-2">{`${props.count} selected`}</span>
      {props.onForward !== undefined ? (
        <Button variant="ghost" size="lg" disabled={props.count === 0} onClick={props.onForward}>
          <IconForward size={18} />
          Forward
        </Button>
      ) : null}
      <IconButton
        label="Delete selected messages"
        className="text-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50"
        disabled={props.count === 0 || props.canDelete === false}
        onClick={() => setConfirming(true)}
      >
        <IconTrash size={20} />
      </IconButton>
      <Button variant="ghost" size="lg" onClick={props.onCancel}>
        Cancel
      </Button>
      {deleteMessagesConfirm({
        open: confirming,
        count: props.count,
        busy,
        onCancel: () => setConfirming(false),
        onConfirm: () => void confirm(),
      })}
    </div>
  );
}

/** Confirm title for the selected messages. */
export function deleteMessagesTitle(count: number): string {
  return `Delete ${count} ${count === 1 ? 'message' : 'messages'}?`;
}

/** Confirm body: the delete is for everyone and final. */
export const DELETE_MESSAGES_MESSAGE =
  'They will be removed from this chat for everyone. This cannot be undone.';

/**
 * The delete-selected confirm, or null when closed. Hook-free so the confirm and
 * cancel wiring are unit tested by calling the dialog's handlers.
 */
export function deleteMessagesConfirm(props: {
  open: boolean;
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (!props.open) return null;
  return (
    <ConfirmDialog
      title={deleteMessagesTitle(props.count)}
      message={DELETE_MESSAGES_MESSAGE}
      confirmLabel="Delete"
      busyLabel="Deleting"
      destructive
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

/** The single-message delete confirm (the action menu's Delete). */
export const DELETE_ONE_TITLE = 'Delete message?';
export const DELETE_ONE_MESSAGE = 'It is removed for everyone in this chat.';
export const DELETE_ONE_CONFIRM = 'Delete for everyone';

/**
 * The single-message delete confirm, or null when closed. Hook-free so the
 * confirm and cancel wiring are unit tested by calling the dialog's handlers.
 */
export function deleteOneConfirm(props: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (!props.open) return null;
  return (
    <ConfirmDialog
      title={DELETE_ONE_TITLE}
      message={DELETE_ONE_MESSAGE}
      confirmLabel={DELETE_ONE_CONFIRM}
      busyLabel="Deleting"
      destructive
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
