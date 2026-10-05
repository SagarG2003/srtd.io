// The composer's plus button and its tray (replaces the paperclip). The button
// is a 44x44 circle on the panel; while the tray is open it turns accent and
// its plus rotates 45deg into an X (rotate only). The tray sits above the
// composer: a 4-column grid of tiles (Photos, File, Post, Schedule on touch
// and laptop alike) that slides on translateY and fades, 180ms, no X and no
// scale. A tap outside, Escape, or picking a tile closes it. Photos / File /
// Post run the composer's existing attach paths (the Photos picker still
// offers Take Photo on phones); Schedule opens the Schedule sheet. Tokens
// only, so light and dark stay at parity.

import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import {
  IconCalendarClock,
  IconFile,
  IconImage,
  IconPipeline,
  IconPlus,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT, type ChatLayout } from '@/components/chat/chat-type';

/** The tray and the plus icon move for this long. */
export const TRAY_MOTION_MS = 180;

type TileIcon = ComponentType<{ size?: number; className?: string }>;

/** One tray tile. */
export interface TrayTile {
  id: 'photos' | 'file' | 'post' | 'schedule';
  label: string;
  Icon: TileIcon;
}

/**
 * The tiles: the same four on touch and laptop, Schedule last. A chat that
 * cannot schedule (Personal notes) leaves Schedule out. Pure.
 */
export function trayTiles(layout: ChatLayout, opts: { schedule?: boolean } = {}): TrayTile[] {
  void layout;
  const tiles: TrayTile[] = [
    { id: 'photos', label: 'Photos', Icon: IconImage },
    { id: 'file', label: 'File', Icon: IconFile },
    { id: 'post', label: 'Post', Icon: IconPipeline },
  ];
  if (opts.schedule !== false) {
    tiles.push({ id: 'schedule', label: 'Schedule', Icon: IconCalendarClock });
  }
  return tiles;
}

export function ComposerTray(props: {
  layout: ChatLayout;
  onPick: (id: TrayTile['id']) => void;
  /** False: the chat cannot schedule, so no Schedule tile. Absent is true. */
  schedule?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Kept mounted through the exit; `shown` drives the transition.
  const [rendered, setRendered] = useState(false);
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = setTimeout(() => setRendered(false), TRAY_MOTION_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: Event): void {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tiles = trayTiles(props.layout, { schedule: props.schedule !== false });
  return (
    <div ref={rootRef} className={cn('shrink-0', NO_TOUCH_SELECT)} onContextMenu={preventDefault}>
      <button
        ref={buttonRef}
        type="button"
        data-plus=""
        aria-label={open ? 'Close attachments' : 'Add attachment'}
        aria-expanded={open}
        aria-controls="composer-tray"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full border transition-colors duration-[180ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          open
            ? 'border-accent bg-accent text-accent-fg'
            : 'border-border bg-panel text-fg-2 hover:text-fg',
        )}
      >
        <span
          aria-hidden="true"
          data-plus-icon=""
          className={cn(
            'flex transition-transform duration-[180ms] ease-out motion-reduce:transition-none',
            open && 'rotate-45',
          )}
        >
          <IconPlus size={22} />
        </span>
      </button>
      {rendered ? (
        <div
          id="composer-tray"
          role="group"
          aria-label="Attach"
          data-tray=""
          className={cn(
            'absolute inset-x-0 bottom-full z-20 border-t border-border bg-panel px-3 pb-2 pt-3 transition-[opacity,transform] duration-[180ms] ease-out motion-reduce:transition-none',
            shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
          )}
        >
          <div className="grid grid-cols-4 gap-2">
            {tiles.map((tile) => (
              <button
                key={tile.id}
                type="button"
                data-tray-tile={tile.id}
                onClick={() => {
                  setOpen(false);
                  props.onPick(tile.id);
                }}
                className="flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg text-fg-2 hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-panel-2 text-fg">
                  <tile.Icon size={22} />
                </span>
                <span className="text-xs font-medium">{tile.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function preventDefault(event: { preventDefault: () => void }): void {
  event.preventDefault();
}
