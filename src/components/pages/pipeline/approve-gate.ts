// The approve gate for the pipeline's two move surfaces (the mobile move sheet
// and the desktop board drop). A move into 'approved' parks the post until the
// user confirms; every other target passes straight through to the page's move
// handler, unchanged. Confirm fires the same handler once with the same args; a
// second tap before the move settles is dropped. The controller is plain
// functions over an injected read/write so it is unit tested without a DOM;
// useApproveGate binds it to React with a ref for the synchronous guard.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Stage } from '@srtdio/posts';

export type MoveFn = (postId: string, toStage: Stage) => void;

/** The post waiting on a confirm (null: none), and whether its approve was sent. */
export interface GateState {
  pendingId: string | null;
  sent: boolean;
}

export const GATE_IDLE: GateState = { pendingId: null, sent: false };

export interface ApproveGate {
  /** A move request: approve opens the confirm; any other target moves now. */
  request: MoveFn;
  /** Send the pending approve once. A no-op with nothing pending or already sent. */
  confirm: () => void;
  /** Cancel, backdrop, Escape, Back: forget the pending approve, send nothing. */
  cancel: () => void;
  /** The move settled without closing (a failure): allow one more confirm. */
  settle: () => void;
}

export function createApproveGate(deps: {
  move: MoveFn;
  read: () => GateState;
  write: (next: GateState) => void;
}): ApproveGate {
  return {
    request: (postId, toStage) => {
      if (toStage !== 'approved') {
        deps.move(postId, toStage);
        return;
      }
      deps.write({ pendingId: postId, sent: false });
    },
    confirm: () => {
      const { pendingId, sent } = deps.read();
      if (pendingId === null || sent) return;
      deps.write({ pendingId, sent: true });
      deps.move(pendingId, 'approved');
    },
    cancel: () => {
      deps.write(GATE_IDLE);
    },
    settle: () => {
      const state = deps.read();
      if (state.sent) deps.write({ ...state, sent: false });
    },
  };
}

/** The gate bound to React: state re-renders, the ref answers the double-tap guard. */
export function useApproveGate(move: MoveFn): { gate: ApproveGate; state: GateState } {
  const [state, setState] = useState<GateState>(GATE_IDLE);
  const stateRef = useRef<GateState>(GATE_IDLE);
  const moveRef = useRef<MoveFn>(move);
  useEffect(() => {
    moveRef.current = move;
  }, [move]);
  const gate = useMemo(
    () =>
      createApproveGate({
        move: (postId, toStage) => moveRef.current(postId, toStage),
        read: () => stateRef.current,
        write: (next) => {
          stateRef.current = next;
          setState(next);
        },
      }),
    [],
  );
  return { gate, state };
}
