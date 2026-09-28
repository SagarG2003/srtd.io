// Small, framework-free pieces of the thread's actions, kept out of the React
// hook so their ordering and guards are unit-tested directly: the in-flight
// guard that makes a double-tapped action run once, and the reaction flow that
// only signals peers after the record holds the reaction. Sends and their
// retries run in the background outbox sender (send-flow.ts).

import type { WriteResult } from '@/lib/chat/record';

/** One-at-a-time guard keyed by message id. */
export interface InFlightGuard {
  /** True (and marks it busy) when the id is idle; false when already in flight. */
  tryStart: (id: string) => boolean;
  finish: (id: string) => void;
}

export function createInFlightGuard(): InFlightGuard {
  const busy = new Set<string>();
  return {
    tryStart: (id) => {
      if (busy.has(id)) return false;
      busy.add(id);
      return true;
    },
    finish: (id) => {
      busy.delete(id);
    },
  };
}

/**
 * Record a reaction, then signal peers only once the record accepted it. A
 * failed record reverts the optimistic change and sends no signal.
 */
export async function recordThenSignal(steps: {
  record: () => Promise<WriteResult>;
  signal: () => Promise<unknown>;
  onRecordFailed: (message: string) => void;
  onSignalFailed: (error: unknown) => void;
}): Promise<void> {
  const result = await steps.record();
  if (!result.ok) {
    steps.onRecordFailed(result.message);
    return;
  }
  try {
    await steps.signal();
  } catch (error) {
    steps.onSignalFailed(error);
  }
}
