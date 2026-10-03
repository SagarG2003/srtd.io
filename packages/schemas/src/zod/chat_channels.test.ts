import { describe, expect, it } from 'vitest';
import { ChatChannelSchema } from './chat_channels';

const WS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const USER = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const notesRow = {
  channel_id: `notes__${WS}__${USER}`,
  workspace_id: WS,
  channel_type: 'notes',
  entity_id: null,
  dm_user_a: null,
  dm_user_b: null,
  owner_user_id: USER,
  last_synced_at: null,
  created_at: '2026-10-03T10:00:00Z',
};

describe('ChatChannelSchema', () => {
  it('accepts a notes row with its owner', () => {
    expect(ChatChannelSchema.safeParse(notesRow).success).toBe(true);
  });

  it('rejects a notes row without owner_user_id (null or missing)', () => {
    expect(ChatChannelSchema.safeParse({ ...notesRow, owner_user_id: null }).success).toBe(false);
    const { owner_user_id: _owner, ...missing } = notesRow;
    void _owner;
    expect(ChatChannelSchema.safeParse(missing).success).toBe(false);
  });

  it('keeps dm and group rows owner-less', () => {
    const dm = {
      ...notesRow,
      channel_id: `dm__${WS}__a`,
      channel_type: 'dm',
      dm_user_a: USER,
      dm_user_b: WS,
      owner_user_id: null,
    };
    expect(ChatChannelSchema.safeParse(dm).success).toBe(true);
    expect(ChatChannelSchema.safeParse({ ...dm, owner_user_id: USER }).success).toBe(false);
  });

  it('rejects an unknown channel type', () => {
    expect(ChatChannelSchema.safeParse({ ...notesRow, channel_type: 'plan' }).success).toBe(false);
  });
});
