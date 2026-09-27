import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { MarkBadge } from '@/components/chat/MarkBits';
import type { ChatMark } from '@/lib/chat/marks';

// MarkBadge is hook-free, so its returned element is inspected directly with
// no DOM, as MessageThread.test.tsx does for MessageBubble.
function mark(over: Partial<ChatMark>): ChatMark {
  return {
    messageId: 'm1',
    channelId: 'c1',
    type: 'commitment',
    priority: null,
    markedAt: 't',
    resolved: false,
    ...over,
  };
}

function render(m: ChatMark | undefined, onChangePriority = vi.fn()): ReactElement {
  return MarkBadge({ mark: m, onChangePriority });
}

describe('MarkBadge', () => {
  it('frozen marks render a plain label with no action', () => {
    for (const type of ['commitment', 'decision'] as const) {
      const el = render(mark({ type }));
      expect(el.type).toBe('span');
      expect((el.props as { children: string }).children).toBe(
        type === 'commitment' ? 'Commitment' : 'Decision',
      );
    }
  });

  it('an open pending badge is a button that opens the priority chooser', () => {
    const onChangePriority = vi.fn();
    const el = render(mark({ type: 'pending', priority: 1 }), onChangePriority);
    expect(el.type).toBe('button');
    const props = el.props as {
      children: string;
      className: string;
      onClick: (e: { stopPropagation: () => void }) => void;
    };
    expect(props.children).toBe('Pending P1');
    // The hit area reaches 44x44 around the small pill.
    expect(props.className).toContain('min-w-[44px]');
    expect(props.className).toContain('after:-inset-y-3');
    props.onClick({ stopPropagation: vi.fn() });
    expect(onChangePriority).toHaveBeenCalledOnce();
  });

  it('renders nothing for no mark and for a resolved pending', () => {
    for (const m of [undefined, mark({ type: 'pending', resolved: true })]) {
      const el = render(m);
      expect(isValidElement(el)).toBe(true);
      expect((el.props as { children?: unknown }).children).toBeUndefined();
    }
  });
});
