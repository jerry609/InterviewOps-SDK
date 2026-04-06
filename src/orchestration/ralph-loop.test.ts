import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./omx.js', () => ({
  runStableOmx: vi.fn(),
}));

vi.mock('../process.js', () => ({
  runProcess: vi.fn(),
  runProcessOrThrow: vi.fn(),
}));

import { buildAgentAlgoLlmRalphTask, runRalphLoop } from './ralph-loop.js';
import { runStableOmx } from './omx.js';
import { runProcess } from '../process.js';

type BacklogSnapshot = {
  due_queries: number;
  pending_hydrate: number;
  pending_comments: number;
  notes_total: number;
  strict_export_ready: boolean;
};

type ProcessResult = {
  stdout: string;
  stderr: string;
  status: number;
};

const sampleRepoRoot = '/repo';
const sampleWorkspace = '/workspace';
const samplePrdPath = `${sampleWorkspace}/interviewops.xhs.json`;
const testTempRoot = path.resolve('.tmp-tests');
const defaultLoopArgs = {
  iterations: 1,
  sleepSeconds: 1,
  autoCommit: false,
};

function buildBacklog(overrides: Partial<BacklogSnapshot> = {}): BacklogSnapshot {
  return {
    due_queries: 0,
    pending_hydrate: 0,
    pending_comments: 0,
    notes_total: 0,
    strict_export_ready: false,
    ...overrides,
  };
}

function buildControlStatus(workspace: string, backlog: BacklogSnapshot) {
  return {
    workspace,
    config_path: path.join(workspace, 'interviewops.xhs.json'),
    backlog,
    control_plane: {
      scheduler_mode: 'polling',
      objective: 'collect',
      last_decision_at: null,
      last_decision_reason: null,
      active_operation: null,
      cooldowns: {},
      circuits: {},
      backlog_snapshot: null,
    },
    recent_operations: [],
  };
}

function createFixtureDir(prefix: string): string {
  fs.mkdirSync(testTempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testTempRoot, `${prefix}-`));
}

function prdPathFor(workspace: string): string {
  return path.join(workspace, 'interviewops.xhs.json');
}

function logPathFor(workspace: string): string {
  return path.join(workspace, 'reports/xhs-agent-algo-feb2026/ralph-loop.log');
}

function fallbackLogsDir(workspace: string): string {
  return path.join(workspace, '.omx/logs');
}

function createRalphFixture({
  activeRalph = false,
  writePrd = true,
}: {
  activeRalph?: boolean;
  writePrd?: boolean;
} = {}) {
  const repoRoot = createFixtureDir('ralph-loop-repo');
  const workspace = path.join(repoRoot, 'workspaces/xhs-agent-algo-feb2026');
  const prdPath = prdPathFor(workspace);

  fs.mkdirSync(workspace, { recursive: true });
  if (writePrd) {
    writeFixturePrd(workspace);
  }
  if (activeRalph) {
    fs.mkdirSync(path.join(workspace, '.omx/state'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.omx/state/ralph.json'),
      JSON.stringify({ mode: 'ralph', active: true }, null, 2),
      'utf8',
    );
  }

  return { repoRoot, workspace, prdPath };
}

function writeFixturePrd(workspace: string): void {
  fs.writeFileSync(
    prdPathFor(workspace),
    JSON.stringify({
      source: 'xiaohongshu',
      queries: [],
      dataDir: './interview_data',
      reportDir: './reports/xhs-agent-algo-feb2026',
      stateFile: './interview_data/xhs_agent_algo_feb2026_state.json',
    }, null, 2),
    'utf8',
  );
}

function writeWorkspaceStateFixture(
  workspace: string,
  {
    queries = [],
    notes = [],
    stateQueries = {},
  }: {
    queries?: string[];
    notes?: Array<Record<string, unknown>>;
    stateQueries?: Record<string, unknown>;
  },
): void {
  const dataDir = path.join(workspace, 'interview_data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'interviewops.xhs.json'), JSON.stringify({
    source: 'xiaohongshu',
    queries,
    dataDir: './interview_data',
    reportDir: './reports/xhs-agent-algo-feb2026',
    stateFile: './interview_data/xhs_agent_algo_feb2026_state.json',
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'xhs_notes.json'), JSON.stringify(notes, null, 2), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'xhs_agent_algo_feb2026_state.json'), JSON.stringify({
    version: 1,
    updated_at: '2026-04-03T00:00:00+08:00',
    queries: stateQueries,
  }, null, 2), 'utf8');
}

function recordFreshOperation(
  workspace: string,
  stage: 'harvest' | 'hydrate' | 'comments' | 'normalize' | 'export' | 'validate' = 'validate',
  detail = 'omx executed one control-plane operation',
): void {
  const prd = JSON.parse(fs.readFileSync(path.join(workspace, 'interviewops.xhs.json'), 'utf8')) as Record<string, any>;
  const statePath = path.resolve(workspace, String(prd.stateFile || './interview_data/xhs_agent_algo_feb2026_state.json'));
  const journalPath = path.resolve(workspace, String(prd.reportDir || './reports/xhs-miangjing'), 'operation_journal.jsonl');
  const at = new Date().toISOString();
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>
    : { version: 1, updated_at: at, queries: {} };

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });

  state.updated_at = at;
  state.operations = {
    ...(state.operations || {}),
    [stage]: {
      stage,
      last_run_at: at,
      ok: true,
      detail,
    },
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  fs.appendFileSync(journalPath, `${JSON.stringify({
    type: 'operation.succeeded',
    at,
    operation: {
      kind: stage,
      reason: detail,
    },
    detail,
  })}\n`, 'utf8');
}

function buildControlStatusResult(
  workspace: string,
  backlog: BacklogSnapshot,
  {
    status = 0,
    stderr = '',
  }: {
    status?: number;
    stderr?: string;
  } = {},
): ProcessResult {
  return {
    stdout: `${JSON.stringify(buildControlStatus(workspace, backlog), null, 2)}\n`,
    stderr,
    status,
  };
}

function buildProcessResult(
  stdout: string,
  {
    status = 0,
    stderr = '',
  }: {
    status?: number;
    stderr?: string;
  } = {},
): ProcessResult {
  return { stdout, stderr, status };
}

function queueControlStatusResults(workspace: string, ...backlogs: BacklogSnapshot[]) {
  const mockedRunProcess = vi.mocked(runProcess);

  for (const backlog of backlogs) {
    mockedRunProcess.mockReturnValueOnce(buildControlStatusResult(workspace, backlog));
  }

  return mockedRunProcess;
}

function runLoop(
  repoRoot: string,
  workspace: string,
  overrides: Partial<Parameters<typeof runRalphLoop>[0]> = {},
) {
  return runRalphLoop({
    repoRoot,
    targetWorkspace: workspace,
    prdPath: prdPathFor(workspace),
    ...defaultLoopArgs,
    ...overrides,
  });
}

function readLoopLog(workspace: string): string {
  return fs.readFileSync(logPathFor(workspace), 'utf8');
}

function findFallbackDir(workspace: string): string | undefined {
  return fs.readdirSync(fallbackLogsDir(workspace)).find((entry) =>
    entry.startsWith('bounded-cycle-node-fallback-'),
  );
}

function readFallbackFile(workspace: string, fileName: string): string {
  return fs.readFileSync(path.join(fallbackLogsDir(workspace), String(findFallbackDir(workspace)), fileName), 'utf8');
}

function expectControlStatusCall(callIndex: number, repoRoot: string, workspace: string) {
  expect(runProcess).toHaveBeenNthCalledWith(
    callIndex,
    'node',
    ['--import', 'tsx', 'src/cli.ts', 'control-status', '--workspace', workspace, '--prd', prdPathFor(workspace)],
    expect.objectContaining({ cwd: repoRoot, timeoutMs: 15 * 60 * 1000 }),
  );
}

function expectOperationCall(
  callIndex: number,
  repoRoot: string,
  workspace: string,
  {
    kind,
    reason,
    limit,
    timeoutMs = 15 * 60 * 1000,
  }: {
    kind: string;
    reason: string;
    limit?: string;
    timeoutMs?: number;
  },
) {
  const args = ['--import', 'tsx', 'src/cli.ts', 'run-operation', kind, '--workspace', workspace, '--prd', prdPathFor(workspace)];

  if (limit) {
    args.push('--limit', limit);
  }
  args.push('--reason', reason);

  expect(runProcess).toHaveBeenNthCalledWith(
    callIndex,
    'node',
    args,
    expect.objectContaining({ cwd: repoRoot, timeoutMs }),
  );
}

describe('buildAgentAlgoLlmRalphTask', () => {
  it('matches the one-operation prompt wording from the plan', () => {
    const snapshotJson = JSON.stringify({
      backlog: {
        due_queries: 3,
        pending_hydrate: 2,
        pending_comments: 1,
        notes_total: 8,
        strict_export_ready: false,
      },
    }, null, 2);
    const task = buildAgentAlgoLlmRalphTask(
      sampleRepoRoot,
      sampleWorkspace,
      samplePrdPath,
      snapshotJson,
    );

    expect(task).toContain('Read the control-status JSON snapshot below.');
    expect(task).toContain(snapshotJson);
    expect(task).toContain('Choose exactly one operation.');
    expect(task).toContain('Execute exactly one command from repo root and stop:');
    expect(task).toContain(
      `cd ${sampleRepoRoot} && node --import tsx src/cli.ts run-operation <kind> --workspace ${sampleWorkspace} --prd ${samplePrdPath} --reason "<short reason>"`,
    );
    expect(task).toContain('Do not chain multiple operations.');
  });
});

describe('runRalphLoop', () => {
  const atomicsWait = vi.spyOn(Atomics, 'wait').mockReturnValue('ok');

  afterEach(() => {
    vi.resetAllMocks();
    atomicsWait.mockReturnValue('ok');
  });

  it('retries OMX execution after an exception and succeeds on the next attempt', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx)
      .mockImplementationOnce(() => {
        throw new Error('temporary omx crash');
      })
      .mockImplementationOnce(() => {
        recordFreshOperation(workspace);
        return 0;
      });
    queueControlStatusResults(workspace, buildBacklog(), buildBacklog());

    const status = runLoop(repoRoot, workspace, { execRetries: 2 });
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(runStableOmx).toHaveBeenCalledTimes(2);
    expect(runStableOmx).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      repoRoot,
      2 * 60 * 1000,
    );
    expect(log).toContain('omx attempt 1/2');
    expect(log).toContain('omx attempt 1 error=Error: temporary omx crash');
    expect(log).toContain('retrying after 5s');
    expect(log).toContain('omx attempt 2 exit=0');
    expect(log).not.toContain('starting local fallback');
    expect(atomicsWait).toHaveBeenCalledTimes(1);
  });

  it('falls back locally when omx exits zero without creating a fresh operation', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx).mockReturnValueOnce(0);
    queueControlStatusResults(workspace, buildBacklog(), buildBacklog())
      .mockReturnValueOnce(buildProcessResult('ok\n'));

    const status = runLoop(repoRoot, workspace);
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(runStableOmx).toHaveBeenCalledTimes(1);
    expect(log).toContain('starting local fallback');
    expect(runProcess.mock.calls.some(([, args]) =>
      Array.isArray(args) && args[3] === 'run-operation' && args[4] === 'validate',
    )).toBe(true);
  });

  it('falls back to one local control-plane operation after OMX fails', () => {
    const { repoRoot, workspace } = createRalphFixture({ activeRalph: true });

    vi.mocked(runStableOmx).mockReturnValueOnce(1);
    queueControlStatusResults(
      workspace,
      buildBacklog({ notes_total: 1 }),
      buildBacklog({ pending_hydrate: 1, notes_total: 1 }),
      buildBacklog({ pending_hydrate: 1, notes_total: 1 }),
    ).mockReturnValueOnce(buildProcessResult('ok\n'));

    const status = runLoop(repoRoot, workspace);
    const log = readLoopLog(workspace);
    const fallbackDir = findFallbackDir(workspace);

    expect(status).toBe(0);
    expect(runStableOmx).toHaveBeenCalledTimes(1);
    expect(runProcess).toHaveBeenCalledTimes(3);
    expectControlStatusCall(1, repoRoot, workspace);
    expectControlStatusCall(2, repoRoot, workspace);
    expectOperationCall(3, repoRoot, workspace, {
      kind: 'hydrate',
      limit: '12',
      reason: 'pending_hydrate backlog dominates current cycle',
    });
    expect(log).toContain('starting local fallback');
    expect(log).toContain('local fallback exit=0');
    expect(fallbackDir).toBeTruthy();
    expect(fs.existsSync(path.join(workspace, '.omx/state/archive'))).toBe(true);
    expect(readFallbackFile(workspace, 'summary.tsv').trim().split('\n')).toHaveLength(1);
  });

  it('runs exactly one local fallback operation and returns its failure status', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx).mockReturnValueOnce(1);
    queueControlStatusResults(
      workspace,
      buildBacklog({ due_queries: 3, notes_total: 3 }),
      buildBacklog({ due_queries: 3, notes_total: 3 }),
    ).mockReturnValueOnce(buildProcessResult('', { status: 1, stderr: 'harvest failed\n' }));

    const status = runLoop(repoRoot, workspace);
    const summary = readFallbackFile(workspace, 'summary.txt');

    expect(status).toBe(1);
    expect(runProcess).toHaveBeenCalledTimes(3);
    expectOperationCall(3, repoRoot, workspace, {
      kind: 'harvest',
      limit: '3',
      reason: 'due_queries backlog requires collection',
      timeoutMs: 35 * 60 * 1000,
    });
    expect(summary).toContain('END harvest exit=1');
    expect(summary).toContain('DONE status=1 failures=harvest');
  });

  it('continues to the next iteration after one failed iteration when below the failure threshold', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx)
      .mockReturnValueOnce(1)
      .mockImplementationOnce(() => {
        recordFreshOperation(workspace);
        return 0;
      });
    queueControlStatusResults(
      workspace,
      buildBacklog({ notes_total: 1 }),
      buildBacklog({ due_queries: 1, notes_total: 1 }),
    )
      .mockReturnValueOnce(buildProcessResult('', { status: 1, stderr: 'harvest failed\n' }))
      .mockReturnValueOnce(buildControlStatusResult(workspace, buildBacklog({ notes_total: 1 })));

    const status = runLoop(repoRoot, workspace, {
      iterations: 2,
      maxConsecutiveFailures: 2,
      failureBackoffSeconds: 3,
    });
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(runStableOmx).toHaveBeenCalledTimes(2);
    expect(runProcess).toHaveBeenCalledTimes(4);
    expect(log).toContain('iteration 1 failed consecutive_failures=1/2');
    expect(log).toContain('failure backoff 3s');
    expect(log).toContain('iteration 2 exit=0');
  });

  it('opens an omx timeout circuit after repeated timeouts and skips omx temporarily', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx)
      .mockImplementationOnce(() => {
        throw new Error('spawnSync omx ETIMEDOUT');
      })
      .mockImplementationOnce(() => {
        throw new Error('spawnSync omx ETIMEDOUT');
      })
      .mockImplementationOnce(() => {
        recordFreshOperation(workspace);
        return 0;
      });
    vi.mocked(runProcess).mockReturnValue(buildControlStatusResult(workspace, buildBacklog({ notes_total: 1 })));

    const status = runLoop(repoRoot, workspace, {
      iterations: 5,
      omxCooldownIterations: 2,
      omxCircuitBreakAfterTimeouts: 2,
    });
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(log).toContain('opening omx timeout circuit for 2 iterations');
    expect(log).toContain('iteration 3 skipping omx due to timeout cooldown');
    expect(log).toContain('iteration 4 skipping omx due to timeout cooldown');
    expect(log).toContain('iteration 5 omx attempt 1/1');
    expect(runStableOmx).toHaveBeenCalledTimes(3);
  });

  it('skips omx when the workspace has active local backlog', () => {
    const { repoRoot, workspace } = createRalphFixture({ writePrd: false });
    const dataDir = path.join(workspace, 'interview_data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(prdPathFor(workspace), JSON.stringify({
      source: 'xiaohongshu',
      queries: ['Agent 面经'],
      dataDir: './interview_data',
      stateFile: './interview_data/xhs_agent_algo_feb2026_state.json',
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'xhs_notes.json'), JSON.stringify([
      {
        note_id: 'note-1',
        url: 'https://www.xiaohongshu.com/explore/note-1',
        title: 'Agent 面经',
        content: null,
        interview_questions: [],
        comments: null,
      },
    ], null, 2), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'xhs_agent_algo_feb2026_state.json'), JSON.stringify({
      version: 1,
      updated_at: '2026-04-03T00:00:00+08:00',
      queries: {
        'Agent 面经': {
          last_run_at: '2026-04-03T00:00:00+08:00',
          newest_published_at: null,
          last_result_count: 0,
          next_run_after: null,
        },
      },
    }, null, 2), 'utf8');

    queueControlStatusResults(
      workspace,
      buildBacklog({ due_queries: 1, pending_hydrate: 1, pending_comments: 1, notes_total: 1 }),
      buildBacklog({ due_queries: 1, pending_hydrate: 1, pending_comments: 1, notes_total: 1 }),
    ).mockReturnValueOnce(buildProcessResult('ok\n'));

    const status = runLoop(repoRoot, workspace);
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(runStableOmx).not.toHaveBeenCalled();
    expect(log).toContain('skipping omx due to local backlog due_queries=1, pending_hydrate=1, pending_comments=1');
    expect(log).toContain('starting local fallback');
    expectOperationCall(3, repoRoot, workspace, {
      kind: 'hydrate',
      limit: '12',
      reason: 'pending_hydrate backlog dominates current cycle',
    });
  });

  it('does not skip omx for notes in cooldown or for notes with comments but no interview questions', () => {
    const { repoRoot, workspace } = createRalphFixture({ writePrd: false });
    writeWorkspaceStateFixture(workspace, {
      queries: [],
      notes: [
        {
          note_id: 'note-1',
          url: 'https://www.xiaohongshu.com/explore/note-1',
          title: 'Agent 面经',
          content: null,
          detail_next_attempt_after: '2099-01-01T00:00:00+08:00',
          interview_questions: [],
          comments: [],
          comment_next_attempt_after: '2099-01-01T00:00:00+08:00',
        },
      ],
    });

    vi.mocked(runStableOmx).mockImplementationOnce(() => {
      recordFreshOperation(workspace);
      return 0;
    });
    queueControlStatusResults(workspace, buildBacklog({ notes_total: 1 }));

    const status = runLoop(repoRoot, workspace);
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(runStableOmx).toHaveBeenCalledTimes(1);
    expect(log).not.toContain('skipping omx due to local backlog');
    expect(log).not.toContain('starting local fallback');
  });

  it('resets the timeout circuit counter after a non-timeout omx failure', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx)
      .mockImplementationOnce(() => {
        throw new Error('spawnSync omx ETIMEDOUT');
      })
      .mockReturnValueOnce(1)
      .mockImplementationOnce(() => {
        throw new Error('spawnSync omx ETIMEDOUT');
      })
      .mockImplementationOnce(() => {
        throw new Error('spawnSync omx ETIMEDOUT');
      });
    vi.mocked(runProcess).mockReturnValue(buildControlStatusResult(workspace, buildBacklog({ notes_total: 1 })));

    const status = runLoop(repoRoot, workspace, {
      iterations: 5,
      omxCooldownIterations: 1,
      omxCircuitBreakAfterTimeouts: 2,
    });
    const log = readLoopLog(workspace);

    expect(status).toBe(0);
    expect(log).not.toContain('iteration 3 opening omx timeout circuit');
    expect(log).toContain('iteration 4 opening omx timeout circuit for 1 iterations');
    expect(log).toContain('iteration 5 skipping omx due to timeout cooldown');
  });

  it('records a bounded fallback failure when control-status cannot be read', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx).mockReturnValueOnce(1);
    queueControlStatusResults(workspace, buildBacklog())
      .mockReturnValueOnce(buildProcessResult('', { status: 1, stderr: 'control plane unavailable\n' }));

    const status = runLoop(repoRoot, workspace);
    const summary = readFallbackFile(workspace, 'summary.txt');

    expect(status).toBe(1);
    expect(summary).toContain('END control-status exit=1');
    expect(summary).toContain('control-status failed with status 1');
    expect(summary).toContain('DONE status=1 failures=control-status');
  });

  it('records the selected operation label when local run-operation throws', () => {
    const { repoRoot, workspace } = createRalphFixture();

    vi.mocked(runStableOmx).mockReturnValueOnce(1);
    queueControlStatusResults(
      workspace,
      buildBacklog(),
      buildBacklog({ pending_hydrate: 1, notes_total: 1 }),
    ).mockImplementationOnce(() => {
      throw new Error('spawnSync node ETIMEDOUT');
    });

    const status = runLoop(repoRoot, workspace);
    const summary = readFallbackFile(workspace, 'summary.txt');
    const tsv = readFallbackFile(workspace, 'summary.tsv');

    expect(status).toBe(1);
    expect(summary).toContain('START 1/1 hydrate');
    expect(summary).toContain('END hydrate exit=1');
    expect(summary).toContain('DONE status=1 failures=hydrate');
    expect(tsv).toContain('hydrate\t1\t');
    expect(tsv).not.toContain('control-status\t1\t');
  });
});
