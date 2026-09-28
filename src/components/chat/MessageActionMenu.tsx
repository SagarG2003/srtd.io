import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ActionRow } from '@/components/ui';
import { IconCheck, IconCopy, IconForward, IconPin, IconReply } from '@/components/ui/icons';
import { popoverClass } from '@/components/ui/popover-classes';
import { markMenuLabel, type MarkType } from '@/lib/chat/marks';
import { cn } from '@/lib/cn';

/** Quick-react row offered when a message's action menu is opened. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🆗', '🙏'] as const;

interface MessageActionMenuProps {
  open: boolean;
  onClose: () => void;
  anchor: DOMRect | null;
  mine: boolean;
  currentReaction: string | null;
  canCopy: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  /** "Mark as ..." options for this message; empty for a marked (frozen) one. */
  markOptions?: readonly MarkType[];
  onMark?: (type: MarkType) => void;
  /** Offers "Forward" (a recorded message, anyone's). */
  canForward?: boolean;
  onForward?: () => void;
  /** Offers "Select" (multi-select forward and delete). */
  canSelect?: boolean;
  onSelect?: () => void;
}

/** One row of the message action menu. */
export interface MessageMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * The action rows in display order: Reply, Forward, the "Mark as ..." items,
 * Select, Copy. Pure (no hooks) so the order is unit-tested without a DOM.
 */
export function messageMenuItems(
  props: Pick<
    MessageActionMenuProps,
    | 'canCopy'
    | 'onReply'
    | 'onCopy'
    | 'markOptions'
    | 'onMark'
    | 'canForward'
    | 'onForward'
    | 'canSelect'
    | 'onSelect'
  >,
): MessageMenuItem[] {
  const items: MessageMenuItem[] = [
    { key: 'reply', label: 'Reply', icon: <IconReply />, run: props.onReply },
  ];
  if (props.canForward === true) {
    items.push({
      key: 'forward',
      label: 'Forward',
      icon: <IconForward />,
      run: () => props.onForward?.(),
    });
  }
  for (const type of props.markOptions ?? []) {
    items.push({
      key: `mark-${type}`,
      label: markMenuLabel(type),
      icon: <IconPin />,
      run: () => props.onMark?.(type),
    });
  }
  if (props.canSelect === true) {
    items.push({
      key: 'select',
      label: 'Select',
      icon: <IconCheck />,
      run: () => props.onSelect?.(),
    });
  }
  if (props.canCopy) {
    items.push({ key: 'copy', label: 'Copy', icon: <IconCopy />, run: props.onCopy });
  }
  return items;
}

/** Whether a keydown while the menu is open closes it. */
export function menuClosesOnKey(key: string): boolean {
  return key === 'Escape';
}

/** Anything that can find the menu's first action row (the menu container). */
interface MenuRoot {
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null;
}

/**
 * Move focus to the first action row (Reply) so keyboard users land in the
 * menu; Tab then walks the rows in display order. preventScroll keeps the
 * menu's own scroll-to-close listener from firing.
 */
export function focusFirstMenuItem(root: MenuRoot | null): boolean {
  const first = root?.querySelector('[data-menu-items] button') ?? null;
  if (first === null) return false;
  first.focus({ preventScroll: true });
  return true;
}

interface Coords {
  top: number;
  left: number;
}

/**
 * Floating, anchored action menu opened by long-press (touch), right-click, the
 * hover ⋯ control (pointer devices) or Enter / Space on a focused bubble. It
 * focuses the first action row on open and hands focus back to whatever held
 * it (the bubble or the ⋯ button) on close. Renders into document.body via a portal (mirrors Sheet.tsx)
 * so it escapes the scrolling thread. Position is computed from the pressed
 * bubble's rect in a two-pass layout effect: the container is measured while
 * hidden, then placed above (or below when there is no room) and aligned to the
 * bubble's side. Closes on backdrop click, Escape, scroll, or resize. All
 * colours are design tokens, so light and dark stay at parity.
 */
export function MessageActionMenu(props: MessageActionMenuProps): ReactElement | null {
  const { open, onClose, anchor, mine, currentReaction, onReact } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    if (!open || anchor === null) {
      setCoords(null);
      return;
    }
    const el = containerRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    let top = anchor.top - height - 8;
    if (top < 8) {
      top = Math.min(anchor.bottom + 8, window.innerHeight - height - 8);
    }
    const rawLeft = mine ? anchor.right - width : anchor.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - width - 8));
    setCoords({ top, left });
  }, [open, anchor, mine]);

  // Entrance motion: flip to the shown state after the menu mounts so the
  // opacity + scale transition runs (no translate, no rotate).
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Coords land after the measuring pass; focus the first row once placed.
  const placed = coords !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const previous = document.activeElement;
    focusFirstMenuItem(containerRef.current);
    return () => {
      // Only when nothing else took focus (Reply may focus the composer).
      const current = document.activeElement;
      const idle = current === null || current === document.body;
      if (idle && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (menuClosesOnKey(event.key)) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose]);

  if (!open || anchor === null) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={containerRef}
        className={cn(
          'fixed z-50 flex flex-col gap-2 transition-[opacity,transform] duration-fast',
          mine ? 'items-end origin-bottom-right' : 'items-start origin-bottom-left',
          shown ? 'scale-100 opacity-100 ease-enter' : 'scale-[0.96] opacity-0 ease-exit',
        )}
        style={{
          top: coords?.top ?? 0,
          left: coords?.left ?? 0,
          visibility: coords === null ? 'hidden' : 'visible',
        }}
      >
        <div className="inline-flex gap-1 rounded-full border border-border-strong bg-panel p-1 shadow-2xl">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                onReact(emoji);
                onClose();
              }}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-panel-2',
                emoji === currentReaction && 'bg-accent-soft',
              )}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
        <div
          role="menu"
          aria-label="Message actions"
          data-menu-items=""
          className={cn('min-w-[200px]', popoverClass(true))}
        >
          {messageMenuItems(props).map((item) => (
            <ActionRow
              key={item.key}
              icon={item.icon}
              label={item.label}
              onClick={() => {
                item.run();
                onClose();
              }}
            />
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}
