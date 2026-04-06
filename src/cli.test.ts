import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runProcess } from './process.js';

type CliErrorEnvelope = {
  error: {
    command: string;
    message: string;
  };
};

type RunOperationArgs = {
  kind: string;
  workspace: string;
  prdPath: string;
  reason?: string;
  limit?: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testTempRoot = path.join(repoRoot, '.tmp-tests');

function buildNote(): Record<string, unknown> {
  return {
    note_id: 'cli-seed-note',
    url: 'https://www.xiaohongshu.com/explore/cli-seed-note',
    title: 'cli seed note',
    query: 'Agent 面经',
    first_seen_at: '2026-04-02T00:00:00+08:00',
    last_seen_at: '2026-04-02T00:00:00+08:00',
    crawl_source: 'opencli:xiaohongshu/search',
    interview_questions: [],
  };
}

function createWorkspaceDir(prefix: string): string {
  fs.mkdirSync(testTempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testTempRoot, `${prefix}-`));
}

function createCliWorkspace(config: Partial<Record<string, unknown>> = {}): {
  workspace: string;
  prdPath: string;
} {
  const workspace = createWorkspaceDir('interviewops-cli');
  const dataDir = path.join(workspace, 'interview_data');
  const reportDir = path.join(workspace, 'reports/xhs-agent-algo-feb2026');
  const prdPath = path.join(workspace, 'interviewops.xhs.json');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'xhs_notes.json'), JSON.stringify([], null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'xhs_state.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-04-06T09:00:00+08:00',
      queries: {},
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    prdPath,
    JSON.stringify({
      source: 'xiaohongshu',
      queries: [],
      dataDir: './interview_data',
      reportDir: './reports/xhs-agent-algo-feb2026',
      stateFile: './interview_data/xhs_state.json',
      ...config,
    }, null, 2),
    'utf8',
  );

  return { workspace, prdPath };
}

function parseCliError(stderr: string): CliErrorEnvelope {
  return JSON.parse(stderr) as CliErrorEnvelope;
}

function runCli(args: string[]) {
  return runProcess(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );
}

function runControlStatus(workspace: string, prdPath: string) {
  return runCli(['control-status', '--workspace', workspace, '--prd', prdPath]);
}

function runOperation({ kind, workspace, prdPath, reason, limit }: RunOperationArgs) {
  const args = ['run-operation', kind, '--workspace', workspace, '--prd', prdPath];

  if (limit !== undefined) {
    args.push('--limit', limit);
  }
  if (reason !== undefined) {
    args.push('--reason', reason);
  }

  return runCli(args);
}

function expectCliError(stderr: string, command: string, message: string) {
  expect(parseCliError(stderr)).toEqual({
    error: { command, message },
  });
}

describe('cli seed-import', () => {
  it('resolves relative seedSourceNotesPath from the workspace', () => {
    const { workspace, prdPath } = createCliWorkspace({
      seedSourceNotesPath: './seed.json',
    });
    const seedPath = path.join(workspace, 'seed.json');

    fs.writeFileSync(seedPath, JSON.stringify([buildNote()], null, 2), 'utf8');

    const result = runCli(['seed-import', '--workspace', workspace, '--prd', prdPath]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      imported: 1,
      merged_total: 1,
      source_path: seedPath,
    });
  });
});

describe('control-plane cli commands', () => {
  it('includes control-status and run-operation in --help output', () => {
    const result = runCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('control-status');
    expect(result.stdout).toContain('run-operation');
  });

  it('prints a control-plane snapshot JSON for control-status', () => {
    const { workspace, prdPath } = createCliWorkspace();
    const result = runControlStatus(workspace, prdPath);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workspace,
      backlog: expect.any(Object),
      control_plane: expect.any(Object),
    });
  });

  it('emits a JSON error envelope when control-status hits a runtime failure', () => {
    const { workspace, prdPath } = createCliWorkspace();

    fs.writeFileSync(prdPath, '{invalid json', 'utf8');

    const result = runControlStatus(workspace, prdPath);

    expect(result.status).not.toBe(0);
    expect(parseCliError(result.stderr)).toMatchObject({
      error: {
        command: 'control-status',
        message: expect.any(String),
      },
    });
  });

  it('runs validate through run-operation and returns the stage record as JSON', () => {
    const { workspace, prdPath } = createCliWorkspace();
    const result = runOperation({
      kind: 'validate',
      workspace,
      prdPath,
      reason: 'cli smoke test',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stage: 'validate',
      ok: true,
    });
  });

  it('fails run-operation validate without --reason with a JSON error envelope', () => {
    const { workspace, prdPath } = createCliWorkspace();
    const result = runOperation({
      kind: 'validate',
      workspace,
      prdPath,
    });

    expect(result.status).not.toBe(0);
    expectCliError(result.stderr, 'run-operation', 'run-operation requires --reason TEXT');
  });

  it('fails run-operation for unsupported kinds with a JSON error envelope', () => {
    const { workspace, prdPath } = createCliWorkspace();
    const result = runOperation({
      kind: 'unknown-kind',
      workspace,
      prdPath,
      reason: 'invalid kind smoke test',
    });

    expect(result.status).not.toBe(0);
    expectCliError(result.stderr, 'run-operation', 'unsupported operation kind: unknown-kind');
  });

  it.each(['0', '-1', '1.5'])('fails run-operation hydrate with invalid --limit=%s', (limit) => {
    const { workspace, prdPath } = createCliWorkspace();
    const result = runOperation({
      kind: 'hydrate',
      workspace,
      prdPath,
      limit,
      reason: 'invalid limit smoke test',
    });

    expect(result.status).not.toBe(0);
    expectCliError(result.stderr, 'run-operation', '--limit must be a positive integer');
  });
});
