import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  chooseFallbackOperation,
  renderRunOperationArgs,
  type ControlStatusSnapshot,
} from '../control-plane/scheduler.js';
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
  execRetries?: number;
  execTimeoutMs?: number;
  maxConsecutiveFailures?: number;
  failureBackoffSeconds?: number;
  omxCooldownIterations?: number;
  omxCircuitBreakAfterTimeouts?: number;
};

type RalphLoopCommand = {
  label: string;
  args: string[];
  timeoutMs?: number;
};

const DEFAULT_RALPH_EXEC_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_LOCAL_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const HARVEST_LOCAL_COMMAND_TIMEOUT_MS = 35 * 60 * 1000;
const COMMENTS_LOCAL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOOP_MAX_CONSECUTIVE_FAILURES = 4;
const DEFAULT_LOOP_FAILURE_BACKOFF_SECONDS = 120;
const DEFAULT_OMX_COOLDOWN_ITERATIONS = 3;
const DEFAULT_OMX_CIRCUIT_BREAK_AFTER_TIMEOUTS = 2;
const DEFAULT_CONTROL_PLANE_STATE_FILE = './interview_data/xhs_miangjing_state.json';
const DEFAULT_CONTROL_PLANE_REPORT_DIR = './reports/xhs-miangjing';

export function buildAgentAlgoLlmRalphTask(
  repoRoot: string,
  targetWorkspace: string,
  prdPath: string,
  snapshotJson: string,
): string {
  const command = `node --import tsx src/cli.ts run-operation <kind> --workspace ${shellQuote(targetWorkspace)} --prd ${shellQuote(prdPath)} --reason "<short reason>"`;
  return [
    'Only operate in the dedicated XHS Agent/LLM algorithm-role workspace.',
    `Workspace: ${targetWorkspace}. Config: ${prdPath}.`,
    'Sandbox note: do not use `npm run dev` here because tsx IPC socket creation fails under Codex sandbox with `listen EPERM`.',
    `Execute each command from repo root ${repoRoot} so local tsx and src/cli.ts resolve correctly even if your working directory is the workspace.`,
    'Read the control-status JSON snapshot below.',
    snapshotJson,
    'Choose exactly one operation.',
    'Execute exactly one command from repo root and stop:',
    `cd ${shellQuote(repoRoot)} && ${command}`,
    'Do not chain multiple operations.',
  ].join('\n');
}

export function runRalphLoop(options: RalphLoopOptions): number {
  const logDir = path.resolve(options.targetWorkspace, 'reports/xhs-agent-algo-feb2026');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.resolve(logDir, 'ralph-loop.log');
  const maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_LOOP_MAX_CONSECUTIVE_FAILURES);
  const failureBackoffSeconds = Math.max(1, options.failureBackoffSeconds ?? DEFAULT_LOOP_FAILURE_BACKOFF_SECONDS);
  const omxCooldownIterations = Math.max(1, options.omxCooldownIterations ?? DEFAULT_OMX_COOLDOWN_ITERATIONS);
  const omxCircuitBreakAfterTimeouts = Math.max(1, options.omxCircuitBreakAfterTimeouts ?? DEFAULT_OMX_CIRCUIT_BREAK_AFTER_TIMEOUTS);
  let consecutiveFailures = 0;
  let consecutiveOmxTimeouts = 0;
  let omxSkipUntilIteration = 0;

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const startedAt = nowIsoUtc8();
    appendLog(logPath, `[${startedAt}] iteration ${iteration} starting`);
    archiveActiveWorkspaceRalphState(options.targetWorkspace, logPath, 'before-iteration');
    const retries = Math.max(1, options.execRetries ?? 1);
    let status = 1;
    if (iteration < omxSkipUntilIteration) {
      appendLog(
        logPath,
        `[${nowIsoUtc8()}] iteration ${iteration} skipping omx due to timeout cooldown until iteration ${omxSkipUntilIteration}`,
      );
    } else {
      let backlogSkipped = false;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        const omxAttemptStartedAt = nowIsoUtc8();
        appendLog(logPath, `[${omxAttemptStartedAt}] iteration ${iteration} omx attempt ${attempt}/${retries}`);
        try {
          const controlStatus = readControlStatus(options.repoRoot, options.targetWorkspace, options.prdPath);
          const backlogReason = formatBacklogReason(controlStatus.snapshot);
          if (backlogReason) {
            appendLog(logPath, `[${nowIsoUtc8()}] iteration ${iteration} skipping omx due to local backlog ${backlogReason}`);
            backlogSkipped = true;
            break;
          }

          const task = buildAgentAlgoLlmRalphTask(
            options.repoRoot,
            options.targetWorkspace,
            options.prdPath,
            controlStatus.snapshotJson,
          );
          status = runStableOmx(
            ['exec', '--full-auto', `$ralph "${task.replaceAll('"', '\\"')}"`],
            options.repoRoot,
            options.execTimeoutMs ?? DEFAULT_RALPH_EXEC_TIMEOUT_MS,
          );
          consecutiveOmxTimeouts = 0;
          const freshOperation = status === 0
            ? detectFreshOmxOperation(options.targetWorkspace, options.prdPath, omxAttemptStartedAt)
            : null;
          if (status === 0 && !freshOperation) {
            appendLog(
              logPath,
              `[${nowIsoUtc8()}] iteration ${iteration} omx attempt ${attempt} exit=0 but no fresh operation record/event after ${omxAttemptStartedAt}`,
            );
            status = 1;
          } else {
            appendLog(
              logPath,
              `[${nowIsoUtc8()}] iteration ${iteration} omx attempt ${attempt} exit=${status}${freshOperation ? ` verified=${freshOperation}` : ''}`,
            );
          }
        } catch (error) {
          status = 1;
          const timeoutLike = isTimeoutLikeError(error);
          consecutiveOmxTimeouts = timeoutLike ? consecutiveOmxTimeouts + 1 : 0;
          appendLog(
            logPath,
            `[${nowIsoUtc8()}] iteration ${iteration} omx attempt ${attempt} error=${formatError(error)}`,
          );
          if (timeoutLike && consecutiveOmxTimeouts >= omxCircuitBreakAfterTimeouts) {
            omxSkipUntilIteration = iteration + omxCooldownIterations + 1;
            appendLog(
              logPath,
              `[${nowIsoUtc8()}] iteration ${iteration} opening omx timeout circuit for ${omxCooldownIterations} iterations (skip until ${omxSkipUntilIteration})`,
            );
          }
        }
        if (backlogSkipped || status === 0) {
          break;
        }
        if (attempt < retries) {
          const backoff = attempt * 5;
          appendLog(logPath, `[${nowIsoUtc8()}] iteration ${iteration} retrying after ${backoff}s`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff * 1000);
        }
      }
    }
    if (status !== 0) {
      archiveActiveWorkspaceRalphState(options.targetWorkspace, logPath, 'before-local-fallback');
      appendLog(logPath, `[${nowIsoUtc8()}] iteration ${iteration} starting local fallback`);
      status = runLocalBoundedCycle(options, logPath);
      appendLog(logPath, `[${nowIsoUtc8()}] iteration ${iteration} local fallback exit=${status}`);
    }
    archiveActiveWorkspaceRalphState(options.targetWorkspace, logPath, 'after-iteration');
    const finishedAt = nowIsoUtc8();
    appendLog(logPath, `[${finishedAt}] iteration ${iteration} exit=${status}`);

    if (options.autoCommit) {
      maybeCommitWorkspace(options.repoRoot, options.targetWorkspace, iteration, logPath);
    }

    if (status !== 0) {
      consecutiveFailures += 1;
      appendLog(
        logPath,
        `[${nowIsoUtc8()}] iteration ${iteration} failed consecutive_failures=${consecutiveFailures}/${maxConsecutiveFailures}`,
      );
      if (consecutiveFailures >= maxConsecutiveFailures || iteration >= options.iterations) {
        return status;
      }
      appendLog(logPath, `[${nowIsoUtc8()}] failure backoff ${failureBackoffSeconds}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, failureBackoffSeconds * 1000);
      continue;
    }
    consecutiveFailures = 0;

    if (iteration < options.iterations) {
      appendLog(logPath, `[${nowIsoUtc8()}] sleeping ${options.sleepSeconds}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.sleepSeconds * 1000);
    }
  }

  return 0;
}

function runLocalBoundedCycle(options: RalphLoopOptions, logPath: string): number {
  const stamp = buildUtcTimestamp();
  const boundedLogDir = path.resolve(options.targetWorkspace, `.omx/logs/bounded-cycle-node-fallback-${stamp}`);
  fs.mkdirSync(boundedLogDir, { recursive: true });
  const summaryPath = path.resolve(boundedLogDir, 'summary.txt');
  const summaryTsvPath = path.resolve(boundedLogDir, 'summary.tsv');
  const failures: string[] = [];

  fs.writeFileSync(summaryPath, '', 'utf8');
  fs.writeFileSync(summaryTsvPath, '', 'utf8');
  appendLog(logPath, `[${nowIsoUtc8()}] local fallback log_dir=${boundedLogDir}`);
  let command: RalphLoopCommand | null = null;
  try {
    const controlStatus = readControlStatus(options.repoRoot, options.targetWorkspace, options.prdPath);
    const operation = chooseFallbackOperation(controlStatus.snapshot);
    command = {
      label: operation.kind,
      args: renderRunOperationArgs(operation, options.targetWorkspace, options.prdPath),
      timeoutMs: resolveLocalCommandTimeoutMs(operation.kind),
    };
  } catch (error) {
    const command = buildControlStatusCommand(options.targetWorkspace, options.prdPath);
    recordBoundedFailure(command, boundedLogDir, summaryPath, summaryTsvPath, failures, error);
    appendFile(summaryPath, `DONE status=1 failures=${failures.join(',') || 'none'}\n`);
    return 1;
  }

  const logFile = path.resolve(boundedLogDir, `1-${command.label}.log`);
  const renderedCommand = renderCommand('node', command.args);
  const startedAt = new Date().toISOString();

  fs.writeFileSync(logFile, `COMMAND: ${renderedCommand}\n\n`, 'utf8');
  appendFile(summaryPath, `[${startedAt}] START 1/1 ${command.label}\n${renderedCommand}\n`);

  try {
    const result = runProcess('node', command.args, {
      cwd: options.repoRoot,
      timeoutMs: command.timeoutMs ?? DEFAULT_LOCAL_COMMAND_TIMEOUT_MS,
    });
    appendFile(logFile, result.stdout);
    appendFile(logFile, result.stderr);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    fs.appendFileSync(summaryTsvPath, `${command.label}\t${result.status}\t${logFile}\n`, 'utf8');
    appendFile(summaryPath, `[${new Date().toISOString()}] END ${command.label} exit=${result.status} log=${logFile}\n`);
    if (result.status !== 0) {
      failures.push(command.label);
      appendFile(summaryPath, `${readTail(logFile, 40)}\n`);
    }
  } catch (error) {
    appendFile(logFile, `${formatError(error)}\n`);
    fs.appendFileSync(summaryTsvPath, `${command.label}\t1\t${logFile}\n`, 'utf8');
    appendFile(summaryPath, `[${new Date().toISOString()}] END ${command.label} exit=1 log=${logFile}\n`);
    failures.push(command.label);
    appendFile(summaryPath, `${readTail(logFile, 40)}\n`);
  }

  appendFile(summaryPath, `DONE status=${failures.length === 0 ? 0 : 1} failures=${failures.join(',') || 'none'}\n`);
  return failures.length === 0 ? 0 : 1;
}

function recordBoundedFailure(
  command: RalphLoopCommand,
  boundedLogDir: string,
  summaryPath: string,
  summaryTsvPath: string,
  failures: string[],
  error: unknown,
): void {
  const logFile = path.resolve(boundedLogDir, `1-${command.label}.log`);
  const renderedCommand = renderCommand('node', command.args);
  const startedAt = new Date().toISOString();
  const formattedError = formatError(error);

  fs.writeFileSync(logFile, `COMMAND: ${renderedCommand}\n\n`, 'utf8');
  appendFile(summaryPath, `[${startedAt}] START 1/1 ${command.label}\n${renderedCommand}\n`);
  appendFile(logFile, `${formattedError}\n`);
  fs.appendFileSync(summaryTsvPath, `${command.label}\t1\t${logFile}\n`, 'utf8');
  appendFile(summaryPath, `[${new Date().toISOString()}] END ${command.label} exit=1 log=${logFile}\n`);
  failures.push(command.label);
  appendFile(summaryPath, `${readTail(logFile, 40)}\n`);
}

function buildControlStatusCommand(targetWorkspace: string, prdPath: string): RalphLoopCommand {
  return {
    label: 'control-status',
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      'control-status',
      '--workspace',
      targetWorkspace,
      '--prd',
      prdPath,
    ],
    timeoutMs: DEFAULT_LOCAL_COMMAND_TIMEOUT_MS,
  };
}

function readControlStatus(repoRoot: string, targetWorkspace: string, prdPath: string): {
  snapshotJson: string;
  snapshot: ControlStatusSnapshot;
} {
  const snapshotJson = readControlStatusJson(repoRoot, targetWorkspace, prdPath);
  return {
    snapshotJson,
    snapshot: parseControlStatusSnapshot(snapshotJson),
  };
}

function formatBacklogReason(snapshot: ControlStatusSnapshot): string | null {
  const { backlog } = snapshot;
  if (backlog.due_queries > 0 || backlog.pending_hydrate > 0 || backlog.pending_comments > 0) {
    return `due_queries=${backlog.due_queries}, pending_hydrate=${backlog.pending_hydrate}, pending_comments=${backlog.pending_comments}`;
  }
  return null;
}

function readControlStatusJson(repoRoot: string, targetWorkspace: string, prdPath: string): string {
  const command = buildControlStatusCommand(targetWorkspace, prdPath);
  const result = runProcess('node', command.args, {
    cwd: repoRoot,
    timeoutMs: command.timeoutMs,
  });

  if (result.status !== 0) {
    throw new Error(`control-status failed with status ${result.status}\n${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

function parseControlStatusSnapshot(snapshotJson: string): ControlStatusSnapshot {
  return JSON.parse(snapshotJson) as ControlStatusSnapshot;
}

function detectFreshOmxOperation(targetWorkspace: string, prdPath: string, attemptStartedAt: string): string | null {
  const attemptStartedAtMs = Date.parse(attemptStartedAt);
  if (!Number.isFinite(attemptStartedAtMs)) {
    return null;
  }

  const runtimePaths = resolveControlPlaneRuntimePaths(targetWorkspace, prdPath);
  const freshRecord = readFreshOperationRecord(runtimePaths.statePath, attemptStartedAtMs);
  if (freshRecord) {
    return `record:${freshRecord}`;
  }
  const freshEvent = readFreshOperationEvent(runtimePaths.journalPath, attemptStartedAtMs);
  if (freshEvent) {
    return `event:${freshEvent}`;
  }
  return null;
}

function resolveControlPlaneRuntimePaths(targetWorkspace: string, prdPath: string): {
  statePath: string;
  journalPath: string;
} {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const stateFile = String(parsed.stateFile || DEFAULT_CONTROL_PLANE_STATE_FILE).trim() || DEFAULT_CONTROL_PLANE_STATE_FILE;
  const reportDir = String(parsed.reportDir || DEFAULT_CONTROL_PLANE_REPORT_DIR).trim() || DEFAULT_CONTROL_PLANE_REPORT_DIR;

  return {
    statePath: path.resolve(targetWorkspace, stateFile),
    journalPath: path.resolve(targetWorkspace, reportDir, 'operation_journal.jsonl'),
  };
}

function readFreshOperationRecord(statePath: string, attemptStartedAtMs: number): string | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      operations?: Record<string, { last_run_at?: string | null } | undefined>;
    };

    for (const [stage, record] of Object.entries(state.operations || {})) {
      const recordedAt = Date.parse(String(record?.last_run_at || ''));
      if (Number.isFinite(recordedAt) && recordedAt >= attemptStartedAtMs) {
        return `${stage}@${record?.last_run_at}`;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function readFreshOperationEvent(journalPath: string, attemptStartedAtMs: number): string | null {
  if (!fs.existsSync(journalPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(journalPath, 'utf8').trim();
    if (!content) {
      return null;
    }
    for (const line of content.split('\n').reverse()) {
      const event = JSON.parse(line) as {
        type?: string;
        at?: string;
        operation?: { kind?: string };
      };
      const eventAt = Date.parse(String(event.at || ''));
      if (
        Number.isFinite(eventAt)
        && eventAt >= attemptStartedAtMs
        && typeof event.type === 'string'
        && typeof event.operation?.kind === 'string'
        && event.type.startsWith('operation.')
      ) {
        return `${event.type}:${event.operation.kind}@${event.at}`;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function resolveLocalCommandTimeoutMs(kind: RalphLoopCommand['label']): number {
  if (kind === 'harvest') {
    return HARVEST_LOCAL_COMMAND_TIMEOUT_MS;
  }
  if (kind === 'comments') {
    return COMMENTS_LOCAL_COMMAND_TIMEOUT_MS;
  }
  return DEFAULT_LOCAL_COMMAND_TIMEOUT_MS;
}

function appendLog(logPath: string, line: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function appendFile(filePath: string, content: string): void {
  if (!content) {
    return;
  }
  fs.appendFileSync(filePath, content, 'utf8');
}

function formatError(error: unknown): string {
  return (error instanceof Error ? error.stack || error.message : String(error)).replace(/\s+/g, ' ').trim();
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ETIMEDOUT|timed out/i.test(message);
}

function renderCommand(binary: string, args: string[]): string {
  return [binary, ...args].map((part) => shellQuote(part)).join(' ');
}

function shellQuote(input: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(input) ? input : JSON.stringify(input);
}

function readTail(filePath: string, lines: number): string {
  const content = fs.readFileSync(filePath, 'utf8').trimEnd();
  if (!content) {
    return '';
  }
  return content.split('\n').slice(-lines).join('\n');
}

function buildUtcTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function archiveActiveWorkspaceRalphState(targetWorkspace: string, logPath: string, phase: string): void {
  const statePath = path.resolve(targetWorkspace, '.omx/state/ralph.json');
  if (!fs.existsSync(statePath)) {
    return;
  }

  let shouldArchive = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { active?: boolean };
    shouldArchive = parsed.active !== false;
  } catch {
    shouldArchive = true;
  }

  if (!shouldArchive) {
    return;
  }

  const archiveDir = path.resolve(targetWorkspace, '.omx/state/archive');
  const archivePath = path.resolve(archiveDir, `ralph-${buildUtcTimestamp()}-${phase}.json`);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(statePath, archivePath);
  appendLog(logPath, `[${nowIsoUtc8()}] archived workspace ralph state to ${archivePath}`);
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
