// Bottom bar for selection mode (delete own messages): the selected count, a
// 44x44 Delete that opens the confirm sheet, and Cancel. The confirm sheet runs
// the delete; on failure the proc's message shows as a toast and the selection
// is kept (the caller only clears it on success). Design tokens only.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Sheet } from '@/components/ui/Sheet';
import { IconTrash } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { deleteConfirmTitle } from '@/lib/chat/marks';

export function SelectionBar(props: {
  count: number;
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
      <IconButton
        label="Delete selected messages"
        className="text-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50"
        disabled={props.count === 0}
        onClick={() => setConfirming(true)}
      >
        <IconTrash size={20} />
      </IconButton>
      <Button variant="ghost" size="lg" onClick={props.onCancel}>
        Cancel
      </Button>
      <Sheet
        open={confirming}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
        title={deleteConfirmTitle(props.count)}
        footer={
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="lg" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="lg" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Deleting' : 'Delete'}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-fg-2">
          They will be removed from this chat for everyone. This cannot be undone.
        </p>
      </Sheet>
    </div>
  );
}
