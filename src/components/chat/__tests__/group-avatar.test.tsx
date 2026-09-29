import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { Database } from '@srtdio/schemas';
import { shapeChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import { channelRowBody, GROUP_TILE_PHOTO } from '@/components/chat/ChannelList';
import {
  groupInfoSections,
  groupInfoSubtitle,
  groupPhotoOptions,
} from '@/components/chat/GroupInfoSheet';
import { centerSquare, GROUP_AVATAR_EXPORT_PX } from '@/lib/chat/group-avatar';

type ChannelRow = Database['public']['Tables']['chat_channels']['Row'];
type GroupRow = Database['public']['Tables']['groups']['Row'];
type UserRow = Database['public']['Tables']['users']['Row'];

const ME = 'u-me';
const PHOTO = 'https://cdn.srtd.io/groups/g-photo/abc.png';
const PEER_PHOTO = 'https://cdn.srtd.io/u-peer/def.png';

function channel(over: Partial<ChannelRow>): ChannelRow {
  return {
    channel_id: 'c',
    channel_type: 'group',
    entity_id: null,
    agora_group_id: null,
    dm_user_a: null,
    dm_user_b: null,
    created_at: '2026-09-29T00:00:00Z',
    ...over,
  } as ChannelRow;
}

const groups = new Map<string, GroupRow>([
  ['g-photo', { id: 'g-photo', name: 'Launch', avatar_url: PHOTO, created_by: ME } as GroupRow],
  ['g-plain', { id: 'g-plain', name: 'Ops', avatar_url: null, created_by: 'u-x' } as GroupRow],
]);
const users = new Map<string, UserRow>([
  [
    'u-peer',
    { id: 'u-peer', display_name: 'Asha Rao', avatar_url: PEER_PHOTO } as unknown as UserRow,
  ],
]);

const [withPhoto, withoutPhoto, dm] = shapeChannelSummaries(
  [
    channel({ channel_id: 'c1', entity_id: 'g-photo' }),
    channel({ channel_id: 'c2', entity_id: 'g-plain' }),
    channel({ channel_id: 'c3', channel_type: 'dm', dm_user_a: ME, dm_user_b: 'u-peer' }),
  ],
  groups,
  users,
  ME,
) as [ChannelSummary, ChannelSummary, ChannelSummary];

function rowHtml(summary: ChannelSummary): string {
  return renderToStaticMarkup(
    channelRowBody({
      channel: summary,
      summary: undefined,
      nowMs: Date.parse('2026-09-29T10:00:00Z'),
      timeZone: 'UTC',
      selecting: false,
      checked: false,
    }),
  );
}

describe('chat home tile avatar resolution (one batched list read, no per-row fetch)', () => {
  it('a group with avatar_url resolves entity_id -> groups.avatar_url and paints the photo first', () => {
    expect(withPhoto.avatarUrl).toBe(PHOTO);
    expect(withPhoto.createdBy).toBe(ME);
    const html = rowHtml(withPhoto);
    expect(html).toContain(`src="${PHOTO}"`);
    // First paint is the photo: no initials fallback rendered alongside it.
    expect(html).not.toContain('>LA<');
    // A group is a wide tile: a 72px rounded-square photo.
    expect(html).toContain(
      `data-group-photo="" class="${GROUP_TILE_PHOTO.replaceAll('&', '&amp;').replaceAll('>', '&gt;')}"`,
    );
  });

  it('a group without avatar_url falls back to the shared initials avatar', () => {
    expect(withoutPhoto.avatarUrl).toBeNull();
    const html = rowHtml(withoutPhoto);
    expect(html).not.toContain('<img');
    expect(html).toContain('>O<');
    expect(html).toContain(
      `data-group-photo="" class="${GROUP_TILE_PHOTO.replaceAll('&', '&amp;').replaceAll('>', '&gt;')}"`,
    );
  });

  it("a DM channel still resolves the peer's users.avatar_url", () => {
    expect(dm.channelType).toBe('dm');
    expect(dm.avatarUrl).toBe(PEER_PHOTO);
    const html = rowHtml(dm);
    expect(html).toContain(`src="${PEER_PHOTO}"`);
    // A DM is a square tile: a 48px circular avatar.
    expect(html).toContain('width:48px;height:48px');
    expect(html).toContain('rounded-full');
  });
});

describe('group info sheet pure helpers', () => {
  it('hides PHOTO and NAME for a plain member; shows them for an editor', () => {
    expect(groupInfoSections(false)).toEqual(['members']);
    expect(groupInfoSections(true)).toEqual(['photo', 'name', 'members']);
  });

  it('offers Remove photo only when a photo is set', () => {
    expect(groupPhotoOptions(false)).toEqual(['camera', 'library']);
    expect(groupPhotoOptions(true)).toEqual(['camera', 'library', 'remove']);
  });

  it('reads "Group · n members · workspace"', () => {
    expect(groupInfoSubtitle(4, 'Acme')).toBe('Group · 4 members · Acme');
    expect(groupInfoSubtitle(1, 'Acme')).toBe('Group · 1 member · Acme');
    expect(groupInfoSubtitle(null, undefined)).toBe('Group');
  });

  it('crops the largest centred square, exported at the user avatar size', () => {
    expect(centerSquare(800, 600)).toEqual({ sx: 100, sy: 0, side: 600 });
    expect(centerSquare(600, 900)).toEqual({ sx: 0, sy: 150, side: 600 });
    expect(GROUP_AVATAR_EXPORT_PX).toBe(512);
  });
});
