import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { InterviewOpsPipeline } from './pipeline.js';

function buildNote(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    note_id: 'note-1',
    url: 'https://www.xiaohongshu.com/explore/note-1',
    title: 'Agent 算法面经',
    query: 'Agent 面经',
    first_seen_at: '2026-04-02T00:00:00+08:00',
    last_seen_at: '2026-04-02T00:00:00+08:00',
    crawl_source: 'opencli:xiaohongshu/search',
    interview_questions: [],
    ...overrides,
  };
}

function createPipelineFixture(
  notes: Array<Record<string, unknown>>,
  queries: string[] = [],
  configOverrides: Record<string, unknown> = {},
) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewops-pipeline-'));
  const dataDir = path.join(workspace, 'interview_data');
  const reportDir = path.join(workspace, 'reports/xhs-agent-algo-feb2026');
  const prdPath = path.join(workspace, 'interviewops.xhs.json');
  const statePath = path.join(dataDir, 'xhs_agent_algo_feb2026_state.json');
  const notesPath = path.join(dataDir, 'xhs_notes.json');
  const scopeNotesPath = path.join(dataDir, 'xhs_scope_notes.json');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    prdPath,
    JSON.stringify({
      source: 'xiaohongshu',
      queries,
      dataDir: './interview_data',
      reportDir: './reports/xhs-agent-algo-feb2026',
      stateFile: './interview_data/xhs_agent_algo_feb2026_state.json',
      detailBatch: 12,
      commentBatch: 8,
      commentLimit: 8,
      detailTimeoutSeconds: 25,
      commentTimeoutSeconds: 15,
      ...configOverrides,
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2), 'utf8');

  const pipeline = new InterviewOpsPipeline({
    workspace,
    prdPath,
    autoCommit: false,
    progressLogPath: path.join(reportDir, 'progress.log'),
  });

  return { pipeline, workspace, notesPath, statePath, scopeNotesPath, reportDir };
}

describe('InterviewOpsPipeline', () => {
  it('records hydrate errors without aborting the command and applies note-level cooldowns', () => {
    const { pipeline, notesPath, statePath } = createPipelineFixture([
      buildNote({ content: null, detail_fetched_at: null }),
    ]);
    const detail = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('detail unavailable');
      })
      .mockReturnValueOnce([{
        url: 'https://www.xiaohongshu.com/explore/note-1',
        title: 'Agent 算法面经',
        content: '讲讲 RAG 的检索具体怎么做',
        published_at: '2026-04-03',
      }]);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search: vi.fn(),
      comments: vi.fn(),
      detail,
    };

    expect(() => pipeline.hydrateDetails(1)).not.toThrow();

    const afterFailure = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;
    expect(detail).toHaveBeenCalledTimes(1);
    expect(afterFailure[0].detail_error_runs).toBe(1);
    expect(afterFailure[0].detail_last_error).toBe('detail unavailable');
    expect(afterFailure[0].detail_next_attempt_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.detail_hydration).toMatchObject({
      hydrated_notes: 0,
      attempted_notes: 1,
      errors: 1,
      last_error: 'detail unavailable',
    });
    expect(pipeline.status().operations[0]).toMatchObject({
      stage: 'hydrate',
      ok: false,
      detail: 'hydrated=0, attempted=1, limit=1, errors=1',
    });

    expect(() => pipeline.hydrateDetails(1)).not.toThrow();
    expect(detail).toHaveBeenCalledTimes(1);

    afterFailure[0].detail_next_attempt_after = '2000-01-01T00:00:00+08:00';
    fs.writeFileSync(notesPath, JSON.stringify(afterFailure, null, 2), 'utf8');

    expect(() => pipeline.hydrateDetails(1)).not.toThrow();
    const afterRecovery = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    expect(detail).toHaveBeenCalledTimes(2);
    expect(afterRecovery[0].content).toContain('RAG');
    expect(afterRecovery[0].detail_error_runs).toBe(0);
    expect(afterRecovery[0].detail_last_error).toBeNull();
    expect(afterRecovery[0].detail_next_attempt_after).toBeNull();
  });

  it('continues comment enrichment after a note-level failure', () => {
    const { pipeline, notesPath, statePath } = createPipelineFixture([
      buildNote({ note_id: 'note-1', comments: null, interview_questions: [] }),
      buildNote({
        note_id: 'note-2',
        url: 'https://www.xiaohongshu.com/explore/note-2',
        comments: null,
        interview_questions: [],
      }),
      buildNote({
        note_id: 'note-3',
        url: 'https://www.xiaohongshu.com/explore/note-3',
        comments: null,
        interview_questions: [],
      }),
    ]);
    const comments = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('comment timeout');
      })
      .mockReturnValueOnce([
        { author: 'alice', text: '面试会问 RAG 吗？', likes: 3, time: '2026-04-02' },
      ]);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search: vi.fn(),
      comments,
      detail: vi.fn(),
    };

    expect(() => pipeline.enrichComments(2)).not.toThrow();

    const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;

    expect(comments).toHaveBeenCalledTimes(2);
    expect(notes[0].comments).toBeNull();
    expect(notes[0].comment_error_runs).toBe(1);
    expect(notes[0].comment_last_error).toBe('comment timeout');
    expect(notes[0].comment_next_attempt_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(notes[1].comments).toHaveLength(1);
    expect(state.comment_enrichment).toMatchObject({
      enriched_notes: 1,
      attempted_notes: 2,
      errors: 1,
      last_error: 'comment timeout',
    });
    expect(pipeline.status().operations[0]).toMatchObject({
      stage: 'comments',
      ok: false,
      detail: 'enriched=1, attempted=2, limit=2, errors=1',
    });
  });

  it('skips cooled-down comment failures until the retry window passes', () => {
    const { pipeline, notesPath } = createPipelineFixture([
      buildNote({ note_id: 'note-1', comments: null, interview_questions: [] }),
      buildNote({
        note_id: 'note-2',
        url: 'https://www.xiaohongshu.com/explore/note-2',
        comments: null,
        interview_questions: [],
      }),
    ]);
    const comments = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('comment timeout');
      })
      .mockReturnValueOnce([
        { author: 'alice', text: '讲讲 KV cache 的作用', likes: 1, time: '2026-04-02' },
      ])
      .mockReturnValueOnce([
        { author: 'bob', text: '讲讲 agent 的规划能力怎么评估', likes: 2, time: '2026-04-03' },
      ]);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search: vi.fn(),
      comments,
      detail: vi.fn(),
    };

    pipeline.enrichComments(1);
    pipeline.enrichComments(1);

    let notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    expect(comments).toHaveBeenCalledTimes(2);
    expect(notes[0].comments).toBeNull();
    expect(notes[1].comments).toHaveLength(1);

    notes[0].comment_next_attempt_after = '2000-01-01T00:00:00+08:00';
    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2), 'utf8');

    pipeline.enrichComments(1);

    notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    expect(comments).toHaveBeenCalledTimes(3);
    expect(notes[0].comments).toHaveLength(1);
    expect(notes[0].comment_error_runs).toBe(0);
    expect(notes[0].comment_last_error).toBeNull();
    expect(notes[0].comment_next_attempt_after).toBeNull();
  });

  it('reports query totals only for queries in the current config', () => {
    const { pipeline, statePath } = createPipelineFixture([
      buildNote(),
    ], ['当前 query']);

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updated_at: '2026-04-03T00:00:00+08:00',
        queries: {
          '当前 query': {
            last_run_at: '2026-04-03T00:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            last_error: '',
          },
          '历史脏 query': {
            last_run_at: '2026-04-02T00:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            last_error: 'spawnSync opencli ETIMEDOUT',
          },
        },
      }, null, 2),
      'utf8',
    );

    expect(pipeline.status().queries).toEqual({
      total: 1,
      with_errors: 0,
    });
  });

  it('imports the full seed corpus and exports scope-filtered notes separately', () => {
    const { pipeline, notesPath, scopeNotesPath, reportDir, workspace } = createPipelineFixture([], [], {
      scopeFilter: {
        since: '2026-02-01',
        companies: ['字节'],
        agentKeywords: ['agent'],
        algoKeywords: ['算法'],
        excludeTitleKeywords: ['后端'],
      },
    });
    const seedPath = path.join(workspace, 'seed.json');
    fs.writeFileSync(seedPath, JSON.stringify([
      buildNote({
        note_id: 'strict-note',
        url: 'https://www.xiaohongshu.com/explore/strict-note',
        title: '字节 agent 算法 一面',
        query: '智能体 面经',
        published_at: '2026-03-01',
        content: 'agent 算法 追问',
      }),
      buildNote({
        note_id: 'broad-note',
        url: 'https://www.xiaohongshu.com/explore/broad-note',
        title: '腾讯 后端 面经',
        query: '后端 面经',
        published_at: '2026-03-01',
        content: '后端系统设计',
      }),
      buildNote({
        note_id: 'old-note',
        url: 'https://www.xiaohongshu.com/explore/old-note',
        title: '字节 agent 算法 面经（旧）',
        query: 'Agent 面经',
        published_at: '2026-01-20',
        content: 'agent 算法',
      }),
    ], null, 2), 'utf8');

    const result = pipeline.seedImportNotes(seedPath);
    const allNotes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, unknown>>;
    const scopeNotes = JSON.parse(fs.readFileSync(scopeNotesPath, 'utf8')) as Array<Record<string, unknown>>;
    const scopeReport = JSON.parse(fs.readFileSync(path.join(reportDir, 'scope_candidates.json'), 'utf8')) as Record<string, any>;

    expect(result).toMatchObject({
      imported: 3,
      merged_total: 3,
    });
    expect(allNotes).toHaveLength(3);
    expect(scopeNotes.map((note) => note.note_id)).toEqual(['strict-note']);
    expect(scopeReport.total_candidates).toBe(1);
  });

  it('uses high-signal queries from the seed source during harvest', () => {
    const { pipeline, notesPath, workspace } = createPipelineFixture([], ['算法 面经'], {
      seedSourceNotesPath: './seed.json',
    });
    fs.writeFileSync(path.join(workspace, 'seed.json'), JSON.stringify([
      buildNote({ note_id: 'seed-1', query: '智算平台 面经' }),
      buildNote({ note_id: 'seed-2', query: '智算平台 面经' }),
    ], null, 2), 'utf8');
    const search = vi.fn((query: string) => {
      if (query === '智算平台 面经') {
        return [
          {
            url: 'https://www.xiaohongshu.com/explore/new-note',
            title: '新面经',
            author: 'alice',
            published_at: '2026-04-03',
          },
        ];
      }
      return [];
    });

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search,
      comments: vi.fn(),
      detail: vi.fn(),
    };

    pipeline.harvestIncremental();

    const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    expect(search).toHaveBeenCalledWith('算法 面经', expect.any(Number), expect.any(Number));
    expect(search).toHaveBeenCalledWith('智算平台 面经', expect.any(Number), expect.any(Number));
    expect(notes).toHaveLength(1);
    expect(notes[0].query).toBe('智算平台 面经');
  });

  it('reflects repeated seed-derived queries in the control-status backlog snapshot', () => {
    const { pipeline, workspace, statePath } = createPipelineFixture([], ['算法 面经'], {
      seedSourceNotesPath: './seed.json',
    });
    fs.writeFileSync(path.join(workspace, 'seed.json'), JSON.stringify([
      buildNote({ note_id: 'seed-1', query: '智算平台 面经' }),
      buildNote({ note_id: 'seed-2', query: '智算平台 面经' }),
    ], null, 2), 'utf8');
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updated_at: '2026-04-03T00:00:00+08:00',
        queries: {
          '算法 面经': {
            last_run_at: '2026-04-03T08:00:00+08:00',
            newest_published_at: '2026-04-03',
            last_result_count: 2,
            added_note_count: 1,
            duplicate_note_count: 1,
            empty_runs: 0,
            error_runs: 0,
            timeout_runs: 0,
            next_run_after: '2099-01-01T00:00:00+08:00',
          },
        },
      }, null, 2),
      'utf8',
    );

    expect(pipeline.readControlPlaneSnapshot().backlog).toMatchObject({
      due_queries: 1,
      strict_export_ready: false,
    });
  });

  it('skips seed import when the source file is unchanged', () => {
    const { pipeline, workspace } = createPipelineFixture([], [], {
      scopeFilter: {
        since: '2026-02-01',
        companies: ['字节'],
        agentKeywords: ['agent'],
        algoKeywords: ['算法'],
      },
    });
    const seedPath = path.join(workspace, 'seed.json');
    fs.writeFileSync(seedPath, JSON.stringify([
      buildNote({
        note_id: 'strict-note',
        url: 'https://www.xiaohongshu.com/explore/strict-note',
        title: '字节 agent 算法 一面',
        query: '智能体 面经',
        published_at: '2026-03-01',
        content: 'agent 算法 追问',
      }),
    ], null, 2), 'utf8');

    const first = pipeline.seedImportNotes(seedPath);
    const second = pipeline.seedImportNotes(seedPath);

    expect(first.skipped).toBeUndefined();
    expect(second).toMatchObject({
      imported: 0,
      merged_total: 1,
      skipped: true,
    });
  });

  it('resolves relative seed source paths from the workspace root', () => {
    const { pipeline, notesPath, workspace } = createPipelineFixture([], [], {
      seedSourceNotesPath: './seed.json',
    });
    fs.writeFileSync(path.join(workspace, 'seed.json'), JSON.stringify([
      buildNote({
        note_id: 'relative-seed-note',
        url: 'https://www.xiaohongshu.com/explore/relative-seed-note',
        title: 'relative seed note',
      }),
    ], null, 2), 'utf8');

    const result = pipeline.seedImportNotes('./seed.json');
    const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;

    expect(result).toMatchObject({
      imported: 1,
      merged_total: 1,
      source_path: path.join(workspace, 'seed.json'),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].note_id).toBe('relative-seed-note');
  });

  it('skips harvest queries that are still in cooldown', () => {
    const { pipeline, statePath } = createPipelineFixture([], ['算法 面经', '智能体 面经'], {
      maxQueriesPerHarvest: 10,
    });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updated_at: '2026-04-03T00:00:00+08:00',
        queries: {
          '算法 面经': {
            last_run_at: '2026-04-03T11:00:00+08:00',
            newest_published_at: '2026-04-03',
            last_result_count: 10,
            added_note_count: 2,
            duplicate_note_count: 8,
            empty_runs: 0,
            error_runs: 0,
            next_run_after: '2099-04-03T12:00:00+08:00',
          },
          '智能体 面经': {
            last_run_at: '2026-04-03T08:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            added_note_count: 0,
            duplicate_note_count: 0,
            empty_runs: 1,
            error_runs: 0,
            next_run_after: null,
          },
        },
      }, null, 2),
      'utf8',
    );
    const search = vi.fn(() => []);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search,
      comments: vi.fn(),
      detail: vi.fn(),
    };

    pipeline.harvestIncremental();

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('智能体 面经', expect.any(Number), expect.any(Number));
  });

  it('prioritizes high-yield queries ahead of chronically empty ones', () => {
    const { pipeline, statePath } = createPipelineFixture([], ['高产 query', '空跑 query'], {
      maxQueriesPerHarvest: 1,
    });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updated_at: '2026-04-03T00:00:00+08:00',
        queries: {
          '高产 query': {
            last_run_at: '2026-04-03T08:00:00+08:00',
            newest_published_at: '2026-04-03',
            last_result_count: 2,
            added_note_count: 3,
            duplicate_note_count: 1,
            empty_runs: 0,
            error_runs: 0,
            timeout_runs: 0,
            next_run_after: null,
          },
          '空跑 query': {
            last_run_at: '2026-04-03T07:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            added_note_count: 0,
            duplicate_note_count: 0,
            empty_runs: 3,
            error_runs: 0,
            timeout_runs: 0,
            next_run_after: null,
          },
        },
      }, null, 2),
      'utf8',
    );
    const search = vi.fn(() => []);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search,
      comments: vi.fn(),
      detail: vi.fn(),
    };

    pipeline.harvestIncremental();

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('高产 query', expect.any(Number), expect.any(Number));
  });

  it('gives timeout-prone queries a longer timeout and higher slot cost', () => {
    const { pipeline, statePath } = createPipelineFixture([], ['timeout query', 'fresh query'], {
      maxQueriesPerHarvest: 2,
      queryTimeoutEscalationFactor: 2,
      timeoutQuerySlotCost: 2,
      queryTimeoutMaxSeconds: 300,
    });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updated_at: '2026-04-03T00:00:00+08:00',
        queries: {
          'timeout query': {
            last_run_at: '2026-04-03T06:00:00+08:00',
            newest_published_at: '2026-04-03',
            last_result_count: 0,
            added_note_count: 4,
            duplicate_note_count: 0,
            empty_runs: 0,
            error_runs: 1,
            timeout_runs: 1,
            last_error_kind: 'timeout',
            next_run_after: null,
          },
        },
      }, null, 2),
      'utf8',
    );
    const search = vi.fn(() => []);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search,
      comments: vi.fn(),
      detail: vi.fn(),
    };

    pipeline.harvestIncremental();

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('timeout query', expect.any(Number), 150);
  });

  it('prioritizes scope candidates during detail hydration', () => {
    const { pipeline, notesPath } = createPipelineFixture([
      buildNote({
        note_id: 'broad-note',
        url: 'https://www.xiaohongshu.com/explore/broad-note',
        title: '腾讯 后端 面经',
        query: '后端 面经',
        published_at: '2026-03-01',
        content: null,
      }),
      buildNote({
        note_id: 'scope-note',
        url: 'https://www.xiaohongshu.com/explore/scope-note',
        title: '字节 agent 算法 一面',
        query: '智能体 面经',
        published_at: '2026-03-02',
        content: null,
      }),
    ], [], {
      scopeFilter: {
        since: '2026-02-01',
        companies: ['字节'],
        agentKeywords: ['agent'],
        algoKeywords: ['算法'],
        excludeTitleKeywords: ['后端'],
      },
    });
    const detail = vi.fn((target: string) => [{
      url: target,
      title: target.includes('scope-note') ? '字节 agent 算法 一面' : '腾讯 后端 面经',
      content: target.includes('scope-note') ? 'agent 算法 细节' : '后端系统设计',
      published_at: '2026-04-03',
    }]);

    (pipeline as any).adapter = {
      sourceName: 'xiaohongshu',
      search: vi.fn(),
      comments: vi.fn(),
      detail,
    };

    pipeline.hydrateDetails(1);

    const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) as Array<Record<string, any>>;
    expect(detail).toHaveBeenCalledTimes(1);
    expect(detail.mock.calls[0][0]).toContain('scope-note');
    expect(notes.find((note) => note.note_id === 'scope-note')?.content).toBe('agent 算法 细节');
    expect(notes.find((note) => note.note_id === 'broad-note')?.content).toBeNull();
  });

  it('exports loose and strict question bundles while default reports use strict rows', () => {
    const { pipeline, workspace, reportDir } = createPipelineFixture([
      buildNote({
        note_id: 'strict-export-note',
        url: 'https://www.xiaohongshu.com/explore/strict-export-note',
        title: '字节 NLP 一面',
        query: 'Agent 面经',
        published_at: '2026-04-03',
        content: [
          '1. （现在上下文够了，实际使用时候根据小标题+元数据已经满足实际业务）介绍一下 Bert，Bert mask 怎么起作用的',
          '2. 为什么现在都在用 react 的 template 调用工具',
          '3. 讲讲 RAG 的检索具体怎么做',
        ].join('\n'),
      }),
    ]);

    const rows = pipeline.exportAll();

    const looseRows = JSON.parse(fs.readFileSync(path.join(workspace, 'interview_data/xhs_questions.json'), 'utf8')) as Array<Record<string, any>>;
    const strictRows = JSON.parse(fs.readFileSync(path.join(workspace, 'interview_data/xhs_questions_strict.json'), 'utf8')) as Array<Record<string, any>>;
    const strictTopicRows = JSON.parse(fs.readFileSync(path.join(workspace, 'interview_data/xhs_questions_nlp_strict.json'), 'utf8')) as Array<Record<string, any>>;
    const looseTopicRows = JSON.parse(fs.readFileSync(path.join(workspace, 'interview_data/xhs_questions_nlp.json'), 'utf8')) as Array<Record<string, any>>;
    const summary = JSON.parse(fs.readFileSync(path.join(workspace, 'interview_data/company_round_summary.json'), 'utf8')) as Array<Record<string, any>>;
    const html = fs.readFileSync(path.join(reportDir, 'xhs_questions_nlp.html'), 'utf8');

    expect(rows).toHaveLength(2);
    expect(looseRows).toHaveLength(3);
    expect(strictRows).toHaveLength(2);
    expect(looseRows.some((row) => row.question === '为什么现在都在用 react 的 template 调用工具')).toBe(true);
    expect(strictRows.some((row) => row.question === '为什么现在都在用 react 的 template 调用工具')).toBe(false);
    expect(strictRows.some((row) => row.question.includes('Bert mask 怎么起作用'))).toBe(true);
    expect(strictTopicRows).toHaveLength(2);
    expect(looseTopicRows).toHaveLength(3);
    expect(summary[0]).toMatchObject({
      company: '字节',
      question_count: 2,
    });
    expect(html).toContain('Bert mask 怎么起作用');
    expect(html).not.toContain('template 调用工具');
  });
});
