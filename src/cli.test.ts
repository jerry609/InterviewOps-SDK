import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runProcess } from './process.js';

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

function createCliWorkspace(config: Partial<Record<string, unknown>> = {}): {
  workspace: string;
  prdPath: string;
} {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewops-cli-'));
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

describe('cli seed-import', () => {
  it('resolves relative seedSourceNotesPath from the workspace', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { workspace, prdPath } = createCliWorkspace({
      seedSourceNotesPath: './seed.json',
    });
    const seedPath = path.join(workspace, 'seed.json');

    fs.writeFileSync(seedPath, JSON.stringify([buildNote()], null, 2), 'utf8');

    const result = runProcess(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'seed-import', '--workspace', workspace, '--prd', prdPath],
      { cwd: repoRoot, timeoutMs: 30_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      imported: 1,
      merged_total: 1,
      source_path: seedPath,
    });
  });
});

describe('control-plane cli commands', () => {
  it('prints a control-plane snapshot JSON for control-status', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { workspace, prdPath } = createCliWorkspace();

    const result = runProcess(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'control-status', '--workspace', workspace, '--prd', prdPath],
      { cwd: repoRoot, timeoutMs: 30_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workspace,
      backlog: expect.any(Object),
      control_plane: expect.any(Object),
    });
  });

  it('runs validate through run-operation and returns the stage record as JSON', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { workspace, prdPath } = createCliWorkspace();

    const result = runProcess(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'run-operation',
        'validate',
        '--workspace',
        workspace,
        '--prd',
        prdPath,
        '--reason',
        'cli smoke test',
      ],
      { cwd: repoRoot, timeoutMs: 30_000 },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stage: 'validate',
      ok: true,
    });
  });
});
