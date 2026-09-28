// Pure, React-free helpers for the chat post picker, so the filter chips and the
// multi-select toggle are unit-tested directly without a DOM. The picker reads
// posts through the existing @srtdio/posts RLS select (listPostsForPicker); these
// helpers only describe the filter chips and shape the selection. Nothing here
// fabricates post fields.

import type { PostCardFields, Stage } from '@srtdio/posts';
import { isAgencySide } from '@/components/pages/pcs/roles';

/** The picker's stage filter: a real stage, or all stages the viewer can see. */
export type PostFilter = 'draft' | 'review' | 'approved' | 'all';

/** The filter chips, in display order. Review is the default selection. */
export const POST_FILTERS: ReadonlyArray<{ key: PostFilter; label: string }> = [
  { key: 'draft', label: 'Drafts' },
  { key: 'review', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'all', label: 'All posts' },
];

/**
 * The chips a viewer sees. Drafts shows only once the member's role is known and
 * is agency side (isAgencySide, the same predicate PCS gates on); an unknown
 * (null) role hides it, so the chip never flashes in and then disappears.
 */
export function visiblePostFilters(
  role: string | null,
): ReadonlyArray<{ key: PostFilter; label: string }> {
  return isAgencySide(role) ? POST_FILTERS : POST_FILTERS.filter((f) => f.key !== 'draft');
}

/** The default chip when the picker opens. */
export const DEFAULT_POST_FILTER: PostFilter = 'review';

/**
 * The stage to pass to the read for a filter. "All posts" passes none, so RLS
 * alone bounds the result (e.g. clients never see Draft); roles are never
 * special-cased in the query.
 */
export function filterStage(filter: PostFilter): Stage | undefined {
  return filter === 'all' ? undefined : filter;
}

/** Whether a post id is in the current selection. */
export function isPostSelected(selected: readonly PostCardFields[], id: string): boolean {
  return selected.some((post) => post.id === id);
}

/**
 * Toggle a post in the selection: append it when absent, remove it when present
 * (matched by id). Returns a new array; the input is never mutated. This is how
 * picking a row adds a removable shared-post chip, and tapping it again (or its
 * chip remove) takes it back out.
 */
export function togglePost(
  selected: readonly PostCardFields[],
  post: PostCardFields,
): PostCardFields[] {
  return isPostSelected(selected, post.id)
    ? selected.filter((item) => item.id !== post.id)
    : [...selected, post];
}
