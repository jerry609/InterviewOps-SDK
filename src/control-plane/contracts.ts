export const CONTROL_PLANE_OPERATION_KINDS = [
  'harvest',
  'hydrate',
  'comments',
  'normalize',
  'export',
  'validate',
] as const;

export type ControlPlaneOperationKind =
  (typeof CONTROL_PLANE_OPERATION_KINDS)[number];

export type ControlPlaneObjective =
  | 'collect'
  | 'stabilize-hydrate'
  | 'stabilize-comments'
  | 'clean-questions'
  | 'export';

export type ControlPlaneOperation =
  | { kind: 'harvest'; reason: string; query_limit?: number }
  | { kind: 'hydrate'; reason: string; limit?: number }
  | { kind: 'comments'; reason: string; limit?: number }
  | { kind: 'normalize'; reason: string }
  | { kind: 'export'; reason: string }
  | { kind: 'validate'; reason: string };

export type BacklogSnapshot = {
  due_queries: number;
  pending_hydrate: number;
  pending_comments: number;
  notes_total: number;
  strict_export_ready: boolean;
};

export type ControlPlaneJournalEvent =
  | {
      type: 'decision.select_operation';
      at: string;
      operation: ControlPlaneOperation;
      backlog: BacklogSnapshot;
    }
  | { type: 'operation.started'; at: string; operation: ControlPlaneOperation }
  | {
      type: 'operation.succeeded';
      at: string;
      operation: ControlPlaneOperation;
      detail: string;
    }
  | {
      type: 'operation.failed';
      at: string;
      operation: ControlPlaneOperation;
      error: string;
    }
  | {
      type: 'circuit.opened';
      at: string;
      circuit: string;
      reason: string;
      open_until: string | null;
    };

export type ControlPlaneState = {
  scheduler_mode: 'polling' | 'degraded-local' | 'paused';
  objective: ControlPlaneObjective;
  last_decision_at: string | null;
  last_decision_reason: string | null;
  active_operation: ControlPlaneOperation | null;
  cooldowns: Partial<Record<ControlPlaneOperationKind, string>>;
  circuits: Record<
    string,
    { opened_at: string; open_until: string | null; reason: string }
  >;
  backlog_snapshot: BacklogSnapshot | null;
};

export function createEmptyControlPlaneState(): ControlPlaneState {
  return {
    scheduler_mode: 'polling',
    objective: 'collect',
    last_decision_at: null,
    last_decision_reason: null,
    active_operation: null,
    cooldowns: {},
    circuits: {},
    backlog_snapshot: null,
  };
}
