// Renders the briefs shared into one message as cards, mirroring PostCard: the
// ids resolve through the thread's card cache, so every brief shared across the
// loaded thread comes back in ONE workspace-scoped RLS read (chunks of 100, 5s
// each), never one read per bubble. A brief the viewer cannot see, or whose
// read failed or timed out, renders as an "unavailable" card. Tapping a card
// opens the brief in the app.

import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tag } from '@/components/ui/Tag';
import { SHARED_CARD, useThreadCardCache } from '@/components/chat/PostCard';
import { IconBriefs } from '@/components/ui/icons';
import {
  briefRoute,
  briefStatusLabel,
  sharedBriefViews,
  type SharedBriefView,
} from '@/lib/chat/briefs';

function useSharedBriefs(briefIds: string[]): { views: SharedBriefView[]; loading: boolean } {
  const cache = useThreadCardCache();
  const key = briefIds.join(',');
  const idsRef = useRef(briefIds);
  idsRef.current = briefIds;

  useEffect(() => {
    if (idsRef.current.length > 0) cache?.request({ briefIds: idsRef.current });
  }, [cache, key]);

  const snapshot =
    cache !== null && briefIds.length > 0 ? cache.briefs(briefIds) : { loading: false, briefs: [] };
  const version = cache?.version() ?? 0;
  const views = useMemo(
    () => sharedBriefViews(briefIds, snapshot.briefs),
    // The snapshot is keyed by the ids and the cache version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, cache, version],
  );
  return { views, loading: snapshot.loading };
}

export function SharedBriefCards({ briefIds }: { briefIds: string[] }): ReactElement {
  const { views, loading } = useSharedBriefs(briefIds);
  if (briefIds.length === 0) return <></>;
  if (loading) {
    return (
      <div className="mt-1.5 flex flex-col items-start gap-1.5">
        {briefIds.map((id) => (
          <div
            key={id}
            className="h-[54px] w-[240px] animate-pulse rounded-lg border border-border bg-panel-2"
          />
        ))}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {views.map((view) => (
        <BriefCardItem key={view.briefId} view={view} />
      ))}
    </div>
  );
}

function BriefCardItem({ view }: { view: SharedBriefView }): ReactElement {
  const navigate = useNavigate();
  if (view.kind === 'unavailable') {
    return (
      <div className={`${SHARED_CARD} text-fg-3`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3">
          <IconBriefs size={18} />
        </span>
        <span className="text-sm font-medium">Brief unavailable</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Open brief ${view.title}`}
      onClick={() => navigate(briefRoute(view.briefId))}
      className={`${SHARED_CARD} text-left transition-colors hover:bg-panel-2`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconBriefs size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium text-fg" title={view.title}>
          {view.title}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-fg-3">
          <Tag label={briefStatusLabel(view.status)} />
        </span>
      </span>
    </button>
  );
}
