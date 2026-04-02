import { spawnSync } from 'node:child_process';

export type ExecResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export function runProcess(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): ExecResult {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const status = result.status ?? 1;

  if (result.error) {
    throw result.error;
  }

  return { stdout, stderr, status };
}

export function runProcessOrThrow(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string {
  const result = runProcess(binary, args, options);
  if (result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed with status ${result.status}\n${result.stderr.trim()}`);
  }
  return result.stdout;
}
