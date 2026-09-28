// Renders the briefs shared into one message as cards, mirroring PostCard: the
// message's ids resolve in ONE workspace-scoped RLS read, keyed on the ids so a
// re-render never re-reads. A brief the viewer cannot see renders as an
// "unavailable" card. Tapping a card opens the brief in the app.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tag } from '@/components/ui/Tag';
import { SHARED_CARD } from '@/components/chat/PostCard';
import { IconBriefs } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import {
  briefRoute,
  briefStatusLabel,
  readBriefsByIds,
  sharedBriefViews,
  type BriefCardFields,
  type SharedBriefView,
} from '@/lib/chat/briefs';

function useSharedBriefs(briefIds: string[]): { views: SharedBriefView[]; loading: boolean } {
  const { workspaceId } = useWorkspace();
  const [briefs, setBriefs] = useState<BriefCardFields[]>([]);
  const [loading, setLoading] = useState(true);
  const key = briefIds.join(',');

  useEffect(() => {
    if (workspaceId === null || briefIds.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readBriefsByIds(supabase, { workspaceId, ids: briefIds }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      setBriefs(result.ok ? result.data : []);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for the id list; a new array with the same ids never re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId]);

  const views = useMemo(() => sharedBriefViews(briefIds, briefs), [briefIds, briefs]);
  return { views, loading };
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
