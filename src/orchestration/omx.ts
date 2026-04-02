import * as fs from 'node:fs';
import * as path from 'node:path';

import { runProcess } from '../process.js';

export const OMX_PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

export function buildStableOmxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, USE_OMX_EXPLORE_CMD: '0' };
  for (const key of OMX_PROXY_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

export function runStableOmx(args: string[], workspace: string): number {
  fs.mkdirSync(path.resolve(workspace, '.omx/state'), { recursive: true });
  const binary = process.env.INTERVIEWOPS_OMX_BINARY || 'omx';
  const result = runProcess(binary, args, {
    cwd: workspace,
    env: buildStableOmxEnv(),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.status;
}
