import { afterEach, describe, expect, it } from 'vitest';
import {
  addPick,
  deserializeMentions,
  displayCaret,
  filterMentionMembers,
  insertMention,
  knownMentionName,
  mentionIds,
  mentionQuery,
  rememberMentionNames,
  resetMentionNames,
  resolveMentionText,
  serializedCaret,
  serializeMentions,
  splitMentions,
  truncateBody,
  UNKNOWN_MEMBER,
  type MentionMember,
} from '@/lib/chat/mentions';

const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const GONE = '99999999-9999-4999-8999-999999999999';

const NAMES = new Map([
  [ANA, 'Ana Roy'],
  [BEN, 'Ben'],
]);
const nameOf = (id: string): string | undefined => NAMES.get(id);

afterEach(() => resetMentionNames());

describe('serialize / deserialize', () => {
  it('round trips "@Name" text and @[uuid] bodies', () => {
    const picks = [
      { userId: ANA, name: 'Ana Roy' },
      { userId: BEN, name: 'Ben' },
    ];
    const text = '@Ana Roy can you and @Ben check this?';
    const body = serializeMentions(text, picks);
    expect(body).toBe(`@[${ANA}] can you and @[${BEN}] check this?`);
    expect(mentionIds(body)).toEqual([ANA, BEN]);
    const back = deserializeMentions(body, nameOf);
    expect(back.text).toBe(text);
    expect(back.picks.map((p) => p.userId).sort()).toEqual([ANA, BEN].sort());
  });

  it('drops a mention whose "@Name" text was damaged', () => {
    const picks = [{ userId: ANA, name: 'Ana Roy' }];
    expect(serializeMentions('@Ana Ro hi', picks)).toBe('@Ana Ro hi');
    expect(serializeMentions('@Ana Royce hi', picks)).toBe('@Ana Royce hi');
    expect(serializeMentions('x@Ana Roy hi', picks)).toBe('x@Ana Roy hi');
    expect(mentionIds(serializeMentions('@Ana Ro hi', picks))).toEqual([]);
  });

  it('dedupes duplicate picks of the same person', () => {
    const once = addPick([], { userId: BEN, name: 'Ben' });
    const twice = addPick(once, { userId: BEN, name: 'Ben' });
    expect(twice).toHaveLength(1);
    const body = serializeMentions('@Ben and @Ben again', twice);
    expect(body).toBe(`@[${BEN}] and @[${BEN}] again`);
    expect(mentionIds(body)).toEqual([BEN]);
  });

  it('leaves non-mention @ text untouched', () => {
    const picks = [{ userId: BEN, name: 'Ben' }];
    const text = 'mail ben@site.com or @someone, @Benny';
    expect(serializeMentions(text, picks)).toBe(text);
    expect(resolveMentionText(text, nameOf)).toBe(text);
  });

  it('a longer name wins over a prefix name', () => {
    const picks = [
      { userId: BEN, name: 'Ana' },
      { userId: ANA, name: 'Ana Roy' },
    ];
    expect(serializeMentions('@Ana Roy', picks)).toBe(`@[${ANA}]`);
  });

  it('an unresolvable token reads "@Unknown member" and is not a pick', () => {
    const back = deserializeMentions(`hi @[${GONE}]`, nameOf);
    expect(back.text).toBe(`hi @${UNKNOWN_MEMBER}`);
    expect(back.picks).toEqual([]);
  });
});

describe('render helpers', () => {
  it('resolves every token and never leaves a raw one', () => {
    const out = resolveMentionText(`@[${ANA}] and @[${GONE}]`, nameOf);
    expect(out).toBe('@Ana Roy and @Unknown member');
    expect(out).not.toContain('@[');
  });

  it('splits text and mentions in order', () => {
    expect(splitMentions(`a @[${ANA}] b`)).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'mention', userId: ANA },
      { kind: 'text', text: ' b' },
    ]);
  });

  it('truncates without cutting a token', () => {
    const body = `hello @[${ANA}] world`;
    const cut = truncateBody(body, 10);
    expect(cut).toBe(`hello @[${ANA}]…`);
    expect(truncateBody('short', 10)).toBe('short');
    expect(truncateBody('0123456789abc', 10)).toBe('0123456789…');
  });
});

describe('mentionQuery / insertMention', () => {
  it('opens on @ at the start or after whitespace, never mid-word', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQuery('hi\n@b', 5)).toEqual({ start: 3, query: 'b' });
    expect(mentionQuery('mail@x', 6)).toBeNull();
    expect(mentionQuery('@ana roy', 8)).toBeNull();
    expect(mentionQuery('no at', 5)).toBeNull();
  });

  it('replaces the open run with "@Name " and moves the caret after it', () => {
    expect(insertMention('hi @an', 6, 'Ana Roy')).toEqual({ text: 'hi @Ana Roy ', caret: 12 });
    expect(insertMention('@b there', 2, 'Ben')).toEqual({ text: '@Ben there', caret: 5 });
  });
});

describe('filterMentionMembers', () => {
  const members: MentionMember[] = [
    { userId: ANA, displayName: 'Ana Roy', avatarUrl: null, role: 'agency' },
    { userId: BEN, displayName: 'Ben', avatarUrl: null, role: 'client' },
    { userId: GONE, displayName: 'Me Myself', avatarUrl: null, role: 'owner' },
  ];

  it('filters by display name, case-insensitive, and excludes me', () => {
    expect(filterMentionMembers(members, '', GONE).map((m) => m.userId)).toEqual([ANA, BEN]);
    expect(filterMentionMembers(members, 'ROY', GONE).map((m) => m.userId)).toEqual([ANA]);
    expect(filterMentionMembers(members, 'me', GONE)).toEqual([]);
  });

  it('puts names that start with the query first', () => {
    const list: MentionMember[] = [
      { userId: ANA, displayName: 'Deb Benson', avatarUrl: null, role: null },
      { userId: BEN, displayName: 'Ben', avatarUrl: null, role: null },
    ];
    expect(filterMentionMembers(list, 'ben', null).map((m) => m.userId)).toEqual([BEN, ANA]);
  });
});

describe('draft carets', () => {
  it('maps the caret between textarea and stored body', () => {
    const picks = [{ userId: BEN, name: 'Ben' }];
    const text = '@Ben hi';
    const stored = serializeMentions(text, picks);
    const at = serializedCaret(text, text.length, picks);
    expect(at).toBe(stored.length);
    expect(displayCaret(stored, at, nameOf)).toBe(text.length);
    // A caret inside a token rounds down to the token start.
    expect(displayCaret(stored, 5, nameOf)).toBe(0);
  });
});

describe('name registry', () => {
  it('remembers names from batched reads', () => {
    expect(knownMentionName(ANA)).toBeUndefined();
    rememberMentionNames([{ userId: ANA, displayName: 'Ana Roy' }]);
    expect(knownMentionName(ANA)).toBe('Ana Roy');
  });
});
