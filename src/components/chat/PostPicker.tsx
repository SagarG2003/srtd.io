// The share picker Sheet, opened by the composer's "Share a post or brief" menu
// item. Two tabs: Posts and Briefs. The Posts tab
// reads the workspace's posts through the existing @srtdio/posts RLS select
// (listPostsForPicker, scoped to workspace + stage + a simple title match, no
// full-text index), so a viewer only ever sees posts RLS lets them see. Selection
// is controlled by the composer: toggling a row adds/removes a removable shared
// post chip there. One read per filter change (no N+1 in the list). The Briefs
// tab reads the workspace's briefs (title, objective, Open/Closed, target and
// raised dates, live post count) through listBriefsForPicker, filtered by status
// chips, and toggles brief chips the same way.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { IconBriefs, IconCheck, IconPipeline, IconSearch } from '@/components/ui/icons';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
import { cn } from '@/lib/cn';
import { formatEntityRef } from '@/lib/entityRef';
import { formatLabel } from '@/lib/post-detail-presentation';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { listPostsForPicker, type PostCardFields } from '@srtdio/posts';
import {
  BRIEF_FILTERS,
  DEFAULT_BRIEF_FILTER,
  briefPostCountLabel,
  briefStatusLabel,
  filterBriefStatus,
  isBriefSelected,
  listBriefsForPicker,
  type BriefCardFields,
  type BriefFilter,
  type BriefPickerRow,
} from '@/lib/chat/briefs';
import { formatShortDate, formatShortDateOnly, workspaceTimeZone } from '@/lib/chat/time-format';
import {
  DEFAULT_POST_FILTER,
  POST_FILTERS,
  filterStage,
  isPostSelected,
  type PostFilter,
} from '@/components/chat/post-picker';

/** One Posts-tab row: the card fields plus number, caption and target date. */
type PostPickerRow = Extract<
  Awaited<ReturnType<typeof listPostsForPicker>>,
  { ok: true }
>['data'][number];

interface PostPickerProps {
  open: boolean;
  onClose: () => void;
  /** The composer's current shared-post selection (controlled). */
  selected: readonly PostCardFields[];
  /** Toggle one post in/out of the selection (adds/removes its chip). */
  onToggle: (post: PostCardFields) => void;
  /** The composer's current shared-brief selection (controlled). */
  selectedBriefs: readonly BriefCardFields[];
  /** Toggle one brief in/out of the selection. */
  onToggleBrief: (brief: BriefCardFields) => void;
}

type ShareTab = 'posts' | 'briefs';

/** Full-width row: hairline divider, 44px minimum, no rounded card. */
function rowClass(active: boolean): string {
  return cn(
    'flex w-full items-start gap-3 border-b border-border px-4 py-3 min-h-[44px] text-left transition-colors',
    active ? 'bg-accent-soft' : 'hover:bg-panel-2',
  );
}

export function PostPicker(props: PostPickerProps): ReactElement {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const [tab, setTab] = useState<ShareTab>('posts');
  const [briefs, setBriefs] = useState<BriefPickerRow[]>([]);
  const [briefFilter, setBriefFilter] = useState<BriefFilter>(DEFAULT_BRIEF_FILTER);
  const [filter, setFilter] = useState<PostFilter>(DEFAULT_POST_FILTER);
  const [query, setQuery] = useState('');
  const [posts, setPosts] = useState<PostPickerRow[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The read the current tab/filter/search asks for. The list renders only once
  // the result for exactly this key has landed, so the first paint is final (no
  // stale or empty frame between a change and its effect).
  const requestKey = [workspaceId, tab, tab === 'posts' ? filter : briefFilter, query].join('|');
  const loading = loadedKey !== requestKey;

  // Reset to the default filters and empty search each time the picker opens.
  useEffect(() => {
    if (props.open) {
      setTab('posts');
      setFilter(DEFAULT_POST_FILTER);
      setBriefFilter(DEFAULT_BRIEF_FILTER);
      setQuery('');
    }
  }, [props.open]);

  // One RLS-scoped read per (workspace, filter, search) change; never per row.
  useEffect(() => {
    if (!props.open || workspaceId === null) return;
    let cancelled = false;
    if (tab === 'briefs') {
      const status = filterBriefStatus(briefFilter);
      void listBriefsForPicker(supabase, {
        workspaceId,
        titleQuery: query,
        ...(status !== undefined ? { status } : {}),
      }).then((result) => {
        if (cancelled) return;
        setError(result.ok ? null : result.error.message);
        setBriefs(result.ok ? result.data : []);
        setLoadedKey(requestKey);
      });
      return () => {
        cancelled = true;
      };
    }
    const stage = filterStage(filter);
    void listPostsForPicker(supabase, {
      workspaceId,
      titleQuery: query,
      ...(stage !== undefined ? { stage } : {}),
    }).then((result) => {
      if (cancelled) return;
      setError(result.ok ? null : result.error.message);
      setPosts(result.ok ? result.data : []);
      setLoadedKey(requestKey);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, workspaceId, filter, briefFilter, query, tab, requestKey]);

  const count = props.selected.length + props.selectedBriefs.length;

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Share a post or brief"
      footer={
        <Button variant="primary" size="lg" className="ml-auto" onClick={props.onClose}>
          {count > 0 ? `Done (${count})` : 'Done'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2" role="tablist">
          <Chip
            label="Posts"
            size="tap"
            selected={tab === 'posts'}
            onClick={() => setTab('posts')}
          />
          <Chip
            label="Briefs"
            size="tap"
            selected={tab === 'briefs'}
            onClick={() => setTab('briefs')}
          />
        </div>
        <Field label="Search">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
              <IconSearch size={16} />
            </span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tab === 'posts' ? 'Search all posts' : 'Search all briefs'}
              className="pl-9"
            />
          </div>
        </Field>

        {tab === 'posts' ? (
          <>
            <div className="flex flex-wrap gap-2">
              {POST_FILTERS.map((option) => (
                <Chip
                  key={option.key}
                  label={option.label}
                  size="tap"
                  selected={filter === option.key}
                  onClick={() => setFilter(option.key)}
                />
              ))}
            </div>

            <PostPickerList
              posts={posts}
              loading={loading}
              error={error}
              selected={props.selected}
              onToggle={props.onToggle}
              workspaceKey={workspaceKey}
              timeZone={timeZone}
            />
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {BRIEF_FILTERS.map((option) => (
                <Chip
                  key={option.key}
                  label={option.label}
                  size="tap"
                  selected={briefFilter === option.key}
                  onClick={() => setBriefFilter(option.key)}
                />
              ))}
            </div>

            <BriefPickerList
              briefs={briefs}
              loading={loading}
              error={error}
              selected={props.selectedBriefs}
              onToggle={props.onToggleBrief}
              workspaceKey={workspaceKey}
              timeZone={timeZone}
            />
          </>
        )}
      </div>
    </Sheet>
  );
}

function PostPickerList(props: {
  posts: PostPickerRow[];
  loading: boolean;
  error: string | null;
  selected: readonly PostCardFields[];
  onToggle: (post: PostCardFields) => void;
  workspaceKey: string | null;
  timeZone: string;
}): ReactElement {
  if (props.loading) {
    return <p className="px-1 py-3 text-sm text-fg-3">Loading posts</p>;
  }
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
      >
        {props.error}
      </div>
    );
  }
  if (props.posts.length === 0) {
    return (
      <EmptyState
        icon={<IconPipeline size={22} />}
        title="No posts"
        description="No posts match this filter."
      />
    );
  }
  return (
    <ul className="-mx-[18px] flex max-h-[50vh] flex-col overflow-y-auto border-t border-border">
      {props.posts.map((post) => {
        const active = isPostSelected(props.selected, post.id);
        const caption = post.caption?.trim() ?? '';
        const due =
          post.target_date !== null ? formatShortDate(post.target_date, props.timeZone) : '';
        return (
          <li key={post.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => props.onToggle(post)}
              className={rowClass(active)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg">
                    {post.title}
                  </span>
                  {props.workspaceKey !== null ? (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-fg-3">
                      {formatEntityRef(props.workspaceKey, post.number)}
                    </span>
                  ) : null}
                </span>
                {caption !== '' ? (
                  <span className="line-clamp-2 text-sm text-fg-2 [overflow-wrap:anywhere]">
                    {caption}
                  </span>
                ) : null}
                <span className="flex items-center gap-2">
                  <Tag label={formatLabel(post.format)} />
                  {due !== '' ? <span className="text-xs text-fg-2">{`Due ${due}`}</span> : null}
                  <span className="flex-1" />
                  {isTagDot(post.stage) ? (
                    <Tag label={stageLabel(post.stage)} dot={post.stage} />
                  ) : null}
                </span>
              </span>
              {active ? (
                <span className="shrink-0 pt-0.5 text-accent">
                  <IconCheck size={18} />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BriefPickerList(props: {
  briefs: BriefPickerRow[];
  loading: boolean;
  error: string | null;
  selected: readonly BriefCardFields[];
  onToggle: (brief: BriefCardFields) => void;
  workspaceKey: string | null;
  timeZone: string;
}): ReactElement {
  if (props.loading) {
    return <p className="px-1 py-3 text-sm text-fg-3">Loading briefs</p>;
  }
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
      >
        {props.error}
      </div>
    );
  }
  if (props.briefs.length === 0) {
    return (
      <EmptyState
        icon={<IconBriefs size={22} />}
        title="No briefs"
        description="No briefs match this filter."
      />
    );
  }
  return (
    <ul className="-mx-[18px] flex max-h-[50vh] flex-col overflow-y-auto border-t border-border">
      {props.briefs.map((brief) => {
        const active = isBriefSelected(props.selected, brief.id);
        const target = brief.targetDate !== null ? formatShortDateOnly(brief.targetDate) : '';
        return (
          <li key={brief.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => props.onToggle(brief)}
              className={rowClass(active)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg">
                    {brief.title}
                  </span>
                  {props.workspaceKey !== null ? (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-fg-3">
                      {formatEntityRef(props.workspaceKey, brief.number)}
                    </span>
                  ) : null}
                  <Tag
                    label={briefStatusLabel(brief.status)}
                    tone={brief.status === 'closed' ? 'neutral' : 'good'}
                  />
                </span>
                {brief.objective.trim() !== '' ? (
                  <span className="line-clamp-2 text-sm text-fg-2 [overflow-wrap:anywhere]">
                    {brief.objective}
                  </span>
                ) : null}
                <span className="flex flex-wrap items-center gap-2">
                  {brief.formatRequested !== null && brief.formatRequested !== '' ? (
                    <Tag label={formatLabel(brief.formatRequested)} />
                  ) : null}
                  {target !== '' ? (
                    <span className="text-xs text-fg-2">{`Target ${target}`}</span>
                  ) : null}
                  <span className="flex-1" />
                  <span className="text-xs text-fg-2">
                    {`${briefPostCountLabel(brief.postCount)} · Raised ${formatShortDate(brief.createdAt, props.timeZone)}`}
                  </span>
                </span>
              </span>
              {active ? (
                <span className="shrink-0 pt-0.5 text-accent">
                  <IconCheck size={18} />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
