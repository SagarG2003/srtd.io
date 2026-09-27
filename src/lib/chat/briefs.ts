// Briefs shared into chat. The picker and the bubble cards read public.briefs
// through plain RLS-scoped SELECTs scoped to the open workspace (the
// @srtdio/briefs listBriefs read is not workspace-scoped and also resolves
// thumbnails, which the chat picker does not need). A bubble's brief ids resolve
// in ONE IN read; an id the viewer's RLS hides comes back absent and renders as
// an "unavailable" card, so nothing leaks. Pure helpers are unit-tested with no DOM.

import type { Client, Result } from '@srtdio/rpc';

/** The brief fields a picker row, chip and card render. */
export interface BriefCardFields {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface BriefCardRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

/** Picker page size (newest first). */
export const BRIEF_PICKER_LIMIT = 50;

const BRIEF_COLUMNS = 'id, title, status, created_at';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function toFields(row: BriefCardRow): BriefCardFields {
  return { id: row.id, title: row.title, status: row.status, createdAt: row.created_at };
}

/** Escape LIKE wildcards so a typed % or _ matches literally. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Briefs for the picker: the workspace's live briefs, newest first, optional title match. */
export async function listBriefsForPicker(
  client: Client,
  params: { workspaceId: string; titleQuery: string },
): Promise<Result<BriefCardFields[]>> {
  let query = client
    .from('briefs')
    .select(BRIEF_COLUMNS)
    .eq('workspace_id', params.workspaceId)
    .is('deleted_at', null);
  const title = params.titleQuery.trim();
  if (title !== '') query = query.ilike('title', likePattern(title));
  const res = await query.order('created_at', { ascending: false }).limit(BRIEF_PICKER_LIMIT);
  if (res.error) return fail(`listBriefsForPicker: ${res.error.message}`);
  return { ok: true, data: ((res.data ?? []) as BriefCardRow[]).map(toFields) };
}

/** Briefs by id (one IN read); empty in, empty out. */
export async function readBriefsByIds(
  client: Client,
  params: { workspaceId: string; ids: readonly string[] },
): Promise<Result<BriefCardFields[]>> {
  if (params.ids.length === 0) return { ok: true, data: [] };
  const res = await client
    .from('briefs')
    .select(BRIEF_COLUMNS)
    .eq('workspace_id', params.workspaceId)
    .in('id', [...params.ids])
    .is('deleted_at', null);
  if (res.error) return fail(`readBriefsByIds: ${res.error.message}`);
  return { ok: true, data: ((res.data ?? []) as BriefCardRow[]).map(toFields) };
}

/** The in-app route a brief card opens. */
export function briefRoute(id: string): string {
  return `/briefs/${id}`;
}

/** Status chip label: Open or Closed. */
export function briefStatusLabel(status: string): string {
  return status === 'closed' ? 'Closed' : 'Open';
}

/** Whether a brief id is in the selection. */
export function isBriefSelected(selected: readonly BriefCardFields[], id: string): boolean {
  return selected.some((brief) => brief.id === id);
}

/** Toggle a brief in the selection (new array, matched by id). */
export function toggleBrief(
  selected: readonly BriefCardFields[],
  brief: BriefCardFields,
): BriefCardFields[] {
  return isBriefSelected(selected, brief.id)
    ? selected.filter((item) => item.id !== brief.id)
    : [...selected, brief];
}

/** The render branch for one shared brief id. */
export type SharedBriefView =
  | { kind: 'brief'; briefId: string; title: string; status: string }
  | { kind: 'unavailable'; briefId: string };

/** One view per id in message order; an id the read did not return is unavailable. */
export function sharedBriefViews(
  ids: readonly string[],
  briefs: readonly BriefCardFields[],
): SharedBriefView[] {
  const byId = new Map(briefs.map((b) => [b.id, b]));
  return ids.map((briefId) => {
    const brief = byId.get(briefId);
    return brief !== undefined
      ? { kind: 'brief', briefId, title: brief.title, status: brief.status }
      : { kind: 'unavailable', briefId };
  });
}
