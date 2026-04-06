import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { InterviewOpsPipeline } from '../pipeline.js';
import { executeControlPlaneOperation } from './executor.js';

function createPipelineFixture(queries = ['alpha']) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewops-control-plane-executor-'));
  const dataDir = path.join(workspace, 'interview_data');
  const reportDir = path.join(workspace, 'reports/xhs-miangjing');
  const prdPath = path.join(workspace, 'interviewops.xhs.json');
  const statePath = path.join(dataDir, 'xhs_state.json');
  const notesPath = path.join(dataDir, 'xhs_notes.json');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    prdPath,
    JSON.stringify({
      source: 'xiaohongshu',
      queries,
      dataDir: './interview_data',
      reportDir: './reports/xhs-miangjing',
      stateFile: './interview_data/xhs_state.json',
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(notesPath, JSON.stringify([], null, 2), 'utf8');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      updated_at: '2026-04-06T09:00:00+08:00',
      queries: {},
    }, null, 2),
    'utf8',
  );

  const pipeline = new InterviewOpsPipeline({
    workspace,
    prdPath,
    autoCommit: false,
    progressLogPath: path.join(reportDir, 'progress.log'),
  });

  return { pipeline, statePath };
}

function readState(statePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;
}

function readJournalRows(journalPath: string): Array<Record<string, any>> {
  if (!fs.existsSync(journalPath)) {
    return [];
  }

  const content = fs.readFileSync(journalPath, 'utf8').trim();
  if (!content) {
    return [];
  }

  return content.split('\n').map((line) => JSON.parse(line));
}

describe('executeControlPlaneOperation', () => {
  it('runs harvest operations, clears active state, and records started plus succeeded events', () => {
    const { pipeline, statePath } = createPipelineFixture();
    const operation = {
      kind: 'harvest' as const,
      reason: 'due query backlog exceeds threshold',
    };
    let record: Record<string, any> | null = null;

    const harvest = vi.spyOn(pipeline, 'harvestIncremental').mockImplementation(() => {
      const startedState = pipeline.readState();
      const recordLastRunAt = startedState.control_plane?.last_decision_at || startedState.updated_at;

      expect(startedState.control_plane).toMatchObject({
        active_operation: operation,
        last_decision_reason: operation.reason,
      });
      expect(startedState.control_plane?.last_decision_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      record = {
        stage: 'harvest' as const,
        last_run_at: recordLastRunAt,
        ok: true,
        detail: 'queries=1, due_queries=1, rows=3, added=2, errors=0',
      };

      startedState.operations = {
        ...(startedState.operations || {}),
        harvest: record,
      };
      startedState.updated_at = recordLastRunAt;
      pipeline.writeState(startedState);
    });

    const result = executeControlPlaneOperation(pipeline, operation);
    const state = readState(statePath);
    const journalRows = readJournalRows(pipeline.controlPlaneJournalPath);

    expect(harvest).toHaveBeenCalledTimes(1);
    expect(result).toEqual(record);
    expect(state.control_plane).toMatchObject({
      active_operation: null,
      last_decision_reason: operation.reason,
    });
    expect(state.control_plane.last_decision_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(journalRows).toEqual([
      {
        type: 'operation.started',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
      },
      {
        type: 'operation.succeeded',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
        detail: record.detail,
      },
    ]);
  });

  it('clears active state and records a failed event when the startup journal write throws', () => {
    const { pipeline, statePath } = createPipelineFixture();
    const operation = {
      kind: 'harvest' as const,
      reason: 'journal write failure during startup must not wedge the control plane',
    };

    vi.spyOn(pipeline, 'appendControlPlaneEvent')
      .mockImplementationOnce(() => {
        throw new Error('journal unavailable');
      });

    expect(() => executeControlPlaneOperation(pipeline, operation)).toThrow('journal unavailable');

    const state = readState(statePath);
    const journalRows = readJournalRows(pipeline.controlPlaneJournalPath);

    expect(state.control_plane).toMatchObject({
      scheduler_mode: 'degraded-local',
      active_operation: null,
      last_decision_reason: operation.reason,
    });
    expect(journalRows).toEqual([
      {
        type: 'operation.failed',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
        error: 'journal unavailable',
      },
    ]);
  });

  it('fails when the stage does not write a fresh post-stage record', () => {
    const { pipeline, statePath } = createPipelineFixture();
    const operation = {
      kind: 'harvest' as const,
      reason: 'a stale preexisting record must not be treated as success',
    };
    const staleRecord = {
      stage: 'harvest' as const,
      last_run_at: '2026-04-05T23:59:59+08:00',
      ok: true,
      detail: 'stale record',
    };
    const initialState = pipeline.readState();

    initialState.operations = { harvest: staleRecord };
    initialState.updated_at = staleRecord.last_run_at;
    pipeline.writeState(initialState);

    vi.spyOn(pipeline, 'harvestIncremental').mockImplementation(() => {});

    expect(() => executeControlPlaneOperation(pipeline, operation)).toThrow('missing fresh operation record for stage harvest');

    const state = readState(statePath);
    const journalRows = readJournalRows(pipeline.controlPlaneJournalPath);

    expect(state.operations?.harvest).toEqual(staleRecord);
    expect(state.control_plane).toMatchObject({
      scheduler_mode: 'degraded-local',
      active_operation: null,
      last_decision_reason: operation.reason,
    });
    expect(journalRows).toEqual([
      {
        type: 'operation.started',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
      },
      {
        type: 'operation.failed',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
        error: 'missing fresh operation record for stage harvest',
      },
    ]);
  });

  it('clears active state and records a failed event when the stage throws', () => {
    const { pipeline, statePath } = createPipelineFixture();
    const operation = {
      kind: 'harvest' as const,
      reason: 'stage failures must degrade the scheduler locally',
    };

    vi.spyOn(pipeline, 'harvestIncremental').mockImplementation(() => {
      throw new Error('search backend unavailable');
    });

    expect(() => executeControlPlaneOperation(pipeline, operation)).toThrow('search backend unavailable');

    const state = readState(statePath);
    const journalRows = readJournalRows(pipeline.controlPlaneJournalPath);

    expect(state.control_plane).toMatchObject({
      scheduler_mode: 'degraded-local',
      active_operation: null,
      last_decision_reason: operation.reason,
    });
    expect(journalRows).toEqual([
      {
        type: 'operation.started',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
      },
      {
        type: 'operation.failed',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        operation,
        error: 'search backend unavailable',
      },
    ]);
  });

  it('honors harvest query_limit by capping selected queries in the pipeline harvest path', () => {
    const { pipeline, statePath } = createPipelineFixture(['alpha', 'beta']);
    const search = vi.fn()
      .mockImplementation((query: string) => [{
        url: `https://www.xiaohongshu.com/explore/${query}-note-1`,
        title: `${query} result`,
        author: `${query}-author`,
        published_at: '2026-04-06',
      }]);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search,
      comments: vi.fn(),
      detail: vi.fn(),
    };

    pipeline.harvestIncremental(1);

    const state = readState(statePath);

    expect(search).toHaveBeenCalledTimes(1);
    expect(Object.keys(state.queries)).toHaveLength(1);
    expect(pipeline.status().operations[0]).toMatchObject({
      stage: 'harvest',
      detail: expect.stringContaining('queries=1'),
    });
  });
});
