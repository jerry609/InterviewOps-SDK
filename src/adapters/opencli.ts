import { runProcess } from '../process.js';

function parseArgsJson(envKey: string): string[] {
  const raw = process.env[envKey];
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${envKey} must be a JSON string array`);
  }
  return parsed;
}

export class OpenCliRunner {
  private readonly binary: string;
  private readonly prefixArgs: string[];

  constructor(private readonly cwd: string) {
    this.binary = process.env.INTERVIEWOPS_OPENCLI_BINARY || 'opencli';
    this.prefixArgs = parseArgsJson('INTERVIEWOPS_OPENCLI_ARGS_JSON');
  }

  runJson<T>(args: string[], timeoutSeconds = 30): T {
    const result = runProcess(this.binary, [...this.prefixArgs, ...args], {
      cwd: this.cwd,
      env: process.env,
      timeoutMs: timeoutSeconds * 1000,
    });
    if (result.status !== 0) {
      throw new Error(`${this.binary} ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout || '[]') as T;
  }

  search(query: string, limit: number, timeoutSeconds = 30): Array<Record<string, unknown>> {
    return this.runJson(['xiaohongshu', 'search', query, '--limit', String(limit), '-f', 'json'], timeoutSeconds);
  }

  comments(target: string, limit: number, timeoutSeconds = 15): Array<Record<string, unknown>> {
    return this.runJson(['xiaohongshu', 'comments', target, '--limit', String(limit), '-f', 'json'], timeoutSeconds);
  }

  noteDetail(target: string, timeoutSeconds = 25): Array<Record<string, unknown>> {
    return this.runJson(['xiaohongshu', 'note-detail', target, '-f', 'json'], timeoutSeconds);
  }
}
