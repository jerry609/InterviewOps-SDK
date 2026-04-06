import { runProcess } from '../process.js';

type CreatorNoteDetailMetricRow = {
  section?: unknown;
  metric?: unknown;
  value?: unknown;
};

type PublicNoteUser = {
  nickname?: unknown;
};

type PublicNotePayload = {
  noteId?: unknown;
  title?: unknown;
  desc?: unknown;
  time?: unknown;
  user?: PublicNoteUser;
};

export const OPENCLI_PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

type ProcessEnvLike = Record<string, string | undefined>;

const MIN_SEARCH_TIMEOUT_SECONDS = 75;
const MIN_COMMENTS_TIMEOUT_SECONDS = 45;
const DEFAULT_OPENCLI_RETRIES = 1;

const PUBLIC_FETCH_SCRIPT = `
const url = process.argv[1];
const response = await fetch(url, {
  headers: {
    'user-agent': 'Mozilla/5.0',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
});
const html = await response.text();
if (!response.ok) {
  console.error(\`HTTP \${response.status} \${response.statusText}\`);
  process.exit(1);
}
process.stdout.write(html);
`;

export function buildStableOpenCliEnv(env: ProcessEnvLike = process.env): ProcessEnvLike {
  const next: ProcessEnvLike = { ...env };
  for (const key of OPENCLI_PROXY_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

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
      env: buildStableOpenCliEnv(),
      timeoutMs: timeoutSeconds * 1000,
    });
    if (result.status !== 0) {
      throw new Error(`${this.binary} ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout || '[]') as T;
  }

  search(query: string, limit: number, timeoutSeconds = 30): Array<Record<string, unknown>> {
    return this.runJsonWithRetry(
      ['xiaohongshu', 'search', query, '--limit', String(limit), '-f', 'json'],
      Math.max(timeoutSeconds, MIN_SEARCH_TIMEOUT_SECONDS),
    );
  }

  comments(target: string, limit: number, timeoutSeconds = 15): Array<Record<string, unknown>> {
    return this.runJsonWithRetry(
      ['xiaohongshu', 'comments', target, '--limit', String(limit), '-f', 'json'],
      Math.max(timeoutSeconds, MIN_COMMENTS_TIMEOUT_SECONDS),
    );
  }

  noteDetail(target: string, timeoutSeconds = 25): Array<Record<string, unknown>> {
    const noteId = extractXiaohongshuNoteId(target);
    const publicRow = this.fetchPublicNoteDetail(target, noteId, timeoutSeconds);
    if (publicRow) {
      return [publicRow];
    }

    try {
      const rows = this.runJson<CreatorNoteDetailMetricRow[]>(
        ['xiaohongshu', 'creator-note-detail', noteId, '-f', 'json'],
        Math.max(timeoutSeconds, 30),
      );
      const title = findCreatorMetric(rows, 'title');
      const publishedAt = findCreatorMetric(rows, 'published_at');
      if (!title && !publishedAt) {
        return [];
      }
      return [{
        url: normalizePublicNoteUrl(target, noteId),
        title,
        published_at: publishedAt,
        content: '',
      }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('No note detail data found') ||
        message.includes('resource was not found') ||
        message.includes('login status for creator.xiaohongshu.com')
      ) {
        return [];
      }
      throw error;
    }
  }

  private fetchPublicNoteDetail(
    target: string,
    noteId: string,
    timeoutSeconds: number,
  ): Record<string, unknown> | null {
    for (const url of buildPublicNoteUrls(target, noteId)) {
      const result = runProcess(process.execPath, ['--input-type=module', '-e', PUBLIC_FETCH_SCRIPT, url], {
        cwd: this.cwd,
        env: process.env,
        timeoutMs: Math.max(timeoutSeconds, 15) * 1000,
      });
      if (result.status !== 0 || !String(result.stdout || '').trim()) {
        continue;
      }
      const row = extractPublicNoteDetailFromHtml(result.stdout, noteId, url);
      if (row) {
        return row;
      }
    }
    return null;
  }

  private runJsonWithRetry<T>(args: string[], timeoutSeconds: number): T {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DEFAULT_OPENCLI_RETRIES; attempt += 1) {
      try {
        return this.runJson<T>(args, timeoutSeconds);
      } catch (error) {
        lastError = error;
        if (attempt >= DEFAULT_OPENCLI_RETRIES || !shouldRetryOpenCliError(error)) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function extractXiaohongshuNoteId(input: string): string {
  const text = String(input || '').trim();
  const match = text.match(/\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i);
  return match?.[1] ?? text;
}

function normalizePublicNoteUrl(target: string, noteId: string): string {
  const text = String(target || '').trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    return text;
  }
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function buildPublicNoteUrls(target: string, noteId: string): string[] {
  const urls: string[] = [];
  const normalized = normalizePublicNoteUrl(target, noteId);
  const exploreUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (normalized) {
    urls.push(normalized);
  }
  if (exploreUrl !== normalized) {
    urls.push(exploreUrl);
  }
  return [...new Set(urls)];
}

function findCreatorMetric(rows: CreatorNoteDetailMetricRow[], metric: string): string {
  const row = rows.find((item) => item.section === '笔记信息' && item.metric === metric);
  return String(row?.value || '').trim();
}

export function extractPublicNoteDetailFromHtml(
  html: string,
  noteId: string,
  url: string,
): Record<string, unknown> | null {
  const note = extractPublicNotePayload(html, noteId);
  if (!note) {
    return null;
  }

  const title = String(note.title || '').trim();
  const content = String(note.desc || '').trim();
  const author = String(note.user?.nickname || '').trim();
  const publishedAt = formatPublicPublishedAt(note.time);
  if (!title && !content && !author && !publishedAt) {
    return null;
  }

  return {
    url,
    title,
    author,
    published_at: publishedAt,
    content,
  };
}

function extractPublicNotePayload(html: string, noteId: string): PublicNotePayload | null {
  const anchor = `"noteDetailMap":{"${noteId}":`;
  const anchorIndex = html.indexOf(anchor);
  if (anchorIndex < 0) {
    return null;
  }

  const entryStart = html.indexOf('{', anchorIndex + anchor.length - 1);
  if (entryStart < 0) {
    return null;
  }

  const entry = sliceBalancedJsonObject(html, entryStart);
  if (!entry) {
    return null;
  }

  const noteAnchor = '"note":';
  const noteIndex = entry.indexOf(noteAnchor);
  if (noteIndex < 0) {
    return null;
  }

  const noteStart = entry.indexOf('{', noteIndex + noteAnchor.length - 1);
  if (noteStart < 0) {
    return null;
  }

  const noteObject = sliceBalancedJsonObject(entry, noteStart);
  if (!noteObject) {
    return null;
  }

  try {
    const payload = JSON.parse(noteObject) as PublicNotePayload;
    if (String(payload.noteId || '').trim() !== noteId) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function sliceBalancedJsonObject(source: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function formatPublicPublishedAt(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }
  return new Date(timestamp).toISOString();
}

function shouldRetryOpenCliError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ETIMEDOUT') || message.includes('Detached while handling command');
}
