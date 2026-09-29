import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  EMOJI_NO_RESULTS,
  EMOJI_ROW_BUFFER,
  EMOJI_ROW_PX,
  EmojiGrid,
  EmojiSearchField,
  EmojiTabs,
  EmojiVirtualGrid,
  emojiRows,
  emojiSections,
  groupAtRow,
  groupRowIndex,
  gridColumns,
  searchEmoji,
  visibleRowRange,
} from '@/components/chat/EmojiPicker';
import { EMOJI, EMOJI_GROUPS } from '@/components/chat/emoji-data';
import { popoverPosition } from '@/components/chat/MessageActionMenu';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      return buttons((el.type as (p: unknown) => ReactElement)(el.props));
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
    const grid = EmojiGrid({
      query: 'unicorn',
      onPick,
      columns: 8,
      scrollTop: 0,
      viewportHeight: 400,
    });
    const found = buttons(grid);
    expect(found.map((b) => b.props['aria-label'])).toEqual(['unicorn']);
    expect(String(found[0]?.props.className)).toContain('h-11 w-11');
    (found[0]?.props.onClick as () => void)();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('🦄');
  });

  it('no match: the empty line', () => {
    const grid = EmojiGrid({
      query: 'zzqx',
      onPick: vi.fn(),
      columns: 8,
      scrollTop: 0,
      viewportHeight: 400,
    });
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

describe('F3: the virtualized grid', () => {
  const sections = emojiSections();

  it('fixed 44px rows: a heading per group, then its glyphs in lines of the column count', () => {
    const rows = emojiRows(sections, 8);
    expect(EMOJI_ROW_PX).toBe(44);
    expect(rows[0]).toEqual({ kind: 'heading', group: 'Smileys & Emotion' });
    expect(rows[1]?.kind === 'glyphs' && rows[1].emojis.length).toBe(8);
    const glyphs = rows.flatMap((r) => (r.kind === 'glyphs' ? r.emojis : []));
    expect(glyphs).toHaveLength(EMOJI.length);
    expect(gridColumns(352)).toBe(7);
  });

  it('renders only the visible rows plus a 3-row buffer', () => {
    const rows = emojiRows(sections, 8);
    expect(rows.length).toBeGreaterThan(200);
    // 400px tall window scrolled to row 100.
    const range = visibleRowRange(100 * EMOJI_ROW_PX, 400, rows.length);
    expect(range).toEqual({ start: 100 - EMOJI_ROW_BUFFER, end: 100 + 11 + EMOJI_ROW_BUFFER });
    const grid = EmojiVirtualGrid({
      rows,
      scrollTop: 100 * EMOJI_ROW_PX,
      viewportHeight: 400,
      onPick: vi.fn(),
    });
    const rendered = all(grid).filter((e) => e.props['data-emoji-row'] !== undefined);
    expect(rendered).toHaveLength(range.end - range.start);
    expect(rendered[0]?.props['data-emoji-row']).toBe(97);
    // The spacer is as tall as every row, so the scrollbar is true.
    expect((grid.props.style as { height: number }).height).toBe(rows.length * EMOJI_ROW_PX);
    // The top of the list: no negative rows.
    expect(visibleRowRange(0, 400, rows.length).start).toBe(0);
  });

  it('a group tab jumps by row index; the tab follows the group at the top', () => {
    const rows = emojiRows(sections, 8);
    const index = groupRowIndex(rows);
    const flags = index.get('Flags') ?? -1;
    expect(rows[flags]).toEqual({ kind: 'heading', group: 'Flags' });
    expect(groupAtRow(rows, flags)).toBe('Flags');
    expect(groupAtRow(rows, flags - 1)).not.toBe('Flags');
  });
});

describe('F3: EmojiPicker and emoji-data are not in the main chunk', () => {
  // Walk the static import graph from the app entry; dynamic import() edges
  // are chunk boundaries and are not followed.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  function resolve(from: string, spec: string): string | null {
    const base = spec.startsWith('@/')
      ? join(root, spec.slice(2))
      : spec.startsWith('.')
        ? join(dirname(from), spec)
        : null;
    if (base === null) return null;
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(base + ext) && !base.endsWith('/') && (ext !== '' || /\.tsx?$/.test(base))) {
        return base + ext;
      }
    }
    return null;
  }
  function staticGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    const importRe =
      /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importRe)) {
        if (/^\s*(?:import|export)\s+type\s/.test(match[0].trim())) continue;
        const next = resolve(file, match[1] ?? '');
        if (next !== null) queue.push(next);
      }
    }
    return seen;
  }

  it('the app entry reaches the menu statically but never the picker body or its data', () => {
    const graph = staticGraph(join(root, 'main.tsx'));
    expect(graph.has(join(root, 'components/chat/MessageActionMenu.tsx'))).toBe(true);
    expect(graph.has(join(root, 'components/chat/EmojiPicker.tsx'))).toBe(false);
    expect(graph.has(join(root, 'components/chat/emoji-data.ts'))).toBe(false);
  });

  it('the menu loads the picker through a dynamic import()', () => {
    const menu = readFileSync(join(root, 'components/chat/MessageActionMenu.tsx'), 'utf8');
    expect(menu).toContain("import('@/components/chat/EmojiPicker')");
  });
});

describe('F15: the emoji data generator is typechecked and linted', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));

  it('tests/etl/tsconfig.json (run by the ETL CI typecheck on every PR) includes the script', () => {
    const config = JSON.parse(readFileSync(join(repo, 'tests/etl/tsconfig.json'), 'utf8')) as {
      include: string[];
    };
    expect(config.include).toContain('../../scripts/gen-emoji-data.ts');
  });

  it('the eslint config lints every .ts file and does not ignore scripts/', () => {
    const eslint = readFileSync(join(repo, 'eslint.config.js'), 'utf8');
    expect(eslint).toContain("files: ['**/*.{ts,tsx}']");
    expect(eslint).not.toMatch(/ignores:[^\]]*scripts/);
  });
});
