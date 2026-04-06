import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { InterviewOpsPipeline } from '../pipeline.js';
import { executeControlPlaneOperation } from './executor.js';

function createPipelineFixture() {
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
      queries: ['alpha'],
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

describe('executeControlPlaneOperation', () => {
  it('runs harvest operations, clears active state, and records started plus succeeded events', () => {
    const { pipeline, statePath } = createPipelineFixture();
    const operation = {
      kind: 'harvest' as const,
      reason: 'due query backlog exceeds threshold',
    };
    const record = {
      stage: 'harvest' as const,
      last_run_at: '2026-04-06T10:00:00+08:00',
      ok: true,
      detail: 'queries=1, due_queries=1, rows=3, added=2, errors=0',
    };

    const harvest = vi.spyOn(pipeline, 'harvestIncremental').mockImplementation(() => {
      const startedState = pipeline.readState();

      expect(startedState.control_plane).toMatchObject({
        active_operation: operation,
        last_decision_reason: operation.reason,
      });
      expect(startedState.control_plane?.last_decision_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      startedState.operations = {
        ...(startedState.operations || {}),
        harvest: record,
      };
      startedState.updated_at = record.last_run_at;
      pipeline.writeState(startedState);
    });

    const result = executeControlPlaneOperation(pipeline, operation);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;
    const journalRows = fs.readFileSync(pipeline.controlPlaneJournalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

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
});
