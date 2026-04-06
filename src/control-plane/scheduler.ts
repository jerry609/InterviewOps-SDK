import type { BacklogSnapshot, ControlPlaneOperation } from './contracts.js';

export type ControlStatusSnapshot = {
  workspace: string;
  config_path: string;
  backlog: BacklogSnapshot;
  control_plane: unknown;
  recent_operations: unknown[];
};

export function chooseFallbackOperation(snapshot: Pick<ControlStatusSnapshot, 'backlog'>): ControlPlaneOperation {
  const { backlog } = snapshot;

  if (backlog.pending_hydrate > 0) {
    return {
      kind: 'hydrate',
      reason: 'pending hydrate backlog dominates current cycle',
      limit: 12,
    };
  }

  if (backlog.pending_comments > 0) {
    return {
      kind: 'comments',
      reason: 'pending comments backlog dominates current cycle',
      limit: 8,
    };
  }

  if (backlog.due_queries > 0) {
    return {
      kind: 'harvest',
      reason: 'due search queries require a harvest pass',
      query_limit: backlog.due_queries,
    };
  }

  if (backlog.strict_export_ready) {
    return {
      kind: 'export',
      reason: 'strict export-ready backlog snapshot reached',
    };
  }

  return {
    kind: 'validate',
    reason: 'no higher-priority backlog found; validate workspace state',
  };
}

export function renderRunOperationArgs(
  operation: ControlPlaneOperation,
  workspace: string,
  prdPath: string,
): string[] {
  const args = [
    '--import',
    'tsx',
    'src/cli.ts',
    'run-operation',
    operation.kind,
    '--workspace',
    workspace,
    '--prd',
    prdPath,
  ];

  if ('query_limit' in operation && operation.query_limit !== undefined) {
    args.push('--limit', String(operation.query_limit));
  }
  if ('limit' in operation && operation.limit !== undefined) {
    args.push('--limit', String(operation.limit));
  }

  args.push('--reason', operation.reason);
  return args;
}
