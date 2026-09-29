import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  EMOJI_NO_RESULTS,
  EmojiGrid,
  EmojiSearchField,
  EmojiTabs,
  emojiSections,
  popoverPosition,
  searchEmoji,
} from '@/components/chat/EmojiPicker';
import { EMOJI, EMOJI_GROUPS } from '@/components/chat/emoji-data';

function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n as ReactElement<Record<string, unknown>>);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

/** Expand the hook-free EmojiButton children so their buttons show up. */
function buttons(node: ReactElement): ReactElement<Record<string, unknown>>[] {
  return all(node).flatMap((el) => {
    if (typeof el.type === 'function') {
      const rendered = (el.type as (p: unknown) => ReactElement)(el.props);
      return all(rendered).filter((e) => e.type === 'button');
    }
    return el.type === 'button' ? [el] : [];
  });
}

describe('emoji data (Unicode 15.0, generated)', () => {
  it('has fully-qualified emoji with char, name and group, no skin-tone or hair variants', () => {
    expect(EMOJI.length).toBeGreaterThan(1800);
    const chars = new Set(EMOJI.map((e) => e.char));
    expect(chars.size).toBe(EMOJI.length);
    for (const tone of ['🏻', '🏼', '🏽', '🏾', '🏿']) {
      expect(EMOJI.some((e) => e.char.includes(tone))).toBe(false);
    }
    expect(EMOJI.some((e) => /skin tone|red hair|curly hair|white hair|bald/.test(e.name))).toBe(
      false,
    );
    expect(EMOJI.find((e) => e.char === '👍')).toEqual({
      char: '👍',
      name: 'thumbs up',
      group: 'People & Body',
    });
    expect(EMOJI_GROUPS).not.toContain('Component');
  });
});

describe('searchEmoji', () => {
  it('matches the CLDR short name, every word, any case', () => {
    expect(searchEmoji('unicorn').map((e) => e.char)).toEqual(['🦄']);
    expect(searchEmoji('Tears JOY').map((e) => e.char)).toContain('😂');
    expect(searchEmoji('heart red').map((e) => e.char)).toContain('❤️');
    expect(searchEmoji('   ')).toEqual([]);
    expect(searchEmoji('zzqx')).toEqual([]);
  });
});

describe('EmojiPicker parts', () => {
  it('search on top: a real input, never under 16px on touch', () => {
    const onQuery = vi.fn();
    const field = EmojiSearchField({ query: '', onQuery, layout: 'touch' });
    const input = all(field).find((e) => e.type === 'input');
    expect(String(input?.props.className)).toContain('text-[17px]');
    (input?.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'cat' },
    });
    expect(onQuery).toHaveBeenCalledWith('cat');
  });

  it('one 44x44 tab per Unicode group; a tap goes to that group', () => {
    const onTab = vi.fn();
    const tabs = EmojiTabs({ query: '', activeGroup: 'Smileys & Emotion', onTab });
    const list = all(tabs).filter((e) => e.props.role === 'tab');
    expect(list.map((t) => t.props['aria-label'])).toEqual(emojiSections().map((s) => s.group));
    for (const t of list) expect(String(t.props.className)).toContain('h-11 w-11');
    (list[3]?.props.onClick as () => void)();
    expect(onTab).toHaveBeenCalledWith(emojiSections()[3]?.group);
  });

  it('search by name shows only the matches; a pick hands the glyph back once', () => {
    const onPick = vi.fn();
    const grid = EmojiGrid({ query: 'unicorn', onPick });
    const found = buttons(grid);
    expect(found.map((b) => b.props['aria-label'])).toEqual(['unicorn']);
    expect(String(found[0]?.props.className)).toContain('h-11 w-11');
    (found[0]?.props.onClick as () => void)();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('🦄');
  });

  it('no match: the empty line', () => {
    const grid = EmojiGrid({ query: 'zzqx', onPick: vi.fn() });
    expect(all(grid).some((e) => e.props.children === EMOJI_NO_RESULTS)).toBe(true);
  });

  it('the laptop popover sits above the menu when there is room, else below, inside the viewport', () => {
    const viewport = { width: 1280, height: 800 };
    expect(popoverPosition({ top: 600, bottom: 700, left: 100 }, viewport)).toEqual({
      top: 192,
      left: 100,
    });
    expect(popoverPosition({ top: 100, bottom: 200, left: 1200 }, viewport)).toEqual({
      top: 208,
      left: 920,
    });
  });
});
