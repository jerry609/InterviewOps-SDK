#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ControlPlaneOperation } from './control-plane/contracts.js';
import { runRalphLoop } from './orchestration/ralph-loop.js';
import { runStableOmx } from './orchestration/omx.js';
import { InterviewOpsPipeline } from './pipeline.js';
import type { PipelineOptions } from './types.js';

function usage(): string {
  return `InterviewOps SDK

Usage:
  interviewops init [--workspace PATH] [--force]
  interviewops template [--workspace PATH] [--force]
  interviewops sources
  interviewops seed-import [--workspace PATH] [--prd PATH] [--source-notes PATH]
  interviewops harvest [--workspace PATH] [--prd PATH]
  interviewops hydrate [--workspace PATH] [--prd PATH] [--limit N]
  interviewops comments [--workspace PATH] [--prd PATH] [--limit N]
  interviewops normalize [--workspace PATH] [--prd PATH]
  interviewops questions [--workspace PATH] [--prd PATH]
  interviewops overview [--workspace PATH] [--prd PATH]
  interviewops status [--workspace PATH] [--prd PATH]
  interviewops nightly [hours] [--workspace PATH] [--prd PATH] [--auto-commit]
  interviewops cycle [--workspace PATH] [--prd PATH] [--auto-commit]
  interviewops export [--workspace PATH] [--prd PATH]
  interviewops seller-summary [--workspace PATH] [--prd PATH]
  interviewops stats [--workspace PATH] [--prd PATH]
  interviewops validate [--workspace PATH] [--prd PATH]
  interviewops doctor [--workspace PATH] [--prd PATH]
  interviewops control-status [--workspace PATH] [--prd PATH]
  interviewops run-operation <kind> [--workspace PATH] [--prd PATH] [--limit N] --reason TEXT
  interviewops ralph <task> [--workspace PATH] [--full-auto]
  interviewops ralph-loop [iterations] [--workspace PATH] [--prd PATH] [--sleep-seconds N] [--auto-commit]
  interviewops omx-safe <args...>

Environment:
  INTERVIEWOPS_OPENCLI_BINARY       Override opencli binary, default: opencli
  INTERVIEWOPS_OPENCLI_ARGS_JSON    JSON string array of prefix args
  INTERVIEWOPS_OMX_BINARY           Override omx binary, default: omx

Examples:
  interviewops sources
  interviewops template
  interviewops seed-import --source-notes /path/to/xhs_notes.json
  interviewops harvest
  interviewops hydrate --limit 12
  interviewops comments --limit 8
  interviewops normalize
  interviewops questions
  interviewops overview
  interviewops status
  interviewops stats
  interviewops control-status
  interviewops run-operation validate --reason "periodic data integrity check"
  interviewops export
  interviewops cycle --auto-commit
  interviewops nightly 8 --workspace /data/interviewops
  interviewops doctor --workspace /data/interviewops
  interviewops ralph "analyze seller notes and produce a report"
  interviewops ralph-loop 6 --workspace /path/to/workspace
  interviewops omx-safe doctor
`;
}

type ParsedCli = {
  command: string;
  positional: string[];
  options: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    return { command: 'help', positional: [], options: {} };
  }

  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, positional, options };
}

function buildOptions(parsed: ParsedCli): PipelineOptions {
  const workspace = path.resolve(String(parsed.options.workspace || process.cwd()));
  const localPrd = path.resolve(workspace, 'interviewops.xhs.json');
  const packagePrd = path.resolve(resolvePackageRoot(), 'examples/xhs-miangjing.prd.json');
  const prdPath = path.resolve(String(parsed.options.prd || (fs.existsSync(localPrd) ? localPrd : packagePrd)));
  let progressDir = path.resolve(workspace, 'reports/xhs-miangjing');
  if (fs.existsSync(prdPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(prdPath, 'utf8')) as { reportDir?: string };
      if (raw.reportDir) {
        progressDir = path.resolve(workspace, raw.reportDir);
      }
    } catch {
      // Keep default progress dir when config parsing fails.
    }
  }
  return {
    workspace,
    prdPath,
    autoCommit: Boolean(parsed.options['auto-commit']),
    progressLogPath: path.resolve(progressDir, 'progress.log'),
  };
}

function resolvePackageRoot(): string {
  const current = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(current), '..');
}

function parseRequiredReason(parsed: ParsedCli): string {
  const reason = String(parsed.options.reason || '').trim();
  if (!reason) {
    throw new Error('run-operation requires --reason TEXT');
  }
  return reason;
}

function parseOptionalLimit(parsed: ParsedCli): number | undefined {
  if (!parsed.options.limit) {
    return undefined;
  }

  const limit = Number(parsed.options.limit);
  if (!Number.isFinite(limit)) {
    throw new Error('--limit must be a finite number');
  }
  return limit;
}

function parseControlPlaneOperation(parsed: ParsedCli): ControlPlaneOperation {
  const kind = parsed.positional[0];
  const reason = parseRequiredReason(parsed);
  const limit = parseOptionalLimit(parsed);

  switch (kind) {
    case 'harvest':
      return limit === undefined
        ? { kind, reason }
        : { kind, reason, query_limit: limit };
    case 'hydrate':
    case 'comments':
      return limit === undefined
        ? { kind, reason }
        : { kind, reason, limit };
    case 'normalize':
    case 'export':
    case 'validate':
      return { kind, reason };
    default:
      throw new Error(`unsupported operation kind: ${String(kind || '')}`);
  }
}

function initWorkspace(parsed: ParsedCli): void {
  const workspace = path.resolve(String(parsed.options.workspace || process.cwd()));
  const destination = path.resolve(workspace, 'interviewops.xhs.json');
  const source = path.resolve(resolvePackageRoot(), 'examples/xhs-miangjing.prd.json');
  if (fs.existsSync(destination) && !parsed.options.force) {
    throw new Error(`config already exists: ${destination}; pass --force to overwrite`);
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.copyFileSync(source, destination);
  fs.mkdirSync(path.resolve(workspace, 'interview_data'), { recursive: true });
  fs.mkdirSync(path.resolve(workspace, 'reports/xhs-miangjing'), { recursive: true });
  process.stdout.write(`initialized config: ${destination}\n`);
}

function copyTemplate(parsed: ParsedCli): void {
  const workspace = path.resolve(String(parsed.options.workspace || process.cwd()));
  const templateDir = path.resolve(workspace, 'templates');
  const sourceDir = path.resolve(resolvePackageRoot(), 'templates');
  const texDestination = path.resolve(templateDir, 'interview-note-template.tex');
  const pdfDestination = path.resolve(templateDir, 'interview-note-template.pdf');
  if ((!parsed.options.force) && (fs.existsSync(texDestination) || fs.existsSync(pdfDestination))) {
    throw new Error(`template already exists in ${templateDir}; pass --force to overwrite`);
  }
  fs.mkdirSync(templateDir, { recursive: true });
  fs.copyFileSync(path.resolve(sourceDir, 'interview-note-template.tex'), texDestination);
  fs.copyFileSync(path.resolve(sourceDir, 'interview-note-template.pdf'), pdfDestination);
  process.stdout.write(`template copied to: ${templateDir}\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (parsed.command === 'omx-safe') {
    process.exitCode = runStableOmx(parsed.positional, process.cwd());
    return;
  }

  if (parsed.command === 'sources') {
    process.stdout.write(`${JSON.stringify(['xiaohongshu'], null, 2)}\n`);
    return;
  }

  if (parsed.command === 'init') {
    initWorkspace(parsed);
    return;
  }

  if (parsed.command === 'template') {
    copyTemplate(parsed);
    return;
  }

  const options = buildOptions(parsed);
  const pipeline = new InterviewOpsPipeline(options);

  switch (parsed.command) {
    case 'stats':
      process.stdout.write(`${JSON.stringify(pipeline.stats(), null, 2)}\n`);
      break;
    case 'doctor':
      process.stdout.write(`${JSON.stringify(pipeline.doctor(), null, 2)}\n`);
      break;
    case 'status':
      process.stdout.write(`${JSON.stringify(pipeline.status(), null, 2)}\n`);
      break;
    case 'control-status':
      process.stdout.write(`${JSON.stringify(pipeline.readControlPlaneSnapshot(), null, 2)}\n`);
      break;
    case 'seed-import': {
      const sourceNotesPath = String(parsed.options['source-notes'] || pipeline.config.seedSourceNotesPath || '').trim();
      if (!sourceNotesPath) {
        throw new Error('seed-import requires --source-notes PATH or seedSourceNotesPath in config');
      }
      const imported = pipeline.seedImportNotes(path.resolve(sourceNotesPath));
      process.stdout.write(`${JSON.stringify(imported, null, 2)}\n`);
      break;
    }
    case 'harvest':
      pipeline.harvestIncremental();
      process.stdout.write('harvest ok\n');
      break;
    case 'hydrate':
      pipeline.hydrateDetails(parsed.options.limit ? Number(parsed.options.limit) : undefined);
      process.stdout.write('hydrate ok\n');
      break;
    case 'comments':
      pipeline.enrichComments(parsed.options.limit ? Number(parsed.options.limit) : undefined);
      process.stdout.write('comments ok\n');
      break;
    case 'normalize':
      pipeline.normalizeQuestionsAndSellerFlags();
      process.stdout.write('normalize ok\n');
      break;
    case 'questions': {
      const rows = pipeline.exportQuestionsBundle();
      process.stdout.write(`${JSON.stringify({ questions: rows.length }, null, 2)}\n`);
      break;
    }
    case 'overview':
      pipeline.exportOverviewBundle();
      process.stdout.write('overview ok\n');
      break;
    case 'validate':
      pipeline.validate();
      process.stdout.write('validation ok\n');
      break;
    case 'run-operation': {
      const operation = parseControlPlaneOperation(parsed);
      const record = await pipeline.runControlPlaneOperation(operation);
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      break;
    }
    case 'export': {
      const rows = pipeline.exportAll();
      process.stdout.write(`${JSON.stringify({ questions: rows.length }, null, 2)}\n`);
      break;
    }
    case 'seller-summary':
      pipeline.normalizeQuestionsAndSellerFlags();
      pipeline.exportSellerReports();
      process.stdout.write(`seller summary exported to reports/xhs-miangjing\n`);
      break;
    case 'cycle':
      pipeline.runCycle(1);
      break;
    case 'nightly': {
      const hours = parsed.positional[0] ? Number(parsed.positional[0]) : 8;
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error('nightly hours must be a positive number');
      }
      pipeline.runNightly(hours);
      break;
    }
    case 'ralph': {
      const task = parsed.positional.join(' ').trim();
      if (!task) {
        throw new Error('ralph requires a task string');
      }
      const fullAuto = parsed.options['full-auto'] !== false;
      const command = [`$ralph "${task.replaceAll('"', '\\"')}"`];
      const args = fullAuto ? ['exec', '--full-auto', ...command] : ['exec', ...command];
      process.exitCode = runStableOmx(args, options.workspace);
      break;
    }
    case 'ralph-loop': {
      const iterations = parsed.positional[0] ? Number(parsed.positional[0]) : 3;
      if (!Number.isFinite(iterations) || iterations <= 0) {
        throw new Error('ralph-loop iterations must be a positive number');
      }
      const repoRoot = resolvePackageRoot();
      process.exitCode = runRalphLoop({
        repoRoot,
        targetWorkspace: options.workspace,
        prdPath: options.prdPath,
        iterations,
        sleepSeconds: parsed.options['sleep-seconds'] ? Number(parsed.options['sleep-seconds']) : 20,
        autoCommit: Boolean(parsed.options['auto-commit']),
      });
      break;
    }
    default:
      throw new Error(`unknown command: ${parsed.command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
