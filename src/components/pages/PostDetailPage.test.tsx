import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The page's import graph pulls the real agora-chat browser SDK. Mock it so
// importing the hookless rail and confirm in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { PcsApproveConfirm, StageButtons } from '@/components/pages/PostDetailPage';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';
import {
  GATE_IDLE,
  createApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { ApproveConfirm } from '@/components/ui/ApproveConfirm';
import type { Stage } from '@srtdio/posts';

function harness(): {
  gate: ReturnType<typeof createApproveGate>;
  move: ReturnType<typeof vi.fn<(postId: string, toStage: Stage) => void>>;
  state: () => GateState;
} {
  let state = GATE_IDLE;
  const move = vi.fn<(postId: string, toStage: Stage) => void>();
  const gate = createApproveGate({
    move,
    read: () => state,
    write: (next) => {
      state = next;
    },
  });
  return { gate, move, state: () => state };
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

/** The rail for a client in review, wired as the page wires it: through the gate. */
function rail(h: ReturnType<typeof harness>, stage: Stage, role: string): ReactElement[] {
  const all: ReactElement[] = [];
  collect(
    StageButtons({
      actions: visibleStageActions(stage, role),
      transitioning: false,
      onPick: (to) => h.gate.request('p1', to),
    }),
    all,
  );
  return all.filter((el) => typeof (el.props as { onClick?: unknown }).onClick === 'function');
}

function press(buttons: ReactElement[], label: string): void {
  const button = buttons.find((el) => (el.props as { children?: ReactNode }).children === label);
  expect(button).toBeDefined();
  (button?.props as { onClick: () => void }).onClick();
}

type ConfirmProps = Parameters<typeof ApproveConfirm>[0];

function sheet(
  h: ReturnType<typeof harness>,
  over: Partial<Parameters<typeof PcsApproveConfirm>[0]> = {},
): ReactElement {
  return PcsApproveConfirm({
    gate: h.gate,
    gateState: h.state(),
    refLabel: 'GBL-4',
    format: 'carousel',
    title: 'Diwali teaser',
    mediaCount: 3,
    targetDate: 'Oct 2',
    busy: false,
    error: null,
    ...over,
  });
}

function confirmOf(el: ReactElement): ConfirmProps {
  const footer = (el.props as { footer: ReactElement }).footer;
  expect(footer.type).toBe(ApproveConfirm);
  return footer.props as ConfirmProps;
}

function question(props: ConfirmProps): string {
  const all: ReactElement[] = [];
  collect(ApproveConfirm(props), all);
  const first = all.find((el) => el.type === 'p');
  return (first?.props as { children: string }).children;
}

describe('PCS approve confirm', () => {
  it('T1: Approve opens the confirm and does not call the transition', () => {
    const h = harness();
    expect((sheet(h).props as { open: boolean }).open).toBe(false);
    press(rail(h, 'review', 'client'), 'Approve');
    expect(h.move).not.toHaveBeenCalled();
    expect((sheet(h).props as { open: boolean }).open).toBe(true);
  });

  it('T2: Back and the Sheet close (button, backdrop, Escape) send nothing', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    confirmOf(sheet(h)).onBack();
    expect(h.state()).toEqual(GATE_IDLE);
    press(rail(h, 'review', 'client'), 'Approve');
    (sheet(h).props as { onClose: () => void }).onClose();
    expect(h.state()).toEqual(GATE_IDLE);
    expect(h.move).not.toHaveBeenCalled();
  });

  it('T3: Confirm calls the transition once with the same args as the old direct call', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    confirmOf(sheet(h)).onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
  });

  it('T4: a double tap sends once; Confirm disables in flight and re-arms after a failure', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    const props = confirmOf(sheet(h));
    props.onConfirm();
    props.onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(confirmOf(sheet(h)).busy).toBe(true);
    // The page settles a failed approve: the sheet stays open with the error.
    h.gate.settle();
    const failed = confirmOf(sheet(h, { error: 'Could not approve.' }));
    expect(failed.busy).toBe(false);
    expect(failed.error).toBe('Could not approve.');
    expect((sheet(h).props as { open: boolean }).open).toBe(true);
    // The page's own in-flight flag also disables it.
    expect(confirmOf(sheet(h, { busy: true })).busy).toBe(true);
  });

  it('T5: Reject, Park and Send for review call the transition at once, no confirm', () => {
    const cases: [Stage, string, string, Stage][] = [
      ['review', 'client', 'Reject', 'rejected'],
      ['review', 'admin', 'Park', 'parked'],
      ['draft', 'admin', 'Send for review', 'review'],
    ];
    for (const [stage, role, label, to] of cases) {
      const h = harness();
      press(rail(h, stage, role), label);
      expect(h.move).toHaveBeenCalledWith('p1', to);
      expect((sheet(h).props as { open: boolean }).open).toBe(false);
    }
  });

  it('T6: slide count from the loaded gallery and the target date when set; omitted when not', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    expect(question(confirmOf(sheet(h)))).toBe('Approve GBL-4, all 3 slides, for Oct 2?');
    expect(question(confirmOf(sheet(h, { mediaCount: null })))).toBe('Approve GBL-4, for Oct 2?');
    expect(question(confirmOf(sheet(h, { mediaCount: null, targetDate: '' })))).toBe(
      'Approve GBL-4?',
    );
    expect((sheet(h).props as { title: string }).title).toBe('GBL-4 · Carousel');
  });
});
