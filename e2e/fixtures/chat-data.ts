// Fixture world for the chat harness: one workspace, the signed-in user, a DM
// peer, two group colleagues, one DM and one group with ~40 messages each
// (text, a photo album, a shared post card, a voice note), posts waiting in
// review for the open-loops strip, and read cursors so the DM shows "Seen".

import type { Row, Tables } from './postgrest';

export const WORKSPACE_ID = '0190a000-0000-7000-8000-00000000a001';
export const ME = '0190a000-0000-7000-8000-000000000001';
export const PEER = '0190a000-0000-7000-8000-000000000002';
export const COLLEAGUE_A = '0190a000-0000-7000-8000-000000000003';
export const COLLEAGUE_B = '0190a000-0000-7000-8000-000000000004';
export const GROUP_ID = '0190a000-0000-7000-8000-00000000c001';
export const BUCKET_ID = '0190a000-0000-7000-8000-00000000b001';

export const DM_CHANNEL = `dm__${WORKSPACE_ID}__${ME}__${PEER}`;
export const GROUP_CHANNEL = `group__${WORKSPACE_ID}__${GROUP_ID}`;

export const PEER_NAME = 'Priya Raman';
export const GROUP_NAME = 'Launch crew';

const MESSAGES_PER_CHANNEL = 40;
/** The DM message an Activity mention jumps to (0-based). */
export const MENTION_INDEX = 24;
/** Body of the mentioned DM message, shown as the Activity row preview. */
export const MENTION_PREVIEW = 'Can you take a look at the hook before 5pm?';
const HOUR = 3_600_000;

const LINES = [
  'Morning! Draft for the Monday carousel is up.',
  'Can we tighten the hook on slide one?',
  'Sure, pushing a new version in ten.',
  'Client wants the brand blue a touch darker.',
  'Noted. Swapping the palette now.',
  'Does the caption still fit under the limit?',
  'Yes, 212 characters with the hashtags.',
  'Great, sending it to review after lunch.',
  'Quick one: who owns the Friday reel?',
  'That is mine, storyboard is in the brief.',
  'Love the new cover shot.',
  'Can you check the alt text on image three?',
  'Done, it reads well now.',
  'Reminder: approvals close at 5pm today.',
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function messageId(channelIndex: number, n: number): string {
  return `0190b000-0000-7000-8${channelIndex}00-${String(n).padStart(12, '0')}`;
}

export function assetId(channelIndex: number, n: number): string {
  return `0190d000-0000-7000-8${channelIndex}00-${String(n).padStart(12, '0')}`;
}

export const POST_IDS = [
  '0190e000-0000-7000-8000-000000000001',
  '0190e000-0000-7000-8000-000000000002',
  '0190e000-0000-7000-8000-000000000003',
];

function buildMessages(
  channelIndex: number,
  channelId: string,
  senders: readonly string[],
  now: number,
): Row[] {
  const rows: Row[] = [];
  const start = now - 30 * HOUR;
  for (let n = 1; n <= MESSAGES_PER_CHANNEL; n += 1) {
    const sender = senders[n % senders.length] ?? ME;
    const createdAt = iso(start + n * 40 * 60_000);
    const base: Row = {
      id: messageId(channelIndex, n),
      channel_id: channelId,
      workspace_id: WORKSPACE_ID,
      sender_user_id: sender,
      body: LINES[n % LINES.length] ?? 'Hello',
      mentions: null,
      attachment_asset_ids: null,
      shared_post_ids: null,
      shared_brief_ids: null,
      reply_to_message_id: null,
      forwarded_from_message_id: null,
      attachment_meta: null,
      agora_event_id: null,
      created_at: createdAt,
      edited_at: null,
      deleted_at: null,
    };
    if (n === 12) {
      // A photo album: three images in one message.
      const ids = [1, 2, 3].map((k) => assetId(channelIndex, n * 10 + k));
      base.body = 'Three options for the cover';
      base.attachment_asset_ids = ids;
      base.attachment_meta = Object.fromEntries(
        ids.map((id, k) => [id, { mime: 'image/png', name: `cover-${k + 1}.png`, size: 48_000 }]),
      );
    } else if (n === 20) {
      base.body = 'This one is ready for a look';
      base.shared_post_ids = [POST_IDS[0]];
    } else if (n === 28) {
      const id = assetId(channelIndex, n * 10 + 1);
      base.body = null;
      base.attachment_asset_ids = [id];
      base.attachment_meta = {
        [id]: {
          mime: 'audio/webm',
          name: 'voice-note.webm',
          size: 22_000,
          duration_ms: 14_000,
          peaks: Array.from({ length: 48 }, (_, k) => 20 + ((k * 37) % 80)),
        },
      };
    }
    if (channelIndex === 1 && n === MENTION_INDEX + 1) {
      base.sender_user_id = PEER;
      base.body = `${MENTION_PREVIEW} @[${ME}]`;
      base.mentions = [ME];
    }
    rows.push(base);
  }
  return rows;
}

export interface ChatWorld {
  tables: Tables;
  dmMessages: Row[];
  groupMessages: Row[];
}

export function buildWorld(now: number = Date.now()): ChatWorld {
  // DM: alternate me/peer; the last two messages are the peer's, unread by me.
  const dmMessages = buildMessages(1, DM_CHANNEL, [ME, PEER], now);
  const lastDm = dmMessages.length - 1;
  const tailSender = (index: number): void => {
    const row = dmMessages[index];
    if (row) row.sender_user_id = PEER;
  };
  tailSender(lastDm);
  tailSender(lastDm - 1);
  const lastOwnDm = [...dmMessages].reverse().find((m) => m.sender_user_id === ME);
  const groupMessages = buildMessages(2, GROUP_CHANNEL, [ME, COLLEAGUE_A, COLLEAGUE_B], now);
  const lastGroup = groupMessages[groupMessages.length - 1];
  const myDmCursor = dmMessages[lastDm - 2];

  const users: Row[] = [
    { id: ME, display_name: 'Sam Okafor', designation: 'Account lead', avatar_url: null },
    { id: PEER, display_name: PEER_NAME, designation: 'Brand manager', avatar_url: null },
    { id: COLLEAGUE_A, display_name: 'Leo Martins', designation: 'Designer', avatar_url: null },
    { id: COLLEAGUE_B, display_name: 'Ana Silva', designation: 'Copywriter', avatar_url: null },
  ].map((u) => ({
    ...u,
    email_opt_in: true,
    profile_completed_at: '2026-01-02T00:00:00Z',
    timezone: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }));

  const posts: Row[] = POST_IDS.map((id, k) => ({
    id,
    number: 101 + k,
    workspace_id: WORKSPACE_ID,
    title: ['Monday carousel', 'Friday reel', 'Product teaser'][k],
    caption: 'Fixture caption',
    bucket_id: BUCKET_ID,
    owner_user_id: ME,
    platform: 'instagram',
    format: k === 1 ? 'video' : 'carousel',
    stage: 'review',
    stage_entered_at: iso(now - (k + 2) * 24 * HOUR),
    approved_by: null,
    approved_at: null,
    target_date: iso(now + (k + 1) * 24 * HOUR),
    origin: 'manual',
    brief_id: null,
    row_version: 1,
    created_by: ME,
    legacy_author_name: null,
    created_at: iso(now - 5 * 24 * HOUR),
    updated_at: iso(now - 2 * 24 * HOUR),
    deleted_at: null,
    post_versions: [],
    post_annotations: [],
  }));

  const tables: Tables = {
    users,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Harness Studio',
        owner_user_id: ME,
        plan_tier: 'studio',
        timezone: 'UTC',
        week_start_day: 1,
        subscription_state: 'active',
        asset_bucket: `assets-${WORKSPACE_ID}`,
        row_version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        deleted_at: null,
      },
    ],
    workspace_members: [ME, PEER, COLLEAGUE_A, COLLEAGUE_B].map((userId, k) => ({
      id: `0190f000-0000-7000-8000-00000000000${k + 1}`,
      workspace_id: WORKSPACE_ID,
      user_id: userId,
      role: userId === ME ? 'owner' : userId === PEER ? 'client' : 'agency',
      active: true,
      invited_by: null,
      invited_at: '2026-01-01T00:00:00Z',
      accepted_at: '2026-01-01T00:00:00Z',
      removed_at: null,
      rejoined_at: null,
    })),
    groups: [
      {
        id: GROUP_ID,
        name: GROUP_NAME,
        workspace_id: WORKSPACE_ID,
        avatar_url: null,
        created_by: ME,
        created_at: '2026-01-03T00:00:00Z',
        deleted_at: null,
      },
    ],
    group_members: [ME, COLLEAGUE_A, COLLEAGUE_B].map((userId) => ({
      group_id: GROUP_ID,
      user_id: userId,
      workspace_id: WORKSPACE_ID,
      joined_at: '2026-01-03T00:00:00Z',
    })),
    chat_channels: [
      {
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: ME,
        dm_user_b: PEER,
        last_synced_at: null,
        created_at: '2026-01-04T00:00:00Z',
      },
      {
        channel_id: GROUP_CHANNEL,
        workspace_id: WORKSPACE_ID,
        channel_type: 'group',
        entity_id: GROUP_ID,
        agora_group_id: 'agora-group-1',
        dm_user_a: null,
        dm_user_b: null,
        last_synced_at: null,
        created_at: '2026-01-03T00:00:00Z',
      },
    ],
    chat_messages: [...dmMessages, ...groupMessages],
    chat_reactions: [
      {
        message_id: dmMessages[10]?.id,
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        user_id: PEER,
        emoji: '👍',
        created_at: dmMessages[10]?.created_at,
      },
      {
        message_id: groupMessages[15]?.id,
        channel_id: GROUP_CHANNEL,
        workspace_id: WORKSPACE_ID,
        user_id: COLLEAGUE_A,
        emoji: '🔥',
        created_at: groupMessages[15]?.created_at,
      },
    ],
    chat_read_cursors: [
      {
        channel_id: DM_CHANNEL,
        user_id: PEER,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: lastOwnDm?.id,
        last_read_at: lastOwnDm?.created_at,
        updated_at: lastOwnDm?.created_at,
      },
      {
        channel_id: DM_CHANNEL,
        user_id: ME,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: myDmCursor?.id,
        last_read_at: myDmCursor?.created_at,
        updated_at: myDmCursor?.created_at,
      },
      ...[ME, COLLEAGUE_A].map((userId) => ({
        channel_id: GROUP_CHANNEL,
        user_id: userId,
        workspace_id: WORKSPACE_ID,
        last_read_message_id: lastGroup?.id,
        last_read_at: lastGroup?.created_at,
        updated_at: lastGroup?.created_at,
      })),
    ],
    chat_channel_clears: [],
    chat_message_marks: [],
    posts,
    briefs: [],
    inbox_entries: [
      {
        id: '0190f100-0000-7000-8000-000000000001',
        user_id: ME,
        actor_user_id: PEER,
        workspace_id: WORKSPACE_ID,
        event_type: 'mention',
        entity_type: 'chat_channel',
        entity_id: DM_CHANNEL,
        scope: 'people',
        scope_key: null,
        tier: 'urgent',
        payload: { message_id: dmMessages[MENTION_INDEX]?.id },
        read_at: null,
        snoozed_until: null,
        email_sent_at: null,
        deleted_at: null,
        created_at: dmMessages[MENTION_INDEX]?.created_at,
      },
    ],
    comments: [],
    assets: [],
    asset_attachments: [],
    folders: [],
    workspace_buckets: [
      {
        id: BUCKET_ID,
        workspace_id: WORKSPACE_ID,
        name: 'Always on',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
  return { tables, dmMessages, groupMessages };
}
