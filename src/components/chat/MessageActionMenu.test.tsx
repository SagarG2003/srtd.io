import { describe, expect, it, vi } from 'vitest';
import { QUICK_REACTIONS, messageMenuItems } from '@/components/chat/MessageActionMenu';

function labels(over: Partial<Parameters<typeof messageMenuItems>[0]> = {}): string[] {
  return messageMenuItems({
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    markOptions: ['commitment', 'decision'],
    onMark: () => {},
    canForward: true,
    onForward: () => {},
    canSelect: true,
    onSelect: () => {},
    ...over,
  }).map((item) => item.label);
}

describe('messageMenuItems', () => {
  it('puts Forward second, after Reply and before the mark items', () => {
    const list = labels();
    expect(list[0]).toBe('Reply');
    expect(list[1]).toBe('Forward');
    expect(list.slice(-2)).toEqual(['Select', 'Copy']);
    expect(list).toHaveLength(6);
  });

  it('hides Forward for a message that cannot be forwarded', () => {
    expect(labels({ canForward: false })).not.toContain('Forward');
  });

  it('runs the forward handler', () => {
    const onForward = vi.fn();
    const items = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canForward: true,
      onForward,
    });
    items.find((i) => i.key === 'forward')?.run();
    expect(onForward).toHaveBeenCalledTimes(1);
  });
});

describe('QUICK_REACTIONS', () => {
  it('is exactly the approved quick-react set, in order', () => {
    expect([...QUICK_REACTIONS]).toEqual(['👍', '❤️', '😂', '🆗', '🙏']);
  });
});
