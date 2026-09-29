import { beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable users read: each maybeSingle() call returns a deferred the test
// settles, so in-flight sharing and ordering are observable without a network.
interface Deferred {
  userId: string;
  resolve: (value: { data: unknown; error: { message: string } | null }) => void;
}
const reads: Deferred[] = [];

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (_col: string, userId: string) => ({
          maybeSingle: () =>
            new Promise((resolve) => {
              reads.push({ userId, resolve });
            }),
        }),
      }),
    }),
  },
}));

import {
  getProfileSnapshot,
  loadProfile,
  profileViewFor,
  resetProfileStore,
  subscribeProfile,
  type CurrentProfile,
} from '@/lib/use-current-profile';

function row(name: string, avatar: string | null = null): CurrentProfile {
  return {
    display_name: name,
    designation: null,
    avatar_url: avatar,
    email_opt_in: true,
    profile_completed_at: '2026-09-01T00:00:00Z',
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  reads.length = 0;
  resetProfileStore(null);
});

describe('shared profile store', () => {
  it('two subscribers (header and panel) make one read and see one snapshot', async () => {
    const header = vi.fn();
    const panel = vi.fn();
    const offA = subscribeProfile(header);
    const offB = subscribeProfile(panel);

    void loadProfile('u-1');
    void loadProfile('u-1');
    expect(reads).toHaveLength(1);

    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: row('Asha'),
      loading: false,
      error: false,
    });
    expect(header).toHaveBeenCalled();
    expect(panel).toHaveBeenCalled();
    offA();
    offB();
  });

  it('refetch from one caller updates every subscriber', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha', 'https://cdn/old.png'), error: null });
    await flush();

    const header = vi.fn();
    const panel = vi.fn();
    const offA = subscribeProfile(header);
    const offB = subscribeProfile(panel);
    void loadProfile('u-1', true);
    expect(reads).toHaveLength(2);
    // Still showing the last good row while the refetch runs: no loading flash.
    expect(getProfileSnapshot().loading).toBe(false);
    reads[1]?.resolve({ data: row('Asha', null), error: null });
    await flush();

    expect(getProfileSnapshot().profile?.avatar_url).toBeNull();
    expect(header).toHaveBeenCalledOnce();
    expect(panel).toHaveBeenCalledOnce();
    offA();
    offB();
  });

  it('a refetch during a read queues exactly one follow-up read', async () => {
    void loadProfile('u-1');
    void loadProfile('u-1', true);
    void loadProfile('u-1', true);
    expect(reads).toHaveLength(1);
    reads[0]?.resolve({ data: row('Old'), error: null });
    await flush();
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ data: row('New'), error: null });
    await flush();
    expect(reads).toHaveLength(2);
    expect(getProfileSnapshot().profile?.display_name).toBe('New');
  });

  it('a user change clears the snapshot before the new read', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();

    // First render as the new user, before any effect runs: nothing of u-1.
    expect(profileViewFor(getProfileSnapshot(), 'u-2')).toEqual({
      userId: 'u-2',
      profile: null,
      loading: true,
      error: false,
    });
    expect(profileViewFor(getProfileSnapshot(), null).profile).toBeNull();

    void loadProfile('u-2');
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-2',
      profile: null,
      loading: true,
      error: false,
    });
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ data: row('Ravi'), error: null });
    await flush();
    expect(getProfileSnapshot().profile?.display_name).toBe('Ravi');
  });

  it('drops a read that lands after the user changed', async () => {
    void loadProfile('u-1');
    void loadProfile('u-2');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    expect(getProfileSnapshot().profile).toBeNull();
    expect(getProfileSnapshot().userId).toBe('u-2');
  });

  it('sign-out resets the store synchronously', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    resetProfileStore(null);
    expect(getProfileSnapshot()).toEqual({
      userId: null,
      profile: null,
      loading: true,
      error: false,
    });
  });

  it('a failed read keeps the last good snapshot and flags the error', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();

    void loadProfile('u-1', true);
    reads[1]?.resolve({ data: null, error: { message: 'network' } });
    await flush();
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: row('Asha'),
      loading: false,
      error: true,
    });
  });

  it('a failed first read reports error with no profile, as before', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: null, error: { message: 'network' } });
    await flush();
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: null,
      loading: false,
      error: true,
    });
  });
});
