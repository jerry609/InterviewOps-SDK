import * as fs from 'node:fs';
import * as path from 'node:path';

import { nowIsoUtc8 } from '../heuristics.js';
import { runProcess, runProcessOrThrow } from '../process.js';
import { runStableOmx } from './omx.js';

export type RalphLoopOptions = {
  repoRoot: string;
  targetWorkspace: string;
  prdPath: string;
  iterations: number;
  sleepSeconds: number;
  autoCommit: boolean;
};

export function buildAgentAlgoLlmRalphTask(targetWorkspace: string, prdPath: string): string {
  const workspace = targetWorkspace.replaceAll('"', '\\"');
  const prd = prdPath.replaceAll('"', '\\"');
  return [
    'Operate only on the dedicated XHS Agent/LLM algorithm-role workspace.',
    `Target workspace: ${workspace}`,
    `Config path: ${prd}`,
    'Scope is restricted to Xiaohongshu notes that match internet major-company Agent / 智能体 / LLM / 大模型应用开发 algorithm-role interview content.',
    'Do one bounded collection cycle only.',
    'Run these commands in order and stop after they finish:',
    `npm run dev -- harvest --workspace "${workspace}" --prd "${prd}"`,
    `npm run dev -- hydrate --workspace "${workspace}" --prd "${prd}" --limit 12`,
    `npm run dev -- comments --workspace "${workspace}" --prd "${prd}" --limit 8`,
    `npm run dev -- export --workspace "${workspace}" --prd "${prd}"`,
    `npm run dev -- validate --workspace "${workspace}" --prd "${prd}"`,
    `npm run dev -- status --workspace "${workspace}" --prd "${prd}"`,
    'Persist all collected outputs into the workspace interview_data and reports directories.',
    'Do not change repo-wide configuration, do not broaden the query scope, and do not commit.',
    'If one search query fails, continue boundedly and let the workspace status capture the failure.',
  ].join(' ');
}

export function runRalphLoop(options: RalphLoopOptions): number {
  const logDir = path.resolve(options.targetWorkspace, 'reports/xhs-agent-algo-feb2026');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.resolve(logDir, 'ralph-loop.log');

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const startedAt = nowIsoUtc8();
    appendLog(logPath, `[${startedAt}] iteration ${iteration} starting`);
    const task = buildAgentAlgoLlmRalphTask(options.targetWorkspace, options.prdPath);
    const status = runStableOmx(['exec', '--full-auto', `$ralph "${task.replaceAll('"', '\\"')}"`], options.repoRoot);
    const finishedAt = nowIsoUtc8();
    appendLog(logPath, `[${finishedAt}] iteration ${iteration} exit=${status}`);

    if (options.autoCommit) {
      maybeCommitWorkspace(options.repoRoot, options.targetWorkspace, iteration, logPath);
    }

    if (status !== 0) {
      return status;
    }

    if (iteration < options.iterations) {
      appendLog(logPath, `[${nowIsoUtc8()}] sleeping ${options.sleepSeconds}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.sleepSeconds * 1000);
    }
  }

  return 0;
}

function appendLog(logPath: string, line: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function maybeCommitWorkspace(repoRoot: string, targetWorkspace: string, iteration: number, logPath: string): void {
  const status = runProcess('git', ['status', '--porcelain', '--', path.relative(repoRoot, targetWorkspace)], {
    cwd: repoRoot,
  });
  if (!status.stdout.trim()) {
    appendLog(logPath, `[${nowIsoUtc8()}] iteration ${iteration} no workspace changes to commit`);
    return;
  }

  const relWorkspace = path.relative(repoRoot, targetWorkspace);
  runProcessOrThrow('git', ['add', relWorkspace], { cwd: repoRoot });
  runProcessOrThrow('git', ['commit', '-m', `interviewops: ralph-loop iteration ${iteration}`], { cwd: repoRoot });
  appendLog(logPath, `[${nowIsoUtc8()}] iteration ${iteration} committed workspace changes`);
}
