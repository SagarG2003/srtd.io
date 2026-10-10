import { useEffect } from 'react';
import { driver } from 'driver.js';
import type { Driver } from 'driver.js';
import { callRpc } from '@/lib/rpc';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { logger } from '@/lib/logger';

function visibleTourTarget(name: string): Element {
  const target = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)).find(
    (element) => element.getClientRects().length > 0,
  );
  return target ?? document.body;
}

export function DashboardTour() {
  const { session } = useSession();
  const { loading, workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (loading || workspaceId === null || userId === null) return;

    let active = true;
    let tour: Driver | null = null;
    let seenWriteStarted = false;

    const markSeen = () => {
      if (seenWriteStarted) return;
      seenWriteStarted = true;
      void callRpc<boolean>('user_dashboard_tour_state', { p_mark_seen: true }, newTrace()).catch(
        (error: unknown) => {
          logger.error('dashboard tour completion save failed', { error: String(error) });
        },
      );
    };

    const startTour = async () => {
      const seen = await callRpc<boolean>(
        'user_dashboard_tour_state',
        { p_mark_seen: false },
        newTrace(),
      );
      if (!active || seen) return;

      tour = driver({
        animate: true,
        allowClose: true,
        allowScroll: true,
        overlayClickBehavior: 'close',
        disableActiveInteraction: true,
        smoothScroll: true,
        showProgress: true,
        progressText: '{{current}} of {{total}}',
        nextBtnText: 'Next',
        prevBtnText: 'Back',
        doneBtnText: 'Done',
        closeBtnLabel: 'Skip tour',
        popoverClass: 'sorted-dashboard-tour',
        onPopoverRender: (popover) => {
          popover.closeButton.textContent = 'Skip tour';
          popover.closeButton.setAttribute('aria-label', 'Skip tour');
          popover.title.style.paddingRight = '82px';
        },
        onDoneClick: (_element, _step, { driver: activeDriver }) => {
          markSeen();
          activeDriver.destroy();
        },
        onDestroyStarted: (_element, _step, { driver: activeDriver }) => {
          if (!active) return;
          markSeen();
          activeDriver.destroy();
        },
        steps: [
          {
            element: () => visibleTourTarget('nav-pipeline'),
            popover: {
              title: 'Pipeline',
              description: 'Your dashboard for posts moving through the approval workflow.',
              side: 'right',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('nav-briefs'),
            popover: {
              title: 'Briefs',
              description: 'Find the briefs that are client by clients.',
              side: 'right',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('nav-assets'),
            popover: {
              title: 'Assets',
              description: 'Browse the shared library of creative assets for your workspace.',
              side: 'right',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('nav-chat'),
            popover: {
              title: 'Chat',
              description: 'Talk with your team and clients in workspace conversations.',
              side: 'right',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('nav-activity'),
            popover: {
              title: 'Activity',
              description: 'Catch up on important changes and updates in your workspace.',
              side: 'right',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('pipeline-plan'),
            popover: {
              title: 'Plan',
              description:
                'See the week at a glance, grouped by target date. Plan is read-only and does not schedule or publish posts.',
              side: 'bottom',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('pipeline-draft'),
            popover: {
              title: 'Draft',
              description: 'Find posts that are still being prepared before they move into review.',
              side: 'bottom',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('pipeline-review'),
            popover: {
              title: 'Review',
              description: 'Posts here are ready for feedback and a decision.',
              side: 'bottom',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('pipeline-parked'),
            popover: {
              title: 'Parked',
              description: 'Keep posts here when a decision needs to wait.',
              side: 'bottom',
              align: 'start',
            },
          },
          {
            element: () => visibleTourTarget('pipeline-rejected'),
            popover: {
              title: 'Rejected',
              description: 'Find posts that were rejected, separate from the active review queue.',
              side: 'bottom',
              align: 'start',
            },
          },
        ],
      });
      tour.drive();
    };

    void startTour().catch((error: unknown) => {
      logger.error('dashboard tour status load failed', { error: String(error) });
    });

    return () => {
      active = false;
      tour?.destroy();
    };
  }, [loading, newTrace, userId, workspaceId]);

  return null;
}
