import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComposerTray, trayTiles } from '@/components/chat/ComposerTray';
import { ComposerEmoji, showsEmojiButton } from '@/components/chat/ComposerEmoji';
import {
  LatestButton,
  ReadByLine,
  SeenLine,
  sentLine,
  UnreadDivider,
  UnreadPill,
} from '@/components/chat/ReadingLayer';
import { chatLayout } from '@/components/chat/chat-type';

const EM_DASH = String.fromCharCode(0x2014);

describe('T8 tray and emoji button by pointer', () => {
  it('Schedule replaces Camera and shows last on touch and laptop', () => {
    const laptop = chatLayout({ finePointer: true, widthPx: 1280 });
    const touch = chatLayout({ finePointer: false, widthPx: 390 });
    expect(trayTiles(laptop).map((t) => t.id)).toEqual(['photos', 'file', 'post', 'schedule']);
    expect(trayTiles(touch).map((t) => t.id)).toEqual(['photos', 'file', 'post', 'schedule']);
    expect(trayTiles(touch).map((t) => t.label)).toEqual(['Photos', 'File', 'Post', 'Schedule']);
  });

  it('the emoji button is hidden on a coarse pointer (touch, any width)', () => {
    expect(showsEmojiButton(chatLayout({ finePointer: false, widthPx: 1024 }))).toBe(false);
    expect(showsEmojiButton(chatLayout({ finePointer: true, widthPx: 1280 }))).toBe(true);
  });

  it('the composer gates the emoji button on that rule', () => {
    const src = readFileSync(fileURLToPath(new URL('../Composer.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('showsEmojiButton(layout)');
    expect(src).not.toContain('IconPaperclip');
  });

  it('the plus button is a 44x44 circle, collapsed tray not rendered', () => {
    const html = renderToStaticMarkup(<ComposerTray layout="touch" onPick={() => undefined} />);
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('rounded-full');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-tray=""');
  });

  it('the emoji popover is closed until pressed', () => {
    const html = renderToStaticMarkup(<ComposerEmoji onPick={() => undefined} />);
    expect(html).toContain('data-emoji-button');
    expect(html).not.toContain('data-emoji-popover');
  });
});

describe('reading layer elements', () => {
  it('divider and pill read "N unread" with mono digits', () => {
    const divider = renderToStaticMarkup(<UnreadDivider count={5} />);
    expect(divider).toContain('font-mono');
    expect(divider).toContain('5 unread');
    const pill = renderToStaticMarkup(<UnreadPill count={5} visible onJump={() => undefined} />);
    expect(pill).toContain('h-11');
    expect(pill).toContain('font-mono');
    expect(pill).toContain('bg-panel');
    expect(pill).toContain('border-border');
  });

  it('latest button is 44px, solid panel, with a count badge', () => {
    const html = renderToStaticMarkup(<LatestButton visible count={3} onTap={() => undefined} />);
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('data-latest-count');
    const none = renderToStaticMarkup(
      <LatestButton visible={false} count={0} onTap={() => undefined} />,
    );
    expect(none).toContain('opacity-0');
    expect(none).not.toContain('data-latest-count');
  });

  it('Seen line is 11/15 muted with a mono time', () => {
    const html = renderToStaticMarkup(
      <SeenLine lastReadAt="2026-10-02T10:05:00Z" timeZone="UTC" />,
    );
    expect(html).toContain('text-[11px] leading-[15px]');
    expect(html).toContain('Seen');
    expect(html).toContain('font-mono');
  });

  it('Read by line is a real button with a 44px hit area', () => {
    const html = renderToStaticMarkup(
      <ReadByLine label="Read by 2 of 5" onOpen={() => undefined} />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('h-11');
  });

  it('sent line reads "Sent <day> at <time>", no em-dashes', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const line = sentLine('2026-10-02T10:05:00Z', 'UTC', now);
    expect(line.startsWith('Sent Today at ')).toBe(true);
    expect(line).not.toContain(EM_DASH);
  });
});

describe('first paint final', () => {
  it('the first page waits for the read cursors, so receipts never pop in after', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../MessageThread.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("props.readState?.status === 'loading'");
  });
});

describe('T9 token hygiene', () => {
  it('the new chat files carry no hex or theme-variant literals', () => {
    for (const name of [
      'ReadingLayer.tsx',
      'ComposerTray.tsx',
      'ComposerEmoji.tsx',
      'ChatTabSignals.tsx',
    ]) {
      const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
      expect(src.includes(String.fromCharCode(35))).toBe(false);
      expect(src.includes(['dark', ':'].join(''))).toBe(false);
    }
  });
});

// Regression (iPhone, 3 Oct): a backdrop-filter layer (the jump pill and the
// always-mounted scroll-to-latest button) over the thread's scroll container
// left the message area unpainted on iOS WebKit, showing stale composer tiles.
// The floating surfaces are solid panel now; no chat surface may blur again.
describe('T1 no backdrop-filter over the thread (iOS WebKit paint)', () => {
  const BLUR = ['backdrop', '-blur'].join('');
  const SUPPORTS = ['supports-[', 'backdrop'].join('');
  const FILTER_CSS = ['backdrop', '-filter:'].join('');

  it('the pill and the latest button render without any backdrop class', () => {
    for (const html of [
      renderToStaticMarkup(<UnreadPill count={2} visible onJump={() => undefined} />),
      renderToStaticMarkup(<UnreadPill count={2} visible={false} onJump={() => undefined} />),
      renderToStaticMarkup(<LatestButton visible count={1} onTap={() => undefined} />),
      renderToStaticMarkup(<LatestButton visible={false} count={0} onTap={() => undefined} />),
    ]) {
      expect(html).not.toContain('backdrop');
      expect(html).toContain('bg-panel');
    }
  });

  it('no chat component or the thread uses a backdrop blur or filter', () => {
    for (const name of [
      'ReadingLayer.tsx',
      'MessageThread.tsx',
      'Composer.tsx',
      'ComposerTray.tsx',
    ]) {
      const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
      expect(src.includes(BLUR)).toBe(false);
      expect(src.includes(SUPPORTS)).toBe(false);
      expect(src.includes(FILTER_CSS)).toBe(false);
    }
  });

  it('the glass token is gone from the token file', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    expect(css.includes('--glass')).toBe(false);
  });
});
