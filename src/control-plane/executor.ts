import { nowIsoUtc8 } from '../heuristics.js';
import type { InterviewOpsPipeline } from '../pipeline.js';
import type { PipelineOperationRecord, PipelineStageName } from '../types.js';
import type { ControlPlaneOperation, ControlPlaneOperationKind } from './contracts.js';

const OPERATION_STAGE_MAP = {
  harvest: 'harvest',
  hydrate: 'hydrate',
  comments: 'comments',
  normalize: 'normalize',
  export: 'export',
  validate: 'validate',
} as const satisfies Record<ControlPlaneOperationKind, PipelineStageName>;

type ControlPlaneExecutorPipeline = Pick<
  InterviewOpsPipeline,
  | 'appendControlPlaneEvent'
  | 'enrichComments'
  | 'exportAll'
  | 'harvestIncremental'
  | 'hydrateDetails'
  | 'normalizeQuestionsAndSellerFlags'
  | 'readState'
  | 'validate'
  | 'writeControlPlaneState'
>;

export function executeControlPlaneOperation(
  pipeline: ControlPlaneExecutorPipeline,
  operation: ControlPlaneOperation,
): PipelineOperationRecord {
  const startedAt = nowIsoUtc8();

  pipeline.writeControlPlaneState((current) => ({
    ...current,
    active_operation: operation,
    last_decision_at: startedAt,
    last_decision_reason: operation.reason,
  }));
  pipeline.appendControlPlaneEvent({
    type: 'operation.started',
    at: startedAt,
    operation,
  });

  try {
    runStageOperation(pipeline, operation);

    const record = pipeline.readState().operations?.[OPERATION_STAGE_MAP[operation.kind]];
    if (!record) {
      throw new Error(`missing operation record for stage ${OPERATION_STAGE_MAP[operation.kind]}`);
    }

    pipeline.writeControlPlaneState((current) => ({
      ...current,
      active_operation: null,
    }));
    pipeline.appendControlPlaneEvent({
      type: 'operation.succeeded',
      at: nowIsoUtc8(),
      operation,
      detail: record.detail,
    });

    return record;
  } catch (error) {
    pipeline.writeControlPlaneState((current) => ({
      ...current,
      scheduler_mode: 'degraded-local',
      active_operation: null,
    }));
    pipeline.appendControlPlaneEvent({
      type: 'operation.failed',
      at: nowIsoUtc8(),
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function runStageOperation(
  pipeline: ControlPlaneExecutorPipeline,
  operation: ControlPlaneOperation,
): void {
  switch (operation.kind) {
    case 'harvest':
      pipeline.harvestIncremental();
      return;
    case 'hydrate':
      pipeline.hydrateDetails(operation.limit);
      return;
    case 'comments':
      pipeline.enrichComments(operation.limit);
      return;
    case 'normalize':
      pipeline.normalizeQuestionsAndSellerFlags(true);
      return;
    case 'export':
      pipeline.exportAll();
      return;
    case 'validate':
      pipeline.validate(true);
      return;
  }
}
