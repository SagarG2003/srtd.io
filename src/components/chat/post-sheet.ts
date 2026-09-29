// Pure, React-free helpers for the chat post sheet: which actions a viewer gets
// by side and stage, the confirm and toast copy, the media strip's labels, the
// detail rows, and the one stage change the sheet can make. Everything the sheet
// decides lives here so it is unit tested without a DOM. The sheet never
// refetches the post: every value is derived from the PR 2 card row.

import type { DomainError, Result } from '@srtdio/rpc';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import type { StageTransitionInput } from '../../../packages/posts/src/stage-machine';
import { formatMessageTime, formatShortDate } from '@/lib/chat/time-format';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatLabel } from '@/lib/post-detail-presentation';
import { friendlyTransitionError } from '@/lib/post-transition-errors';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';

/** Every action the sheet can offer. */
export type SheetAction = 'approve' | 'comment' | 'open_post' | 'send_review' | 'open_pipeline';

/** The two actions that ask first, then move the post. */
export type ConfirmKind = 'approve' | 'send_review';

/** The action area for one viewer side and stage. */
export interface SheetActionSet {
  /** In display order; the first is the emphasised one. */
  actions: SheetAction[];
  /** A quiet line under the buttons, or null. */
  hint: string | null;
  /** Show the disabled "Approved by" pill (client side, approved). */
  approvedPill: boolean;
}

export const CLIENT_REVIEW_HINT = 'One post at a time. Comments keep it in review.';

/**
 * The action set by side and stage. Client in review: approve, comment, open.
 * Client elsewhere: open only (plus the approved pill). Agency in draft: send for
 * review, open in pipeline. Agency elsewhere: open in pipeline, with a waiting
 * hint in review. An unresolved side gets the neutral open action only, so a
 * write is never offered before the role is known.
 */
export function sheetActions(
  side: ViewerSide,
  post: Pick<PostCardRow, 'stage' | 'stage_entered_at'>,
  timeZone: string,
): SheetActionSet {
  if (side === 'client') {
    if (post.stage === 'review') {
      return {
        actions: ['approve', 'comment', 'open_post'],
        hint: CLIENT_REVIEW_HINT,
        approvedPill: false,
      };
    }
    return { actions: ['open_post'], hint: null, approvedPill: post.stage === 'approved' };
  }
  if (side === 'agency') {
    if (post.stage === 'draft') {
      return { actions: ['send_review', 'open_pipeline'], hint: null, approvedPill: false };
    }
    const since = formatShortDate(post.stage_entered_at, timeZone);
    const hint =
      post.stage === 'review'
        ? since === ''
          ? 'Waiting on the client'
          : `Waiting on the client since ${since}`
        : null;
    return { actions: ['open_pipeline'], hint, approvedPill: false };
  }
  return { actions: ['open_post'], hint: null, approvedPill: false };
}

/** The button label for an action; approve names the post. */
export function actionLabel(action: SheetAction, ref: string): string {
  switch (action) {
    case 'approve':
      return `Approve ${ref}`;
    case 'comment':
      return 'Comment on this post';
    case 'open_post':
      return 'Open full post';
    case 'send_review':
      return 'Send for review';
    case 'open_pipeline':
      return 'Open in pipeline';
  }
}

/** The disabled pill a client sees on an approved post. */
export function approvedPillLabel(approverName: string | null): string {
  return approverName !== null ? `Approved by ${approverName}` : 'Approved';
}

/** "1 slide" / "N slides"; empty for no media. */
function slidesPhrase(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 slide' : `all ${count} slides`;
}

/** The confirm block's question and its consequence line. */
export interface ConfirmCopy {
  question: string;
  detail: string;
  confirmLabel: string;
}

/**
 * The confirm copy. Approve: "Approve KEY, all N slides, for Oct 2?" followed by
 * the logged-approval line; the slide and date clauses drop out when there is no
 * media or no target date. Send for review says what leaving draft means.
 */
export function confirmCopy(
  kind: ConfirmKind,
  args: { ref: string; mediaCount: number; targetDate: string },
): ConfirmCopy {
  const clauses = [args.ref];
  const slides = slidesPhrase(args.mediaCount);
  if (slides !== '') clauses.push(slides);
  if (args.targetDate !== '') clauses.push(`for ${args.targetDate}`);
  const subject = clauses.join(', ');
  if (kind === 'approve') {
    return {
      question: `Approve ${subject}?`,
      detail: 'This is logged as your approval and the agency is notified.',
      confirmLabel: `Approve ${args.ref}`,
    };
  }
  return {
    question: `Send ${args.ref} to the client for review?`,
    detail: 'It leaves draft, and the client can approve it or comment.',
    confirmLabel: 'Send for review',
  };
}

/** The stage each confirm moves the post to. */
export function confirmTarget(kind: ConfirmKind): StageTransitionInput['toStage'] {
  return kind === 'approve' ? 'approved' : 'review';
}

/** The success toast: "KEY approved" / "KEY sent for review". */
export function successToast(kind: ConfirmKind, ref: string): string {
  return kind === 'approve' ? `${ref} approved` : `${ref} sent for review`;
}

/** The toast after a client comment lands. */
export function commentToast(ref: string): string {
  return `Comment added to ${ref}`;
}

/** Copy for a failed comment_batch_create; unknown codes keep the generic line. */
export function friendlyCommentError(code: string): string {
  switch (code) {
    case 'invalid_stage':
      return 'Comments open once the post is in review.';
    case 'forbidden_role':
      return 'You do not have permission to comment on this post.';
    case 'invalid_payload':
      return 'Each point needs 1 to 50 words.';
    default:
      return 'Could not add the comment. Please try again.';
  }
}

/** "m:ss" for a duration in milliseconds; empty for a missing or invalid one. */
export function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The minimal gallery item shape the strip reads. */
export interface StripItem {
  kind: string;
  mimeType: string | null;
  durationMs: number | null;
}

/** Whether a gallery item plays as a video. */
export function isVideoItem(item: Pick<StripItem, 'kind' | 'mimeType'>): boolean {
  return item.kind === 'video' || (item.mimeType ?? '').startsWith('video/');
}

/** "Reel · m:ss" for a video-format post whose first video has a duration, else null. */
export function reelLabel(format: string, items: readonly StripItem[]): string | null {
  if (format !== 'video') return null;
  const video = items.find(isVideoItem);
  const length = durationLabel(video?.durationMs ?? null);
  return length === '' ? null : `Reel · ${length}`;
}

/** The strip counter: "1 / N". */
export function stripCounter(index: number, count: number): string {
  return `${index + 1} / ${count}`;
}

/** The sheet title: "KEY · Format". */
export function sheetTitle(ref: string, format: string): string {
  return `${ref} · ${formatLabel(format)}`;
}

/** Title-case a stage value for its chip. */
export function stageTagLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/** One key/value row under the title (Stage renders its Tag, so it is not here). */
export interface DetailRow {
  key: 'target' | 'format' | 'approved';
  label: string;
  value: string;
}

/** "Oct 2 14:05" in the workspace zone, or '' for an unparseable instant. */
function dateTime(iso: string, timeZone: string): string {
  const date = formatShortDate(iso, timeZone);
  return date === '' ? '' : `${date} ${formatMessageTime(iso, timeZone)}`;
}

/**
 * The rows after Stage: target date, format (with "· N slides" past one item),
 * and the approval. With an approver on record the value is "Name · Oct 2 14:05";
 * an approved post with no approver reads the date it entered approved.
 */
export function detailRows(
  post: Pick<
    PostCardRow,
    | 'stage'
    | 'target_date'
    | 'format'
    | 'mediaCount'
    | 'approved_by'
    | 'approved_at'
    | 'stage_entered_at'
  >,
  approverName: string | null,
  timeZone: string,
): DetailRow[] {
  const rows: DetailRow[] = [];
  const target = post.target_date !== null ? formatShortDate(post.target_date, timeZone) : '';
  if (target !== '') rows.push({ key: 'target', label: 'Target date', value: target });
  const format = formatLabel(post.format);
  rows.push({
    key: 'format',
    label: 'Format',
    value: post.mediaCount > 1 ? `${format} · ${post.mediaCount} slides` : format,
  });
  if (post.approved_by !== null) {
    const at = post.approved_at !== null ? dateTime(post.approved_at, timeZone) : '';
    const value = [approverName ?? '', at].filter((part) => part !== '').join(' · ');
    if (value !== '') rows.push({ key: 'approved', label: 'Approved', value });
  } else if (post.stage === 'approved') {
    const on = formatShortDate(post.stage_entered_at, timeZone);
    if (on !== '') rows.push({ key: 'approved', label: 'Approved', value: on });
  }
  return rows;
}

/** Tell every live card batch that a post changed (PR 2's cards refetch on it). */
export function dispatchPostChanged(
  target: Pick<EventTarget, 'dispatchEvent'>,
  postId: string,
): void {
  target.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId } }));
}

/** What a confirmed stage change needs, injected so the flow is tested with fakes. */
export interface StageChangeDeps {
  transition: (input: StageTransitionInput) => Promise<Result<string>>;
  target: Pick<EventTarget, 'dispatchEvent'>;
  toast: (title: string) => void;
  close: () => void;
}

/**
 * Run one confirmed stage change: exactly one transition call. On success it
 * announces the change, closes the sheet and toasts, and resolves null; on
 * failure it resolves the friendly error copy and touches nothing else.
 */
export async function runStageChange(
  deps: StageChangeDeps,
  args: { kind: ConfirmKind; postId: string; ref: string; traceId: string },
): Promise<string | null> {
  let result: Result<string>;
  try {
    result = await deps.transition({
      postId: args.postId,
      toStage: confirmTarget(args.kind),
      traceId: args.traceId,
    });
  } catch {
    result = { ok: false, error: { code: 'unknown', message: 'unknown' } as DomainError };
  }
  if (!result.ok) return friendlyTransitionError(result.error);
  dispatchPostChanged(deps.target, args.postId);
  deps.close();
  deps.toast(successToast(args.kind, args.ref));
  return null;
}
