import * as fs from 'node:fs';
import * as path from 'node:path';

import { OpenCliRunner } from './adapters/opencli.js';
import { createSourceAdapter } from './adapters/xiaohongshu.js';
import type { InterviewSourceAdapter } from './adapters/types.js';
import {
  appendControlPlaneJournalEvent,
  buildBacklogSnapshot,
  ensureControlPlaneState,
  resolveControlPlaneJournalPath,
} from './control-plane/state.js';
import type { ControlPlaneJournalEvent } from './control-plane/contracts.js';
import { applySellerWhitelist, buildScopeCandidates, collectStats, detectPurchaseLinks, detectSellerSignals, extractNoteId, extractQuestions, inferTopics, isQuestionUsable, normalizeQuestion, noteIdToDate, nowIsoUtc8, parseCompany, parseRounds, questionRowKey, summarizeSellerAuthors } from './heuristics.js';
import { appendJsonLine, ensureDir, escapeHtml, readJsonFile, writeJsonFile } from './json.js';
import { runProcess, runProcessOrThrow } from './process.js';
import type { DoctorCheck, PipelineOperationRecord, PipelineOptions, PipelineStageName, PipelineStatus, QuestionExtractMode, ScopeSnapshot, XhsComment, XhsNote, XhsPrdConfig, XhsQuestionRow, XhsState, XhsStats } from './types.js';

const DEFAULT_PRD: Required<XhsPrdConfig> = {
  source: 'xiaohongshu',
  queries: [],
  sellerWhitelist: {
    authors: [],
    note_ids: [],
    title_keywords: [],
    urls: [],
  },
  seedSourceNotesPath: '',
  scopeFilter: {
    since: '',
    companies: [],
    agentKeywords: [],
    algoKeywords: [],
    excludeTitleKeywords: [],
  },
  dataDir: './interview_data',
  reportDir: './reports/xhs-miangjing',
  stateFile: './interview_data/xhs_miangjing_state.json',
  maxSearchResultsPerQuery: 20,
  perQueryTimeoutSeconds: 30,
  detailTimeoutSeconds: 25,
  commentTimeoutSeconds: 15,
  commentLimit: 10,
  detailBatch: 8,
  commentBatch: 6,
  harvestEvery: 2,
  sleepMinSeconds: 30,
  sleepMaxSeconds: 120,
  maxQueriesPerHarvest: 10,
  querySuccessCooldownMinutes: 60,
  queryDuplicateCooldownMinutes: 180,
  queryEmptyCooldownMinutes: 240,
  queryErrorCooldownMinutes: 45,
  queryTimeoutCooldownMinutes: 120,
  queryTimeoutEscalationFactor: 2,
  queryTimeoutMaxSeconds: 300,
  timeoutQuerySlotCost: 2,
  nightlyMaxConsecutiveFailures: 4,
  nightlyFailureBackoffSeconds: 90,
};

const SEARCH_TIMEOUT_FLOOR_SECONDS = 75;
const NOTE_RETRY_BACKOFF_MINUTES = [15, 60, 360] as const;

export class InterviewOpsPipeline {
  readonly workspace: string;
  readonly prdPath: string;
  readonly autoCommit: boolean;
  readonly progressLogPath: string;
  readonly config: Required<XhsPrdConfig>;
  readonly runner: OpenCliRunner;
  readonly adapter: InterviewSourceAdapter;
  readonly dataDir: string;
  readonly reportDir: string;
  readonly notesPath: string;
  readonly statePath: string;
  readonly questionsPath: string;
  readonly summaryPath: string;
  readonly sellerSummaryPath: string;
  readonly authorSellerSummaryPath: string;
  readonly sellerReportPath: string;
  readonly scopeNotesPath: string;
  readonly scopeReportJsonPath: string;
  readonly scopeReportMarkdownPath: string;
  readonly runHistoryPath: string;
  readonly statusPath: string;
  readonly controlPlaneJournalPath: string;

  constructor(options: PipelineOptions) {
    this.workspace = path.resolve(options.workspace);
    this.prdPath = path.resolve(options.prdPath);
    this.autoCommit = options.autoCommit;
    this.progressLogPath = path.resolve(options.progressLogPath);

    const loaded = readJsonFile<XhsPrdConfig>(this.prdPath, { queries: [] });
    this.config = {
      ...DEFAULT_PRD,
      ...loaded,
    };

    this.runner = new OpenCliRunner(this.workspace);
    this.adapter = createSourceAdapter(this.config.source, this.runner);
    this.dataDir = path.resolve(this.workspace, this.config.dataDir);
    this.reportDir = path.resolve(this.workspace, this.config.reportDir);
    this.notesPath = path.resolve(this.dataDir, 'xhs_notes.json');
    this.statePath = path.resolve(this.workspace, this.config.stateFile);
    this.questionsPath = path.resolve(this.dataDir, 'xhs_questions.json');
    this.summaryPath = path.resolve(this.dataDir, 'company_round_summary.json');
    this.sellerSummaryPath = path.resolve(this.reportDir, 'seller_candidates.json');
    this.authorSellerSummaryPath = path.resolve(this.reportDir, 'author_seller_summary.json');
    this.sellerReportPath = path.resolve(this.reportDir, 'seller_summary.md');
    this.scopeNotesPath = path.resolve(this.dataDir, 'xhs_scope_notes.json');
    this.scopeReportJsonPath = path.resolve(this.reportDir, 'scope_candidates.json');
    this.scopeReportMarkdownPath = path.resolve(this.reportDir, 'scope_candidates.md');
    this.runHistoryPath = path.resolve(this.reportDir, 'run_history.jsonl');
    this.statusPath = path.resolve(this.reportDir, 'status.json');
    this.controlPlaneJournalPath = resolveControlPlaneJournalPath(this.reportDir);

    ensureDir(this.dataDir);
    ensureDir(this.reportDir);
  }

  readNotes(): XhsNote[] {
    return readJsonFile<XhsNote[]>(this.notesPath, []);
  }

  writeNotes(notes: XhsNote[]): void {
    writeJsonFile(this.notesPath, notes);
  }

  readState(): XhsState {
    return readJsonFile<XhsState>(this.statePath, {
      version: 1,
      updated_at: nowIsoUtc8(),
      queries: {},
    });
  }

  writeState(state: XhsState): void {
    writeJsonFile(this.statePath, state);
  }

  stats(): XhsStats {
    return collectStats(this.readNotes());
  }

  status(): PipelineStatus {
    const state = this.readState();
    const operations = Object.values(state.operations || {})
      .filter((item): item is PipelineOperationRecord => Boolean(item))
      .sort((a, b) => b.last_run_at.localeCompare(a.last_run_at));
    const queryRows = this.config.queries
      .map((query) => state.queries?.[query])
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    return {
      workspace: this.workspace,
      source: this.adapter.sourceName,
      config_path: this.prdPath,
      updated_at: state.updated_at,
      stats: this.stats(),
      queries: {
        total: queryRows.length,
        with_errors: queryRows.filter((item) => Boolean(item.last_error)).length,
      },
      operations,
      whitelist: {
        authors: this.config.sellerWhitelist?.authors?.length || 0,
        note_ids: this.config.sellerWhitelist?.note_ids?.length || 0,
        title_keywords: this.config.sellerWhitelist?.title_keywords?.length || 0,
        urls: this.config.sellerWhitelist?.urls?.length || 0,
      },
    };
  }

  readControlPlaneSnapshot() {
    const notes = this.readNotes();
    const state = this.readState();
    const controlPlane = ensureControlPlaneState(state);
    const backlog = buildBacklogSnapshot(notes, state, this.config, Date.now());
    const recentOperations = Object.values(state.operations || {})
      .filter((item): item is PipelineOperationRecord => Boolean(item))
      .sort((a, b) => b.last_run_at.localeCompare(a.last_run_at));

    return {
      workspace: this.workspace,
      config_path: this.prdPath,
      backlog,
      control_plane: {
        ...controlPlane,
        backlog_snapshot: backlog,
      },
      recent_operations: recentOperations,
    };
  }

  writeControlPlaneState(
    mutate: (
      current: ReturnType<typeof ensureControlPlaneState>,
    ) => ReturnType<typeof ensureControlPlaneState>,
  ): void {
    const state = this.readState();
    state.control_plane = mutate(ensureControlPlaneState(state));
    state.updated_at = nowIsoUtc8();
    this.writeState(state);
    writeJsonFile(this.statusPath, this.status());
  }

  appendControlPlaneEvent(event: ControlPlaneJournalEvent): void {
    appendControlPlaneJournalEvent(this.controlPlaneJournalPath, event);
  }

  doctor(): DoctorCheck[] {
    const checks: DoctorCheck[] = [];
    const binaries = [
      { name: 'node', args: ['--version'] },
      { name: process.env.INTERVIEWOPS_OPENCLI_BINARY || 'opencli', args: ['--help'] },
      { name: process.env.INTERVIEWOPS_OMX_BINARY || 'omx', args: ['doctor'] },
    ];

    for (const item of binaries) {
      const result = runProcess(item.name, item.args, { cwd: this.workspace });
      checks.push({
        name: `binary:${item.name}`,
        ok: result.status === 0,
        detail: result.status === 0 ? 'ok' : (result.stderr.trim() || `exit=${result.status}`),
      });
    }

    checks.push({
      name: 'source',
      ok: Boolean(this.adapter.sourceName),
      detail: this.adapter.sourceName,
    });

    checks.push({
      name: 'config',
      ok: fs.existsSync(this.prdPath),
      detail: this.prdPath,
    });
    checks.push({
      name: 'dataDir',
      ok: fs.existsSync(this.dataDir),
      detail: this.dataDir,
    });
    checks.push({
      name: 'reportDir',
      ok: fs.existsSync(this.reportDir),
      detail: this.reportDir,
    });

    return checks;
  }

  seedImportNotes(sourceNotesPath: string): { imported: number; merged_total: number; source_path: string; skipped?: boolean } {
    const startedAt = Date.now();
    const resolvedSourcePath = this.resolveWorkspacePath(sourceNotesPath);
    const existingNotes = this.readNotes();
    const existing = new Map(existingNotes.map((note) => [note.note_id, note]));
    const signature = buildFileSignature(resolvedSourcePath);
    const state = this.readState();
    const previousImport = state.seed_import;
    if (
      previousImport?.source_path === resolvedSourcePath &&
      previousImport.source_signature === signature &&
      existing.size > 0
    ) {
      this.recordOperation('seed', {
        ok: true,
        detail: `skipped=unchanged, merged_total=${existing.size}`,
        item_count: 0,
        duration_ms: Date.now() - startedAt,
      });
      return {
        imported: 0,
        merged_total: existing.size,
        source_path: resolvedSourcePath,
        skipped: true,
      };
    }
    const sourceNotes = readJsonFile<XhsNote[]>(resolvedSourcePath, []);
    let imported = 0;
    const scopeSnapshot = this.buildScopeSnapshot(sourceNotes);
    for (const note of sourceNotes) {
      const current = existing.get(note.note_id);
      const mergedQueries = mergeQueries(current?.crawl_meta, note.crawl_meta, current?.query, note.query);
      const mergedMeta = {
        ...(note.crawl_meta || {}),
        ...(current?.crawl_meta || {}),
      } as Record<string, unknown>;
      if (mergedQueries.length > 0) {
        mergedMeta.queries = mergedQueries;
      }
      if (current) {
        existing.set(note.note_id, {
          ...note,
          ...current,
          first_seen_at: current.first_seen_at || note.first_seen_at,
          interview_questions: (current.interview_questions && current.interview_questions.length > 0)
            ? current.interview_questions
            : note.interview_questions,
          comments: current.comments ?? note.comments,
          content: current.content || note.content,
          last_seen_at: note.last_seen_at || current.last_seen_at,
          crawl_meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : null,
        });
      } else {
        existing.set(note.note_id, {
          ...note,
          crawl_meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : note.crawl_meta || null,
        });
        imported += 1;
      }
    }

    const merged = [...existing.values()].sort((a, b) =>
      `${b.published_at || ''}${b.note_id}`.localeCompare(`${a.published_at || ''}${a.note_id}`),
    );
    this.writeNotes(merged);
    this.exportAll();
    this.validate(false);
    const nextState = this.readState();
    nextState.seed_import = {
      source_path: resolvedSourcePath,
      source_signature: signature,
      source_notes: sourceNotes.length,
      merged_total: merged.length,
      last_imported_at: nowIsoUtc8(),
    };
    this.writeState(nextState);
    this.recordOperation('seed', {
      ok: true,
      detail: `imported=${imported}, merged_total=${merged.length}, scope_candidates=${scopeSnapshot?.total_candidates || 0}`,
      item_count: imported,
      duration_ms: Date.now() - startedAt,
    });
    return {
      imported,
      merged_total: merged.length,
      source_path: resolvedSourcePath,
    };
  }

  harvestIncremental(): void {
    const startedAt = Date.now();
    const seenAt = nowIsoUtc8();
    const notes = this.readNotes();
    const byId = new Map(notes.map((note) => [note.note_id, note]));
    const state = this.readState();
    const queries = this.buildHarvestQueries(notes, state);
    let totalRows = 0;
    let added = 0;
    let errors = 0;
    let dueQueries = 0;
    let selectedSlotCost = 0;

    for (const plan of queries) {
      const query = plan.query;
      dueQueries += 1;
      selectedSlotCost += plan.slotCost;
      try {
        const rows = this.adapter.search(query, this.config.maxSearchResultsPerQuery, plan.timeoutSeconds);
        totalRows += rows.length;
        let newestPublishedAt: string | null = null;
        let addedForQuery = 0;
        let duplicateForQuery = 0;

        for (const row of rows) {
          const url = String(row.url || '').trim();
          const noteId = extractNoteId(url);
          if (!noteId) continue;

          const record: XhsNote = {
            note_id: noteId,
            url,
            title: String(row.title || '').trim(),
            author: String(row.author || '').trim() || null,
            author_url: String(row.author_url || '').trim() || null,
            likes: String(row.likes || '').trim() || null,
            published_at: String(row.published_at || noteIdToDate(url) || '').trim() || null,
            query,
            first_seen_at: seenAt,
            last_seen_at: seenAt,
            crawl_source: 'opencli:xiaohongshu/search',
            interview_questions: [],
            crawl_meta: { queries: [query] },
          };

          const existing = byId.get(noteId);
          if (existing) {
            existing.url = record.url || existing.url;
            existing.title = record.title || existing.title;
            existing.author = record.author || existing.author || null;
            existing.author_url = record.author_url || existing.author_url || null;
            existing.likes = record.likes || existing.likes || null;
            existing.published_at = record.published_at || existing.published_at || null;
            existing.last_seen_at = seenAt;
            const meta = (existing.crawl_meta ||= {});
            const queries = new Set<string>(Array.isArray(meta.queries) ? (meta.queries as string[]) : []);
            queries.add(query);
            meta.queries = [...queries].sort();
            duplicateForQuery += 1;
          } else {
            byId.set(noteId, record);
            added += 1;
            addedForQuery += 1;
          }

          if (!newestPublishedAt || String(record.published_at || '') > newestPublishedAt) {
            newestPublishedAt = String(record.published_at || '') || newestPublishedAt;
          }
        }

        const previous = state.queries[query];
        const emptyRuns = rows.length === 0 ? (previous?.empty_runs || 0) + 1 : 0;
        state.queries[query] = {
          last_run_at: seenAt,
          newest_published_at: newestPublishedAt,
          last_result_count: rows.length,
          added_note_count: addedForQuery,
          duplicate_note_count: duplicateForQuery,
          empty_runs: emptyRuns,
          error_runs: 0,
          timeout_runs: 0,
          last_error_kind: rows.length === 0 ? 'empty' : (addedForQuery > 0 ? 'success' : 'duplicate'),
          search_timeout_seconds: plan.timeoutSeconds,
          next_run_after: this.buildNextQueryRunAt({
            status: rows.length === 0 ? 'empty' : (addedForQuery > 0 ? 'success' : 'duplicate'),
            emptyRuns,
            errorRuns: 0,
            timeoutRuns: 0,
            seenAt,
          }),
        };
      } catch (error) {
        errors += 1;
        const previous = state.queries[query];
        const errorRuns = (previous?.error_runs || 0) + 1;
        const timeoutRuns = isTimeoutLikeError(error) ? (previous?.timeout_runs || 0) + 1 : 0;
        const errorKind = timeoutRuns > 0 ? 'timeout' : 'error';
        state.queries[query] = {
          last_run_at: seenAt,
          newest_published_at: null,
          last_result_count: 0,
          added_note_count: 0,
          duplicate_note_count: 0,
          empty_runs: previous?.empty_runs || 0,
          error_runs: errorRuns,
          timeout_runs: timeoutRuns,
          last_error_kind: errorKind,
          search_timeout_seconds: plan.timeoutSeconds,
          next_run_after: this.buildNextQueryRunAt({
            status: errorKind,
            emptyRuns: previous?.empty_runs || 0,
            errorRuns,
            timeoutRuns,
            seenAt,
          }),
          last_error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    state.updated_at = seenAt;
    this.writeNotes([...byId.values()].sort((a, b) => `${b.published_at || ''}${b.note_id}`.localeCompare(`${a.published_at || ''}${a.note_id}`)));
    this.writeState(state);
    this.recordOperation('harvest', {
      ok: errors === 0,
      detail: `queries=${queries.length}, due_queries=${dueQueries}, slot_cost=${selectedSlotCost}, slot_budget=${this.config.maxQueriesPerHarvest}, base_queries=${this.config.queries.length}, rows=${totalRows}, added=${added}, errors=${errors}`,
      item_count: totalRows,
      duration_ms: Date.now() - startedAt,
    });
  }

  hydrateDetails(maxNotes = this.config.detailBatch): void {
    const startedAt = Date.now();
    const notes = this.readNotes();
    const prioritizedNotes = this.prioritizeScopeNotes(notes);
    const nowMs = Date.now();
    let hydrated = 0;
    let attempted = 0;
    let errors = 0;
    let lastError: string | null = null;
    const seenAt = nowIsoUtc8();

    for (const note of prioritizedNotes) {
      if (String(note.content || '').trim()) continue;
      if (!isNoteAttemptDue(note, 'detail', nowMs)) continue;
      if (attempted >= maxNotes) break;

      attempted += 1;
      try {
        const rows = this.adapter.detail(note.url || note.note_id, this.config.detailTimeoutSeconds);
        const row = rows[0] || {};
        const content = String(row.content || '').trim();
        const changed =
          Boolean(String(row.url || '').trim()) ||
          Boolean(String(row.title || '').trim()) ||
          Boolean(String(row.author || '').trim()) ||
          Boolean(String(row.published_at || '').trim()) ||
          Boolean(content);
        note.url = String(row.url || note.url || '').trim() || note.url;
        note.title = String(row.title || note.title || '').trim() || note.title;
        note.author = String(row.author || note.author || '').trim() || note.author || null;
        note.published_at = String(row.published_at || note.published_at || '').trim() || note.published_at || null;
        note.content = content || note.content || null;
        note.detail_fetched_at = seenAt;
        note.last_seen_at = seenAt;
        note.interview_questions = [...new Set([...(note.interview_questions || []), ...extractQuestions(content)])];
        clearNoteAttemptError(note, 'detail');
        if (changed) {
          hydrated += 1;
        }
      } catch (error) {
        errors += 1;
        note.last_seen_at = seenAt;
        lastError = recordNoteAttemptError(note, 'detail', seenAt, error);
      }
    }

    this.writeNotes(notes);
    const state = this.readState();
    state.updated_at = seenAt;
    state.detail_hydration = {
      last_run_at: seenAt,
      hydrated_notes: hydrated,
      attempted_notes: attempted,
      errors,
      last_error: lastError,
    };
    this.writeState(state);
    this.recordOperation('hydrate', {
      ok: errors === 0,
      detail: `hydrated=${hydrated}, attempted=${attempted}, limit=${maxNotes}, errors=${errors}`,
      item_count: hydrated,
      duration_ms: Date.now() - startedAt,
    });
  }

  enrichComments(maxNotes = this.config.commentBatch): void {
    const startedAt = Date.now();
    const notes = this.readNotes();
    const prioritizedNotes = this.prioritizeScopeNotes(notes);
    const seenAt = nowIsoUtc8();
    const nowMs = Date.now();
    let enriched = 0;
    let attempted = 0;
    let errors = 0;
    let lastError: string | null = null;

    for (const note of prioritizedNotes) {
      if ((note.interview_questions || []).length > 0 && note.comments != null) continue;
      if (!isNoteAttemptDue(note, 'comment', nowMs)) continue;

      const target = note.note_id || note.url;
      if (!target) continue;
      if (attempted >= maxNotes) break;

      attempted += 1;
      try {
        const rows = this.adapter.comments(target, this.config.commentLimit, this.config.commentTimeoutSeconds);
        const comments: XhsComment[] = rows.map((row) => ({
          author: String(row.author || '').trim() || null,
          content: String(row.text || row.content || '').trim() || null,
          likes: typeof row.likes === 'string' || typeof row.likes === 'number' ? row.likes : null,
          time: String(row.time || '').trim() || null,
        }));
        note.comments = comments;
        note.comment_count = comments.length;
        note.interview_questions = [...new Set([...(note.interview_questions || []), ...comments.flatMap((item) => extractQuestions(item.content || ''))])];
        note.last_seen_at = seenAt;
        clearNoteAttemptError(note, 'comment');
        enriched += 1;
      } catch (error) {
        errors += 1;
        note.last_seen_at = seenAt;
        lastError = recordNoteAttemptError(note, 'comment', seenAt, error);
      }
    }

    this.writeNotes(notes);
    const state = this.readState();
    state.updated_at = seenAt;
    state.comment_enrichment = {
      last_run_at: seenAt,
      enriched_notes: enriched,
      attempted_notes: attempted,
      errors,
      last_error: lastError,
    };
    this.writeState(state);
    this.recordOperation('comments', {
      ok: errors === 0,
      detail: `enriched=${enriched}, attempted=${attempted}, limit=${maxNotes}, errors=${errors}`,
      item_count: enriched,
      duration_ms: Date.now() - startedAt,
    });
  }

  normalizeQuestionsAndSellerFlags(recordStage = true): void {
    const startedAt = Date.now();
    const notes = this.readNotes();
    for (const note of notes) {
      const merged = new Set<string>();
      for (const question of extractQuestions(note.content || '')) {
        merged.add(normalizeQuestion(question));
      }
      for (const comment of note.comments || []) {
        for (const question of extractQuestions(comment.content || '')) {
          merged.add(normalizeQuestion(question));
        }
      }
      note.interview_questions = [...merged].filter(Boolean);
      const seller = detectSellerSignals(note);
      const whitelist = applySellerWhitelist(note, this.config.sellerWhitelist);
      note.seller_whitelisted = whitelist.whitelisted;
      note.seller_whitelist_reason = whitelist.reason || null;
      note.seller_flag = whitelist.whitelisted ? false : seller.flag;
      note.seller_tags = seller.tags;
      note.seller_confidence = seller.confidence;
      const purchaseLink = detectPurchaseLinks(note);
      note.purchase_link_flag = purchaseLink.flag;
      note.purchase_links = purchaseLink.links;
      note.purchase_link_tags = purchaseLink.tags;
      note.purchase_link_confidence = purchaseLink.confidence;
    }
    this.writeNotes(notes);
    if (recordStage) {
      this.recordOperation('normalize', {
        ok: true,
        detail: `notes=${notes.length}, seller_flagged=${notes.filter((note) => note.seller_flag).length}, whitelisted=${notes.filter((note) => note.seller_whitelisted).length}, purchase_links=${notes.filter((note) => note.purchase_link_flag).length}`,
        item_count: notes.length,
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  exportQuestions(mode: QuestionExtractMode = 'loose'): XhsQuestionRow[] {
    const notes = this.readNotes();
    const rows: XhsQuestionRow[] = [];
    const seen = new Set<string>();

    for (const note of notes) {
      const company = parseCompany(`${note.title} ${note.content || ''}`);
      const rounds = parseRounds(`${note.title} ${note.content || ''}`);
      const sellerFlag = Boolean(note.seller_flag);
      const sellerWhitelisted = Boolean(note.seller_whitelisted);
      const sellerWhitelistReason = String(note.seller_whitelist_reason || '');
      const sellerTags = note.seller_tags || [];
      const sellerConfidence = Number(note.seller_confidence || 0);
      const purchaseLinkFlag = Boolean(note.purchase_link_flag);
      const purchaseLinks = note.purchase_links || [];
      const purchaseLinkTags = note.purchase_link_tags || [];
      const purchaseLinkConfidence = Number(note.purchase_link_confidence || 0);

      (note.interview_questions || []).forEach((question, index) => {
        if (!isQuestionUsable(question, mode)) return;
        const normalized = normalizeQuestion(question, mode);
        const row: XhsQuestionRow = {
          note_id: note.note_id,
          title: note.title,
          query: note.query,
          published_at: note.published_at,
          author: note.author,
          url: note.url,
          question_index: index + 1,
          question: normalized,
          company,
          rounds,
          topics: inferTopics(note.title, note.query, normalized),
          seller_flag: sellerFlag,
          seller_whitelisted: sellerWhitelisted,
          seller_whitelist_reason: sellerWhitelistReason,
          seller_tags: sellerTags,
          seller_confidence: sellerConfidence,
          purchase_link_flag: purchaseLinkFlag,
          purchase_links: purchaseLinks,
          purchase_link_tags: purchaseLinkTags,
          purchase_link_confidence: purchaseLinkConfidence,
        };
        const key = questionRowKey(row);
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(row);
        }
      });
    }

    rows.sort((a, b) => `${b.published_at || ''}${b.note_id}${b.question_index}`.localeCompare(`${a.published_at || ''}${a.note_id}${a.question_index}`));
    writeJsonFile(resolveQuestionsPath(this.dataDir, mode), rows);
    return rows;
  }

  exportQuestionsBundle(recordStage = true): XhsQuestionRow[] {
    const startedAt = Date.now();
    const { looseRows, strictRows } = this.buildQuestionExports();
    if (recordStage) {
      this.recordOperation('questions', {
        ok: true,
        detail: `questions_strict=${strictRows.length}, questions_loose=${looseRows.length}`,
        item_count: strictRows.length,
        duration_ms: Date.now() - startedAt,
      });
    }
    return strictRows;
  }

  exportTopicReports(rows: XhsQuestionRow[], mode: QuestionExtractMode = 'loose'): void {
    const topics = ['nlp', 'backend', 'algo'];
    for (const topic of topics) {
      const bucket = rows.filter((row) => row.topics.includes(topic));
      const jsonPath = mode === 'strict'
        ? path.resolve(this.dataDir, `xhs_questions_${topic}_strict.json`)
        : path.resolve(this.dataDir, `xhs_questions_${topic}.json`);
      writeJsonFile(jsonPath, bucket);

      if (mode !== 'strict') {
        continue;
      }

      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(topic)} questions</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; color: #222; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; word-break: break-word; }
    th { background: #f5f5f5; }
    .seller { color: #b42318; font-weight: 600; }
    .purchase { color: #0550ae; font-weight: 600; }
  </style>
</head>
<body>
  <h1>${escapeHtml(topic)} 面经问题</h1>
  <p>count: ${bucket.length}</p>
  <table>
    <thead>
      <tr><th>company</th><th>rounds</th><th>seller</th><th>purchase</th><th>published_at</th><th>title</th><th>question</th><th>url</th></tr>
    </thead>
    <tbody>
      ${bucket.map((item) => `<tr><td>${escapeHtml(item.company)}</td><td>${escapeHtml(item.rounds)}</td><td class="${item.seller_flag ? 'seller' : ''}">${item.seller_flag ? escapeHtml(item.seller_tags.join(' / ') || 'seller') : (item.seller_whitelisted ? escapeHtml(`whitelisted:${item.seller_whitelist_reason}`) : '')}</td><td class="${item.purchase_link_flag ? 'purchase' : ''}">${item.purchase_link_flag ? escapeHtml(item.purchase_link_tags.join(' / ') || 'purchase-link') : ''}</td><td>${escapeHtml(item.published_at || '')}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.question)}</td><td><a href="${escapeHtml(item.url)}">link</a></td></tr>`).join('')}
    </tbody>
  </table>
</body>
</html>`;
      fs.writeFileSync(path.resolve(this.reportDir, `xhs_questions_${topic}.html`), html, 'utf8');
    }
  }

  exportOverview(rows: XhsQuestionRow[]): void {
    const summary = new Map<string, { company: string; question_count: number; rounds: Map<string, number>; topics: Map<string, number>; seller_count: number; purchase_link_count: number }>();
    const sellerNotes = this.readNotes()
      .filter((note) => note.seller_flag)
      .map((note) => ({
        note_id: note.note_id,
        title: note.title,
        author: note.author || '',
        seller_tags: note.seller_tags || [],
        seller_confidence: note.seller_confidence || 0,
        purchase_link_flag: Boolean(note.purchase_link_flag),
        purchase_links: note.purchase_links || [],
        purchase_link_tags: note.purchase_link_tags || [],
        url: note.url,
      }));

    for (const row of rows) {
      const company = row.company || '未知';
      const entry = summary.get(company) || {
        company,
        question_count: 0,
        rounds: new Map<string, number>(),
        topics: new Map<string, number>(),
        seller_count: 0,
        purchase_link_count: 0,
      };
      entry.question_count += 1;
      entry.rounds.set(row.rounds || '未知轮次', (entry.rounds.get(row.rounds || '未知轮次') || 0) + 1);
      for (const topic of row.topics) {
        entry.topics.set(topic, (entry.topics.get(topic) || 0) + 1);
      }
      if (row.seller_flag) entry.seller_count += 1;
      if (row.purchase_link_flag) entry.purchase_link_count += 1;
      summary.set(company, entry);
    }

    const summaryRows = [...summary.values()]
      .map((item) => ({
        company: item.company,
        question_count: item.question_count,
        rounds: Object.fromEntries([...item.rounds.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
        topics: Object.fromEntries([...item.topics.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
        seller_count: item.seller_count,
        purchase_link_count: item.purchase_link_count,
      }))
      .sort((a, b) => b.question_count - a.question_count || a.company.localeCompare(b.company));

    writeJsonFile(this.summaryPath, summaryRows);
    writeJsonFile(this.sellerSummaryPath, sellerNotes);

    const companies = [...new Set(rows.map((row) => row.company || '未知'))].sort();
    const rounds = [...new Set(rows.map((row) => row.rounds || '未知轮次'))].sort();
    const topics = [...new Set(rows.flatMap((row) => row.topics))].sort();

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>InterviewOps Overview</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; color: #222; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
    .filters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
    select, input { padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; margin-top: 16px; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; word-break: break-word; }
    th { background: #f5f5f5; }
    .seller { color: #b42318; font-weight: 600; }
    .purchase { color: #0550ae; font-weight: 600; }
  </style>
</head>
<body>
  <h1>InterviewOps XHS 面经总览</h1>
  <div class="cards">
    <div class="card"><strong>问题数</strong><div>${rows.length}</div></div>
    <div class="card"><strong>公司数</strong><div>${summaryRows.length}</div></div>
    <div class="card"><strong>卖课标记</strong><div>${sellerNotes.length}</div></div>
    <div class="card"><strong>购买链接</strong><div>${this.readNotes().filter((note) => note.purchase_link_flag).length}</div></div>
    <div class="card"><strong>汇总文件</strong><div>company_round_summary.json</div></div>
  </div>

  <h2>公司汇总</h2>
  <table>
    <thead><tr><th>company</th><th>question_count</th><th>seller_count</th><th>purchase_link_count</th><th>rounds</th><th>topics</th></tr></thead>
    <tbody>
      ${summaryRows.map((item) => `<tr><td>${escapeHtml(item.company)}</td><td>${item.question_count}</td><td>${item.seller_count}</td><td>${item.purchase_link_count}</td><td>${escapeHtml(Object.entries(item.rounds).map(([k, v]) => `${k}:${v}`).join(' | '))}</td><td>${escapeHtml(Object.entries(item.topics).map(([k, v]) => `${k}:${v}`).join(' | '))}</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>问题筛选</h2>
  <div class="filters">
    <label>Company<select id="company"><option value="">全部</option>${companies.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')}</select></label>
    <label>Rounds<select id="rounds"><option value="">全部</option>${rounds.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')}</select></label>
    <label>Topic<select id="topic"><option value="">全部</option>${topics.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')}</select></label>
    <label>Seller<select id="seller"><option value="">全部</option><option value="seller">仅卖课/导流</option><option value="normal">仅普通</option></select></label>
    <label>Purchase<select id="purchase"><option value="">全部</option><option value="purchase">仅含购买链接</option><option value="normal">仅无购买链接</option></select></label>
    <label>Keyword<input id="keyword" placeholder="搜索标题 / 问题 / 公司" /></label>
  </div>
  <div id="count"></div>
  <table>
    <thead><tr><th>company</th><th>rounds</th><th>seller</th><th>purchase</th><th>published_at</th><th>title</th><th>question</th><th>url</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <script>
    const rows = ${JSON.stringify(rows)};
    const company = document.getElementById('company');
    const rounds = document.getElementById('rounds');
    const topic = document.getElementById('topic');
    const seller = document.getElementById('seller');
    const purchase = document.getElementById('purchase');
    const keyword = document.getElementById('keyword');
    const tbody = document.getElementById('tbody');
    const count = document.getElementById('count');

    function render() {
      const filtered = rows.filter((row) => {
        const kw = keyword.value.trim().toLowerCase();
        if (company.value && row.company !== company.value) return false;
        if (rounds.value && row.rounds !== rounds.value) return false;
        if (topic.value && !row.topics.includes(topic.value)) return false;
        if (seller.value === 'seller' && !row.seller_flag) return false;
        if (seller.value === 'normal' && row.seller_flag) return false;
        if (purchase.value === 'purchase' && !row.purchase_link_flag) return false;
        if (purchase.value === 'normal' && row.purchase_link_flag) return false;
        if (kw && ![row.company, row.title, row.question].join(' ').toLowerCase().includes(kw)) return false;
        return true;
      });

      count.textContent = 'result: ' + filtered.length;
      tbody.innerHTML = filtered.map((row) =>
        '<tr>' +
        '<td>' + escapeHtml(row.company || '') + '</td>' +
        '<td>' + escapeHtml(row.rounds || '') + '</td>' +
        '<td class="' + (row.seller_flag ? 'seller' : '') + '">' + escapeHtml(row.seller_flag ? (row.seller_tags.join(' / ') || 'seller') : (row.seller_whitelisted ? ('whitelisted:' + (row.seller_whitelist_reason || '')) : '')) + '</td>' +
        '<td class="' + (row.purchase_link_flag ? 'purchase' : '') + '">' + escapeHtml(row.purchase_link_flag ? (row.purchase_link_tags.join(' / ') || 'purchase-link') : '') + '</td>' +
        '<td>' + escapeHtml(row.published_at || '') + '</td>' +
        '<td>' + escapeHtml(row.title || '') + '</td>' +
        '<td>' + escapeHtml(row.question || '') + '</td>' +
        '<td><a href="' + escapeHtml(row.url || '') + '">link</a></td>' +
        '</tr>'
      ).join('');
    }

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    [company, rounds, topic, seller, purchase, keyword].forEach((el) => el.addEventListener('input', render));
    render();
  </script>
</body>
</html>`;
    fs.writeFileSync(path.resolve(this.reportDir, 'index.html'), html, 'utf8');
  }

  exportSellerReports(): void {
    const notes = this.readNotes();
    const sellerNotes = notes
      .filter((note) => note.seller_flag)
      .map((note) => ({
        note_id: note.note_id,
        title: note.title,
        author: note.author || '未知作者',
        query: note.query,
        seller_tags: note.seller_tags || [],
        seller_confidence: Number(note.seller_confidence || 0),
        seller_whitelisted: Boolean(note.seller_whitelisted),
        seller_whitelist_reason: String(note.seller_whitelist_reason || ''),
        published_at: note.published_at || '',
        purchase_link_flag: Boolean(note.purchase_link_flag),
        purchase_links: note.purchase_links || [],
        purchase_link_tags: note.purchase_link_tags || [],
        url: note.url,
      }))
      .sort((a, b) => b.seller_confidence - a.seller_confidence || a.author.localeCompare(b.author));
    const authorSummary = summarizeSellerAuthors(notes);

    writeJsonFile(this.sellerSummaryPath, sellerNotes);
    writeJsonFile(this.authorSellerSummaryPath, authorSummary);

    const markdown = `# Seller Summary

候选卖课/导流笔记数：${sellerNotes.length}
候选作者数：${authorSummary.length}

## 作者汇总

${authorSummary.map((item) => `- ${item.author}: note_count=${item.note_count}, seller_note_count=${item.seller_note_count}, tags=${item.seller_tags.join(' / ') || 'none'}, max_confidence=${item.max_confidence}`).join('\n')}

## 笔记候选

${sellerNotes.map((item) => `- ${item.author} | ${item.title} | confidence=${item.seller_confidence} | tags=${item.seller_tags.join(' / ') || 'none'} | purchase=${item.purchase_link_flag ? (item.purchase_link_tags.join(' / ') || 'yes') : 'no'} | ${item.url}`).join('\n')}
`;
    fs.writeFileSync(this.sellerReportPath, markdown, 'utf8');
  }

  exportScopeReport(): void {
    const notes = this.readNotes();
    const snapshot = this.buildScopeSnapshot(notes);
    if (!snapshot) {
      return;
    }
    const byId = new Map(notes.map((note) => [note.note_id, note]));
    const scopeNotes = snapshot.rows
      .map((row) => byId.get(row.note_id))
      .filter((note): note is XhsNote => Boolean(note));
    writeJsonFile(this.scopeNotesPath, scopeNotes);
    writeJsonFile(this.scopeReportJsonPath, snapshot);

    const markdown = [
      '# Scope Candidates',
      '',
      `total: ${snapshot.rows.length}`,
      `strong: ${snapshot.strong}`,
      `medium: ${snapshot.medium}`,
      '',
      '## Strong',
      ...snapshot.rows
        .filter((item) => item.strength === 'strong')
        .map((item) => `- ${item.company} | ${item.published_at || ''} | ${item.title} | seller=${item.seller_flag} | purchase=${item.purchase_link_flag} | ${item.url}`),
      '',
      '## Medium',
      ...snapshot.rows
        .filter((item) => item.strength === 'medium')
        .map((item) => `- ${item.company} | ${item.published_at || ''} | ${item.title} | reasons=${item.match_reasons.join(',')} | seller=${item.seller_flag} | purchase=${item.purchase_link_flag} | ${item.url}`),
      '',
    ].join('\n');
    fs.writeFileSync(this.scopeReportMarkdownPath, markdown, 'utf8');
  }

  exportOverviewBundle(recordStage = true): void {
    const startedAt = Date.now();
    const { looseRows, strictRows } = this.buildQuestionExports();
    this.exportOverview(strictRows);
    this.exportSellerReports();
    this.exportScopeReport();
    if (recordStage) {
      this.recordOperation('overview', {
        ok: true,
        detail: `questions_strict=${strictRows.length}, questions_loose=${looseRows.length}, seller_candidates=${this.readNotes().filter((note) => note.seller_flag).length}, purchase_links=${this.readNotes().filter((note) => note.purchase_link_flag).length}`,
        item_count: strictRows.length,
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  exportAll(): XhsQuestionRow[] {
    const startedAt = Date.now();
    const { looseRows, strictRows } = this.buildQuestionExports();
    this.exportOverview(strictRows);
    this.exportSellerReports();
    this.exportScopeReport();
    this.recordOperation('export', {
      ok: true,
      detail: `questions_strict=${strictRows.length}, questions_loose=${looseRows.length}`,
      item_count: strictRows.length,
      duration_ms: Date.now() - startedAt,
    });
    return strictRows;
  }

  validate(recordStage = true): void {
    const startedAt = Date.now();
    const notes = this.readNotes();
    const noteIds = new Set<string>();
    for (const note of notes) {
      for (const key of ['note_id', 'url', 'title', 'query', 'first_seen_at', 'last_seen_at', 'crawl_source'] as const) {
        if (!String(note[key] || '').trim()) {
          throw new Error(`invalid note: missing ${key}`);
        }
      }
      if (noteIds.has(note.note_id)) {
        throw new Error(`duplicate note_id: ${note.note_id}`);
      }
      noteIds.add(note.note_id);
      if (note.interview_questions && !Array.isArray(note.interview_questions)) {
        throw new Error(`invalid interview_questions for ${note.note_id}`);
      }
    }

    const state = this.readState();
    if (typeof state.version !== 'number' || typeof state.updated_at !== 'string' || typeof state.queries !== 'object') {
      throw new Error('invalid state file');
    }
    if (recordStage) {
      this.recordOperation('validate', {
        ok: true,
        detail: `notes=${notes.length}`,
        item_count: notes.length,
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  runCycle(cycle: number): void {
    const startedAt = Date.now();
    this.log(`cycle ${cycle} starting`);
    this.log(`before stats: ${JSON.stringify(this.stats())}`);
    this.syncSeedSourceIfChanged();
    if (cycle === 1 || cycle % this.config.harvestEvery === 0) {
      this.harvestIncremental();
    }
    this.hydrateDetails();
    this.enrichComments();
    this.exportAll();
    this.validate(false);
    this.log(`after stats: ${JSON.stringify(this.stats())}`);
    this.recordOperation('cycle', {
      ok: true,
      detail: `cycle=${cycle}`,
      item_count: cycle,
      duration_ms: Date.now() - startedAt,
    });
    this.commitIfChanged();
  }

  runNightly(hours: number): void {
    const startedAt = Date.now();
    const deadline = Date.now() + hours * 3600_000;
    let cycle = 0;
    let failures = 0;
    let consecutiveFailures = 0;
    this.log(`starting overnight run for ${hours}h`);
    while (Date.now() < deadline) {
      cycle += 1;
      try {
        this.runCycle(cycle);
        consecutiveFailures = 0;
      } catch (error) {
        failures += 1;
        consecutiveFailures += 1;
        this.log(`cycle ${cycle} failed: ${formatOperationError(error)}`);
        if (consecutiveFailures >= this.config.nightlyMaxConsecutiveFailures) {
          throw error;
        }
        if (Date.now() >= deadline) {
          break;
        }
        this.log(`failure backoff ${this.config.nightlyFailureBackoffSeconds}s`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.config.nightlyFailureBackoffSeconds * 1000);
        continue;
      }
      if (Date.now() >= deadline) break;
      const min = this.config.sleepMinSeconds;
      const max = this.config.sleepMaxSeconds;
      const seconds = min + Math.floor(Math.random() * Math.max(1, max - min + 1));
      this.log(`sleeping ${seconds}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
    }
    this.log('overnight run finished');
    this.recordOperation('nightly', {
      ok: failures === 0,
      detail: `hours=${hours}, cycles=${cycle}, failures=${failures}`,
      item_count: cycle,
      duration_ms: Date.now() - startedAt,
    });
  }

  commitIfChanged(): void {
    if (!this.autoCommit) {
      this.log('auto commit disabled');
      return;
    }

    const status = runProcess('git', ['status', '--porcelain'], { cwd: this.workspace });
    if (status.status !== 0 || !status.stdout.trim()) {
      this.log('no file changes this cycle');
      return;
    }

    runProcessOrThrow('git', ['add', 'interview_data', 'reports/xhs-miangjing'], { cwd: this.workspace });
    const message = `interviewops: nightly cycle ${nowIsoUtc8().replace(/[-:]/g, '').replace('+08:00', '')}`;
    runProcessOrThrow('git', ['commit', '-m', message], { cwd: this.workspace });
    this.log(`committed: ${message}`);
  }

  private log(message: string): void {
    const line = `[${nowIsoUtc8()}] ${message}\n`;
    ensureDir(path.dirname(this.progressLogPath));
    fs.appendFileSync(this.progressLogPath, line, 'utf8');
    process.stdout.write(line);
  }

  private recordOperation(
    stage: PipelineStageName,
    input: Omit<PipelineOperationRecord, 'stage' | 'last_run_at' | 'stats'>,
  ): void {
    const state = this.readState();
    const record: PipelineOperationRecord = {
      stage,
      last_run_at: nowIsoUtc8(),
      stats: this.stats(),
      ...input,
    };
    state.operations = {
      ...(state.operations || {}),
      [stage]: record,
    };
    state.updated_at = record.last_run_at;
    this.writeState(state);
    appendJsonLine(this.runHistoryPath, record);
    writeJsonFile(this.statusPath, this.status());
  }

  private buildHarvestQueries(
    notes: XhsNote[],
    state: XhsState,
  ): Array<{ query: string; due: boolean; nextRunAfter: string | null; slotCost: number; timeoutSeconds: number; priority: number }> {
    const queries = new Set(this.config.queries.map((query) => query.trim()).filter(Boolean));
    const extraCounts = new Map<string, number>();
    for (const note of [...notes, ...this.readSeedSourceNotes()]) {
      const query = String(note.query || '').trim();
      if (!query || queries.has(query)) {
        continue;
      }
      extraCounts.set(query, (extraCounts.get(query) || 0) + 1);
    }
    const extras = [...extraCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([query]) => query);
    const now = Date.now();
    const plans = [...queries, ...extras].map((query) => {
      const queryState = state.queries?.[query];
      const nextRunAfter = String(queryState?.next_run_after || '').trim() || null;
      const nextRunAt = nextRunAfter ? Date.parse(nextRunAfter) : NaN;
      const due = !nextRunAfter || !Number.isFinite(nextRunAt) || nextRunAt <= now;
      return {
        query,
        due,
        nextRunAfter,
        slotCost: this.computeQuerySlotCost(queryState),
        timeoutSeconds: this.resolveSearchTimeoutSeconds(queryState),
        priority: computeQueryPriority(queryState),
      };
    });
    const duePlans = plans
      .filter((plan) => plan.due)
      .sort((a, b) => {
        const aState = state.queries?.[a.query];
        const bState = state.queries?.[b.query];
        return compareQueryPlans(a.query, a.priority, aState, b.query, b.priority, bState);
      });
    const selected: typeof duePlans = [];
    let usedSlots = 0;
    for (const plan of duePlans) {
      if (selected.length > 0 && usedSlots + plan.slotCost > this.config.maxQueriesPerHarvest) {
        continue;
      }
      selected.push(plan);
      usedSlots += plan.slotCost;
      if (usedSlots >= this.config.maxQueriesPerHarvest) {
        break;
      }
    }
    return selected;
  }

  private buildScopeSnapshot(notes: XhsNote[]): ScopeSnapshot | null {
    const scope = this.config.scopeFilter;
    if (!scope || (!scope.since && !(scope.companies || []).length)) {
      return null;
    }
    const rows = buildScopeCandidates(notes, scope, new Date());
    return {
      scope,
      total_candidates: rows.length,
      strong: rows.filter((item) => item.strength === 'strong').length,
      medium: rows.filter((item) => item.strength === 'medium').length,
      rows,
    };
  }

  private prioritizeScopeNotes(notes: XhsNote[]): XhsNote[] {
    const snapshot = this.buildScopeSnapshot(notes);
    if (!snapshot || snapshot.rows.length === 0) {
      return notes;
    }
    const scopeIds = new Set(snapshot.rows.map((item) => item.note_id));
    return [
      ...notes.filter((note) => scopeIds.has(note.note_id)),
      ...notes.filter((note) => !scopeIds.has(note.note_id)),
    ];
  }

  private readSeedSourceNotes(): XhsNote[] {
    const sourcePath = String(this.config.seedSourceNotesPath || '').trim();
    if (!sourcePath) {
      return [];
    }
    const resolved = this.resolveWorkspacePath(sourcePath);
    if (!fs.existsSync(resolved)) {
      return [];
    }
    return readJsonFile<XhsNote[]>(resolved, []);
  }

  private syncSeedSourceIfChanged(): void {
    const sourcePath = String(this.config.seedSourceNotesPath || '').trim();
    if (!sourcePath) {
      return;
    }
    const resolved = this.resolveWorkspacePath(sourcePath);
    if (!fs.existsSync(resolved)) {
      return;
    }
    this.seedImportNotes(resolved);
  }

  private resolveWorkspacePath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(this.workspace, filePath);
  }

  private buildQuestionExports(): { looseRows: XhsQuestionRow[]; strictRows: XhsQuestionRow[] } {
    this.normalizeQuestionsAndSellerFlags(false);
    const looseRows = this.exportQuestions('loose');
    const strictRows = this.exportQuestions('strict');
    this.exportTopicReports(looseRows, 'loose');
    this.exportTopicReports(strictRows, 'strict');
    return { looseRows, strictRows };
  }

  private buildNextQueryRunAt(input: {
    status: 'success' | 'duplicate' | 'empty' | 'error' | 'timeout';
    emptyRuns: number;
    errorRuns: number;
    timeoutRuns: number;
    seenAt: string;
  }): string {
    const baseMinutes =
      input.status === 'success'
        ? this.config.querySuccessCooldownMinutes
        : input.status === 'duplicate'
          ? this.config.queryDuplicateCooldownMinutes
          : input.status === 'empty'
            ? this.config.queryEmptyCooldownMinutes
            : input.status === 'timeout'
              ? this.config.queryTimeoutCooldownMinutes
              : this.config.queryErrorCooldownMinutes;
    const multiplier =
      input.status === 'empty'
        ? Math.min(4, Math.max(1, input.emptyRuns))
        : input.status === 'timeout'
          ? Math.min(4, Math.max(1, input.timeoutRuns))
          : input.status === 'error'
          ? Math.min(4, Math.max(1, input.errorRuns))
          : 1;
    return addMinutes(input.seenAt, baseMinutes * multiplier);
  }

  private resolveSearchTimeoutSeconds(queryState: XhsState['queries'][string] | undefined): number {
    const timeoutRuns = Math.max(0, Number(queryState?.timeout_runs || 0));
    const factor = Math.max(1, Number(this.config.queryTimeoutEscalationFactor || 1));
    const base = Math.max(this.config.perQueryTimeoutSeconds, SEARCH_TIMEOUT_FLOOR_SECONDS);
    const escalated = Math.round(base * Math.pow(factor, timeoutRuns));
    return Math.min(Math.max(base, escalated), this.config.queryTimeoutMaxSeconds);
  }

  private computeQuerySlotCost(queryState: XhsState['queries'][string] | undefined): number {
    const timeoutRuns = Math.max(0, Number(queryState?.timeout_runs || 0));
    if (timeoutRuns <= 0) {
      return 1;
    }
    return Math.max(1, Math.min(3, this.config.timeoutQuerySlotCost + timeoutRuns - 1));
  }
}

function formatOperationError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

function resolveQuestionsPath(dataDir: string, mode: QuestionExtractMode): string {
  return path.resolve(dataDir, mode === 'strict' ? 'xhs_questions_strict.json' : 'xhs_questions.json');
}

function isNoteAttemptDue(
  note: Pick<XhsNote, 'detail_next_attempt_after' | 'comment_next_attempt_after'>,
  kind: 'detail' | 'comment',
  nowMs: number,
): boolean {
  const nextAttemptAfter = kind === 'detail' ? note.detail_next_attempt_after : note.comment_next_attempt_after;
  const nextAttemptAt = Date.parse(String(nextAttemptAfter || '').trim());
  return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= nowMs;
}

function clearNoteAttemptError(
  note: XhsNote,
  kind: 'detail' | 'comment',
): void {
  if (kind === 'detail') {
    note.detail_error_runs = 0;
    note.detail_last_error = null;
    note.detail_next_attempt_after = null;
    return;
  }
  note.comment_error_runs = 0;
  note.comment_last_error = null;
  note.comment_next_attempt_after = null;
}

function recordNoteAttemptError(
  note: XhsNote,
  kind: 'detail' | 'comment',
  seenAt: string,
  error: unknown,
): string {
  const message = formatOperationError(error);
  const currentRuns = kind === 'detail'
    ? Number(note.detail_error_runs || 0)
    : Number(note.comment_error_runs || 0);
  const nextRuns = currentRuns + 1;
  const backoffMinutes = NOTE_RETRY_BACKOFF_MINUTES[Math.min(nextRuns - 1, NOTE_RETRY_BACKOFF_MINUTES.length - 1)];
  const nextAttemptAfter = addMinutes(seenAt, backoffMinutes);

  if (kind === 'detail') {
    note.detail_error_runs = nextRuns;
    note.detail_last_error = message;
    note.detail_next_attempt_after = nextAttemptAfter;
    return message;
  }

  note.comment_error_runs = nextRuns;
  note.comment_last_error = message;
  note.comment_next_attempt_after = nextAttemptAfter;
  return message;
}

function mergeQueries(
  ...sources: Array<Record<string, unknown> | null | undefined | string>
): string[] {
  const merged = new Set<string>();
  for (const source of sources) {
    if (typeof source === 'string') {
      const query = source.trim();
      if (query) {
        merged.add(query);
      }
      continue;
    }
    if (!source) {
      continue;
    }
    const queries = source.queries;
    if (!Array.isArray(queries)) {
      continue;
    }
    for (const value of queries) {
      const query = String(value || '').trim();
      if (query) {
        merged.add(query);
      }
    }
  }
  return [...merged].sort();
}

function compareQueryPlans(
  leftQuery: string,
  leftPriority: number,
  left: { last_run_at: string; added_note_count?: number; error_runs?: number } | undefined,
  rightQuery: string,
  rightPriority: number,
  right: { last_run_at: string; added_note_count?: number; error_runs?: number } | undefined,
): number {
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  if (!left && right) {
    return -1;
  }
  if (left && !right) {
    return 1;
  }
  const leftErrors = Number(left?.error_runs || 0);
  const rightErrors = Number(right?.error_runs || 0);
  if (leftErrors !== rightErrors) {
    return leftErrors - rightErrors;
  }
  const leftRunAt = Date.parse(left?.last_run_at || '');
  const rightRunAt = Date.parse(right?.last_run_at || '');
  if (Number.isFinite(leftRunAt) && Number.isFinite(rightRunAt) && leftRunAt !== rightRunAt) {
    return leftRunAt - rightRunAt;
  }
  return leftQuery.localeCompare(rightQuery);
}

function computeQueryPriority(queryState: {
  added_note_count?: number;
  duplicate_note_count?: number;
  empty_runs?: number;
  error_runs?: number;
  timeout_runs?: number;
} | undefined): number {
  if (!queryState) {
    return 25;
  }
  const added = Math.max(0, Number(queryState.added_note_count || 0));
  const duplicates = Math.max(0, Number(queryState.duplicate_note_count || 0));
  const emptyRuns = Math.max(0, Number(queryState.empty_runs || 0));
  const errorRuns = Math.max(0, Number(queryState.error_runs || 0));
  const timeoutRuns = Math.max(0, Number(queryState.timeout_runs || 0));
  return (added * 20) + Math.min(duplicates, 5) - (emptyRuns * 8) - (errorRuns * 5) - (timeoutRuns * 12);
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ETIMEDOUT|timed out/i.test(message);
}

function addMinutes(isoTimestamp: string, minutes: number): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) {
    return nowIsoUtc8();
  }
  date.setMinutes(date.getMinutes() + minutes);
  return formatIsoUtc8(date);
}

function formatIsoUtc8(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace('Z', '+08:00');
}

function buildFileSignature(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${filePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}
