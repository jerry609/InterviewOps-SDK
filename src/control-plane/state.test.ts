import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InterviewOpsPipeline } from '../pipeline.js';
import { createEmptyControlPlaneState } from './contracts.js';
import {
  buildBacklogSnapshot,
  ensureControlPlaneState,
  resolveControlPlaneJournalPath,
} from './state.js';

function buildNote(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    note_id: 'note-1',
    url: 'https://www.xiaohongshu.com/explore/note-1',
    title: 'Agent 算法面经',
    query: 'Agent 面经',
    first_seen_at: '2026-04-02T00:00:00+08:00',
    last_seen_at: '2026-04-02T00:00:00+08:00',
    crawl_source: 'opencli:xiaohongshu/search',
    interview_questions: [],
    ...overrides,
  };
}

function createPipelineFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewops-control-plane-'));
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
      queries: ['alpha', 'beta'],
      dataDir: './interview_data',
      reportDir: './reports/xhs-miangjing',
      stateFile: './interview_data/xhs_state.json',
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    notesPath,
    JSON.stringify([
      buildNote({
        note_id: 'n1',
        content: null,
        comments: null,
        detail_next_attempt_after: null,
        comment_next_attempt_after: null,
      }),
      buildNote({
        note_id: 'n2',
        url: 'https://www.xiaohongshu.com/explore/note-2',
        title: 'KV cache 面经',
        query: 'KV 优化',
        content: '聊了 KV cache 命中率优化',
        comments: [],
        detail_next_attempt_after: null,
        comment_next_attempt_after: null,
      }),
    ], null, 2),
    'utf8',
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      updated_at: '2026-04-06T09:00:00+08:00',
      queries: {
        alpha: {
          last_run_at: '2026-04-06T08:00:00+08:00',
          newest_published_at: null,
          last_result_count: 0,
          next_run_after: null,
        },
        beta: {
          last_run_at: '2026-04-06T08:00:00+08:00',
          newest_published_at: null,
          last_result_count: 0,
          next_run_after: '2099-01-01T00:00:00+08:00',
        },
      },
      operations: {
        export: {
          stage: 'export',
          last_run_at: '2026-04-06T08:00:00+08:00',
          ok: true,
          detail: 'rows=1',
        },
        harvest: {
          stage: 'harvest',
          last_run_at: '2026-04-06T08:30:00+08:00',
          ok: true,
          detail: 'added=2',
        },
      },
    }, null, 2),
    'utf8',
  );

  const pipeline = new InterviewOpsPipeline({
    workspace,
    prdPath,
    autoCommit: false,
    progressLogPath: path.join(reportDir, 'progress.log'),
  });

  return { pipeline, workspace, reportDir, prdPath, statePath };
}

describe('buildBacklogSnapshot', () => {
  it('counts due queries and pending note work from workspace state', () => {
    const snapshot = buildBacklogSnapshot(
      [
        {
          note_id: 'n1',
          content: null,
          comments: null,
          interview_questions: [],
          detail_next_attempt_after: null,
          comment_next_attempt_after: null,
        },
        {
          note_id: 'n2',
          content: 'done',
          comments: null,
          interview_questions: ['q1'],
          detail_next_attempt_after: null,
          comment_next_attempt_after: null,
        },
      ] as any,
      {
        version: 1,
        updated_at: '2026-04-06T10:00:00+08:00',
        queries: {
          alpha: {
            last_run_at: '2026-04-06T09:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            next_run_after: null,
          },
          beta: {
            last_run_at: '2026-04-06T09:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            next_run_after: '2099-01-01T00:00:00+08:00',
          },
        },
      } as any,
      { queries: ['alpha', 'beta'] } as any,
      Date.parse('2026-04-06T10:00:00+08:00'),
    );

    expect(snapshot.due_queries).toBe(1);
    expect(snapshot.pending_hydrate).toBe(1);
    expect(snapshot.pending_comments).toBe(2);
    expect(snapshot.notes_total).toBe(2);
    expect(snapshot.strict_export_ready).toBe(false);
  });
});

describe('control-plane state helpers', () => {
  it('normalizes missing control-plane fields onto the default shape', () => {
    const fallback = ensureControlPlaneState({
      version: 1,
      updated_at: '2026-04-06T10:00:00+08:00',
      queries: {},
    } as any);
    const partial = ensureControlPlaneState({
      version: 1,
      updated_at: '2026-04-06T10:00:00+08:00',
      queries: {},
      control_plane: {
        objective: 'export',
      },
    } as any);

    expect(fallback).toEqual(createEmptyControlPlaneState());
    expect(partial).toEqual({
      ...createEmptyControlPlaneState(),
      objective: 'export',
    });
  });

  it('builds pipeline snapshots and persists control-plane state and journal events', () => {
    const { pipeline, workspace, reportDir, prdPath, statePath } = createPipelineFixture();
    const activeOperation = {
      kind: 'hydrate' as const,
      reason: 'pending hydrate backlog dominates current cycle',
      limit: 2,
    };

    expect(pipeline.controlPlaneJournalPath).toBe(resolveControlPlaneJournalPath(reportDir));

    const snapshot = pipeline.readControlPlaneSnapshot();
    expect(snapshot).toMatchObject({
      workspace,
      config_path: prdPath,
      backlog: {
        due_queries: 1,
        pending_hydrate: 1,
        pending_comments: 1,
        notes_total: 2,
        strict_export_ready: false,
      },
      control_plane: {
        scheduler_mode: 'polling',
        objective: 'collect',
        active_operation: null,
        backlog_snapshot: {
          due_queries: 1,
          pending_hydrate: 1,
          pending_comments: 1,
          notes_total: 2,
          strict_export_ready: false,
        },
      },
      recent_operations: [
        expect.objectContaining({
          stage: 'harvest',
          ok: true,
          detail: 'added=2',
        }),
        expect.objectContaining({
          stage: 'export',
          ok: true,
          detail: 'rows=1',
        }),
      ],
    });

    pipeline.writeControlPlaneState((current) => ({
      ...current,
      scheduler_mode: 'degraded-local',
      objective: 'stabilize-hydrate',
      last_decision_at: '2026-04-06T10:00:00+08:00',
      last_decision_reason: activeOperation.reason,
      active_operation: activeOperation,
      backlog_snapshot: snapshot.backlog,
    }));
    pipeline.appendControlPlaneEvent({
      type: 'operation.started',
      at: '2026-04-06T10:00:00+08:00',
      operation: activeOperation,
    });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;
    const statusPath = path.join(reportDir, 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, any>;
    const journalRows = fs.readFileSync(pipeline.controlPlaneJournalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(state.control_plane).toMatchObject({
      scheduler_mode: 'degraded-local',
      objective: 'stabilize-hydrate',
      last_decision_reason: activeOperation.reason,
      active_operation: activeOperation,
      backlog_snapshot: snapshot.backlog,
    });
    expect(status.updated_at).toBe(state.updated_at);
    expect(journalRows).toEqual([
      {
        type: 'operation.started',
        at: '2026-04-06T10:00:00+08:00',
        operation: activeOperation,
      },
    ]);
  });
});
