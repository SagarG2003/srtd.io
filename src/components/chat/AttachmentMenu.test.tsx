import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ActionRow } from '@/components/ui';
import { attachmentMenuRows } from '@/components/chat/AttachmentMenu';
import { attachmentMenuItems } from '@/lib/chat/attachment-menu';

function items(onPickPhoto = vi.fn()) {
  return attachmentMenuItems({ onPickPhoto, onPickFile: vi.fn(), onSharePost: vi.fn() });
}

function rowOf(wrapper: ReactElement): ReactElement {
  return (wrapper.props as { children: ReactElement }).children;
}

describe('attachmentMenuRows', () => {
  it('renders every config item as a shared ActionRow inside a menuitem, in config order', () => {
    const list = items();
    const rows = attachmentMenuRows(list, () => {});
    expect(rows).toHaveLength(list.length);
    rows.forEach((wrapper, i) => {
      expect((wrapper.props as { role: string }).role).toBe('menuitem');
      const row = rowOf(wrapper);
      expect(row.type).toBe(ActionRow);
      expect((row.props as { label: string }).label).toBe(list[i]!.label);
    });
  });

  it('runs the item handler then closes the menu', () => {
    const onPickPhoto = vi.fn();
    const onClose = vi.fn();
    const rows = attachmentMenuRows(items(onPickPhoto), onClose);
    (rowOf(rows[0]!).props as { onClick: () => void }).onClick();
    expect(onPickPhoto).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
