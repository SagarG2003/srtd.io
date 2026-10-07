import { describe, expect, it } from 'vitest';
import {
  ON_BEHALF_OF_CLIENT,
  canDeletePost,
  isAgencySide,
  isClient,
  onBehalfSuffix,
} from '@/components/pages/pcs/roles';

describe('canDeletePost', () => {
  it('owner, admin and agency may delete a post', () => {
    expect(canDeletePost('owner')).toBe(true);
    expect(canDeletePost('admin')).toBe(true);
    expect(canDeletePost('agency')).toBe(true);
  });

  it('client and an unknown role never may', () => {
    expect(canDeletePost('client')).toBe(false);
    expect(canDeletePost(null)).toBe(false);
  });
});

describe('onBehalfSuffix', () => {
  it('suffixes an agency-side role', () => {
    for (const role of ['owner', 'admin', 'agency']) {
      expect(onBehalfSuffix(role)).toBe(` ${ON_BEHALF_OF_CLIENT}`);
    }
    expect(ON_BEHALF_OF_CLIENT).toBe('on behalf of client');
  });

  it('adds nothing for the client, a missing role or an old row', () => {
    expect(onBehalfSuffix('client')).toBe('');
    expect(onBehalfSuffix(null)).toBe('');
    expect(onBehalfSuffix(undefined)).toBe('');
    expect(onBehalfSuffix('')).toBe('');
  });
});

describe('isClient / isAgencySide', () => {
  it('splits the four roles', () => {
    expect(isClient('client')).toBe(true);
    expect(isAgencySide('client')).toBe(false);
    expect(isAgencySide('agency')).toBe(true);
    expect(isClient(null) || isAgencySide(null)).toBe(false);
  });
});
