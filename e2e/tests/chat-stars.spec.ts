import { expect, test, type Page, type Route } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { ME, PEER_NAME, WORKSPACE_ID } from '../fixtures/chat-data';
import type { Row, Tables } from '../fixtures/postgrest';

// Message stars: long-press Star puts a star on the bubble, the header's
// Starred sheet lists it and a tap jumps to it, the chat home's Starred chip
// and the Contact sheet's Starred tab list it, and Unstar from Edit takes it
// out of all three. Linux WebKit approximates iOS WebKit; it is not iOS.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PEER_LINE = 'Can we tighten the hook on slide one?';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

/** The two star procs over the harness tables, as the migration defines them. */
function starProcs(tables: Tables): Record<string, (args: Record<string, unknown>) => unknown> {
  const stars = (tables.chat_message_stars ??= []);
  const messages = (): Row[] => tables.chat_messages ?? [];
  return {
    chat_message_star_set: (args) => {
      const ids = Array.isArray(args.p_message_ids) ? args.p_message_ids.map(String) : [];
      if (args.p_starred === true) {
        for (const m of messages()) {
          if (!ids.includes(String(m.id)) || m.channel_id !== args.p_channel_id) continue;
          if (stars.some((s) => s.message_id === m.id)) continue;
          stars.push({
            user_id: ME,
            message_id: m.id,
            message_created_at: m.created_at,
            channel_id: m.channel_id,
            workspace_id: WORKSPACE_ID,
            starred_at: new Date().toISOString(),
          });
        }
      } else {
        for (let i = stars.length - 1; i >= 0; i -= 1) {
          const s = stars[i];
          if (s && s.channel_id === args.p_channel_id && ids.includes(String(s.message_id)))
            stars.splice(i, 1);
        }
      }
      return null;
    },
    chat_message_starred_list: (args) => {
      const query = String(args.p_query ?? '').trim();
      const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
      const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
      const beforeAt =
        typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
      const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
      const starred = new Set(
        stars
          .filter((s) => args.p_channel_id == null || s.channel_id === args.p_channel_id)
          .map((s) => String(s.message_id)),
      );
      return messages()
        .filter((m) => starred.has(String(m.id)) && m.deleted_at === null)
        .filter((m) => {
          if (query === '') return true;
          if (query.length < 2 || query.length > 100) return false;
          const tokens =
            String(m.body ?? '')
              .toLowerCase()
              .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
          return words.every((w) => tokens.some((t) => t.startsWith(w)));
        })
        .sort(
          (a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)) ||
            String(b.id).localeCompare(String(a.id)),
        )
        .filter((m) => {
          if (beforeAt === null) return true;
          const at = String(m.created_at);
          return at < beforeAt || (at === beforeAt && beforeId !== null && String(m.id) < beforeId);
        })
        .slice(0, limit);
    },
  };
}

async function installStars(page: Page): Promise<Array<Record<string, unknown>>> {
  const { world } = await installHarnessNetwork(page);
  const procs = starProcs(world.tables);
  const calls: Array<Record<string, unknown>> = [];
  // Registered after the harness, so these answer first.
  await page.route(/\/rest\/v1\/rpc\/chat_message_star(_set|red_list)/, async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    const args = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ name, ...args });
    const proc = procs[name];
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(proc ? proc(args) : null),
    });
  });
  return calls;
}

/** Hold a bubble like a finger: pointerdown, 700ms still, pointerup. */
async function holdBubble(page: Page, text: string): Promise<void> {
  const bubble = page.locator('[data-bubble]', { hasText: text }).last();
  await bubble.scrollIntoViewIfNeeded();
  const box = await bubble.boundingBox();
  if (box === null) throw new Error('bubble has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await bubble.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(700);
  await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
}

/** No iOS callout and no text selection on a long-press target. */
async function noCallout(page: Page, selector: string): Promise<void> {
  const touch = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string };
      return { callout: style.webkitTouchCallout ?? 'none', select: style.webkitUserSelect };
    });
  expect(touch.callout).toBe('none');
  expect(touch.select).toBe('none');
}

async function openDm(page: Page): Promise<void> {
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-bubble]', { hasText: PEER_LINE }).last().waitFor({ state: 'visible' });
}

test('chat stars: star, list everywhere, jump, unstar from Edit', async ({ page }, testInfo) => {
  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: testInfo.outputPath(`stars-${name}.png`) });
  };
  const calls = await installStars(page);
  await page.goto('/chat');
  await openDm(page);

  // Long-press: Star sits after Copy and before Save to notes.
  await holdBubble(page, PEER_LINE);
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const keys = await menu
    .locator('[data-menu-item]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-menu-item')));
  expect(keys.indexOf('star')).toBe(keys.indexOf('copy') + 1);
  expect(keys.indexOf('save-notes')).toBe(keys.indexOf('star') + 1);
  await expect(menu.locator('[data-menu-item="star"]')).toHaveText(/Star/);
  await noCallout(page, '[data-bubble]');
  await shot('1-menu');
  await menu.locator('[data-menu-item="star"]').click();

  // The bubble carries the star at once; one write with a uuid_v7 trace.
  const bubble = page.locator('[data-bubble]', { hasText: PEER_LINE }).last();
  await expect(bubble.locator('[data-meta-star]')).toBeVisible();
  await expect.poll(() => calls.filter((c) => c.name === 'chat_message_star_set').length).toBe(1);
  const set = calls.find((c) => c.name === 'chat_message_star_set') ?? {};
  expect(set.p_starred).toBe(true);
  expect(String(set.p_trace_id)).toMatch(UUID_V7);
  for (const key of Object.keys(set)) if (key !== 'name') expect(key.startsWith('p_')).toBe(true);
  await shot('2-bubble-star');

  // The menu now offers Unstar.
  await holdBubble(page, PEER_LINE);
  await expect(page.getByRole('menu').locator('[data-menu-item="star"]')).toHaveText(/Unstar/);
  await page.keyboard.press('Escape');

  // Header star: the sheet lists it; a tap closes the sheet and jumps to it.
  await page.getByRole('button', { name: 'Starred messages' }).click();
  const sheet = page.locator('[data-starred-sheet]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-starred-chat-name]')).toHaveText(PEER_NAME);
  const sheetRow = sheet.locator('[data-starred-row]', { hasText: PEER_LINE });
  await expect(sheetRow).toBeVisible();
  await noCallout(page, '[data-starred-row]');
  await shot('3-header-sheet');
  await sheetRow.click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-bubble].ring-2', { hasText: PEER_LINE })).toBeVisible();
  await shot('4-jumped');

  // Contact sheet: the Starred tab lists it.
  await page.locator('[data-contact-open]').click();
  await page.getByRole('button', { name: 'Starred', exact: true }).click();
  const tab = page.locator('[data-starred-tab]');
  await expect(tab.locator('[data-starred-row]', { hasText: PEER_LINE })).toBeVisible();
  await shot('5-contact-tab');
  await page.getByRole('button', { name: 'Close contact info' }).click();

  // Chat home: the Starred chip is first and lists it in place of the chats.
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  const chips = await page
    .locator('[data-search-chip]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-search-chip')));
  expect(chips).toEqual(['starred', 'photo', 'link', 'file', 'voice']);
  await page.locator('[data-search-chip="starred"]').click();
  const home = page.locator('[data-starred-home]');
  await expect(home.locator('[data-starred-row]', { hasText: PEER_LINE })).toBeVisible();
  await expect(page.locator('[data-notes-tile]')).toHaveCount(0);
  await shot('6-home-starred');

  // Edit, select it, Unstar (1): gone from the home list.
  await home.locator('[data-starred-edit="edit"]').click();
  await home.locator('[data-starred-row]', { hasText: PEER_LINE }).click();
  await page.locator('[data-starred-unstar]').click();
  await expect(home.locator('[data-starred-row]')).toHaveCount(0);
  await expect(home.locator('[data-starred-empty]')).toBeVisible();
  const unset = calls.filter((c) => c.name === 'chat_message_star_set').pop() ?? {};
  expect(unset.p_starred).toBe(false);
  await shot('7-home-unstarred');

  // ...and from the bubble, the header sheet and the Contact tab.
  await page.locator('[data-search-chip="starred"]').click();
  await openDm(page);
  await expect(
    page.locator('[data-bubble]', { hasText: PEER_LINE }).last().locator('[data-meta-star]'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Starred messages' }).click();
  await expect(page.locator('[data-starred-sheet] [data-starred-empty]')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('[data-contact-open]').click();
  await page.getByRole('button', { name: 'Starred', exact: true }).click();
  await expect(page.locator('[data-starred-tab] [data-starred-empty]')).toBeVisible();
  await shot('8-all-clear');
});
