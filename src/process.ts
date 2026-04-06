import { spawnSync } from 'node:child_process';

const PROCESS_TIMEOUT_SENTINEL = '__INTERVIEWOPS_PROCESS_TIMEOUT__';
const PROCESS_TIMEOUT_GRACE_MS = 2_000;
type ProcessEnvLike = Record<string, string | undefined>;
const PROCESS_GROUP_TIMEOUT_WRAPPER = `
const { spawn } = require('node:child_process');

const [timeoutMsRaw, graceMsRaw, binary, ...args] = process.argv.slice(1);
const timeoutMs = Number(timeoutMsRaw);
const graceMs = Number(graceMsRaw);

const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

let timedOut = false;
let graceTimer = null;

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const timeout = setTimeout(() => {
  timedOut = true;
  process.stderr.write('${PROCESS_TIMEOUT_SENTINEL}\\n');
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  graceTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, graceMs);
  graceTimer.unref();
}, timeoutMs);

child.on('error', (error) => {
  clearTimeout(timeout);
  if (graceTimer) clearTimeout(graceTimer);
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});

child.on('close', (code, signal) => {
  clearTimeout(timeout);
  if (graceTimer) clearTimeout(graceTimer);
  if (timedOut) {
    process.exit(124);
  }
  if (typeof code === 'number') {
    process.exit(code);
  }
  process.exit(signal ? 1 : 0);
});
`;

export type ExecResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export function runProcess(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: ProcessEnvLike; timeoutMs?: number } = {},
): ExecResult {
  const result = shouldUseProcessGroupTimeout(options.timeoutMs)
    ? spawnSync(process.execPath, [
      '-e',
      PROCESS_GROUP_TIMEOUT_WRAPPER,
      String(Math.max(1, Math.trunc(options.timeoutMs || 0))),
      String(PROCESS_TIMEOUT_GRACE_MS),
      binary,
      ...args,
    ], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
    })
    : spawnSync(binary, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs,
    });

  const stdout = result.stdout ?? '';
  const stderr = stripTimeoutSentinel(result.stderr ?? '');
  const status = result.status ?? 1;

  if (String(result.stderr || '').includes(PROCESS_TIMEOUT_SENTINEL)) {
    throw buildProcessTimeoutError(binary);
  }

  if (result.error) {
    throw result.error;
  }

  return { stdout, stderr, status };
}

export function runProcessOrThrow(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: ProcessEnvLike; timeoutMs?: number } = {},
): string {
  const result = runProcess(binary, args, options);
  if (result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed with status ${result.status}\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

function shouldUseProcessGroupTimeout(timeoutMs?: number): boolean {
  return process.platform !== 'win32' && Number.isFinite(timeoutMs) && Number(timeoutMs) > 0;
}

function stripTimeoutSentinel(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.trim() !== PROCESS_TIMEOUT_SENTINEL)
    .join('\n');
}

function buildProcessTimeoutError(binary: string): NodeJS.ErrnoException {
  const error = new Error(`spawnSync ${binary} ETIMEDOUT`) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  error.errno = -110;
  error.path = binary;
  error.syscall = 'spawnSync';
  return error;
}
