export type XhsComment = {
  author?: string | null;
  content?: string | null;
  likes?: string | number | null;
  time?: string | null;
};

export type QuestionExtractMode = 'loose' | 'strict';

export type XhsNote = {
  note_id: string;
  url: string;
  title: string;
  author?: string | null;
  author_url?: string | null;
  likes?: string | null;
  published_at?: string | null;
  query: string;
  first_seen_at: string;
  last_seen_at: string;
  crawl_source: string;
  interview_questions?: string[] | null;
  comment_count?: number | null;
  comments?: XhsComment[] | null;
  crawl_meta?: Record<string, unknown> | null;
  content?: string | null;
  detail_fetched_at?: string | null;
  detail_error_runs?: number | null;
  detail_last_error?: string | null;
  detail_next_attempt_after?: string | null;
  seller_flag?: boolean | null;
  seller_whitelisted?: boolean | null;
  seller_whitelist_reason?: string | null;
  seller_tags?: string[] | null;
  seller_confidence?: number | null;
  purchase_link_flag?: boolean | null;
  purchase_links?: string[] | null;
  purchase_link_tags?: string[] | null;
  purchase_link_confidence?: number | null;
  comment_error_runs?: number | null;
  comment_last_error?: string | null;
  comment_next_attempt_after?: string | null;
};

export type QueryState = {
  last_run_at: string;
  newest_published_at: string | null;
  last_result_count: number;
  added_note_count?: number;
  duplicate_note_count?: number;
  empty_runs?: number;
  error_runs?: number;
  timeout_runs?: number;
  last_error_kind?: string | null;
  search_timeout_seconds?: number;
  next_run_after?: string | null;
  last_error?: string;
};

export type PipelineStageName =
  | 'seed'
  | 'harvest'
  | 'hydrate'
  | 'comments'
  | 'normalize'
  | 'questions'
  | 'overview'
  | 'export'
  | 'validate'
  | 'cycle'
  | 'nightly';

export type PipelineOperationRecord = {
  stage: PipelineStageName;
  last_run_at: string;
  ok: boolean;
  detail: string;
  item_count?: number;
  duration_ms?: number;
  stats?: XhsStats;
};

export type XhsState = {
  version: number;
  updated_at: string;
  queries: Record<string, QueryState>;
  operations?: Partial<Record<PipelineStageName, PipelineOperationRecord>>;
  detail_hydration?: Record<string, unknown>;
  comment_enrichment?: Record<string, unknown>;
  seed_import?: {
    source_path: string;
    source_signature: string;
    source_notes: number;
    merged_total: number;
    last_imported_at: string;
  };
};

export type XhsStats = {
  notes: number;
  contentFilled: number;
  questionsFilled: number;
  commentsEnriched: number;
  sellerFlagged: number;
  sellerWhitelisted: number;
  purchaseLinkFlagged: number;
};

export type XhsQuestionRow = {
  note_id: string;
  title: string;
  query: string;
  published_at?: string | null;
  author?: string | null;
  url: string;
  question_index: number;
  question: string;
  company: string;
  rounds: string;
  topics: string[];
  seller_flag: boolean;
  seller_whitelisted: boolean;
  seller_whitelist_reason: string;
  seller_tags: string[];
  seller_confidence: number;
  purchase_link_flag: boolean;
  purchase_links: string[];
  purchase_link_tags: string[];
  purchase_link_confidence: number;
};

export type SellerSignal = {
  flag: boolean;
  tags: string[];
  confidence: number;
};

export type PurchaseLinkSignal = {
  flag: boolean;
  links: string[];
  tags: string[];
  confidence: number;
};

export type SellerWhitelistConfig = {
  authors?: string[];
  note_ids?: string[];
  title_keywords?: string[];
  urls?: string[];
};

export type SellerWhitelistDecision = {
  whitelisted: boolean;
  reason: string;
};

export type SellerAuthorSummary = {
  author: string;
  note_count: number;
  seller_note_count: number;
  seller_tags: string[];
  max_confidence: number;
  note_ids: string[];
  titles: string[];
};

export type XhsPrdConfig = {
  source?: string;
  queries: string[];
  sellerWhitelist?: SellerWhitelistConfig;
  seedSourceNotesPath?: string;
  scopeFilter?: {
    since?: string;
    companies?: string[];
    agentKeywords?: string[];
    algoKeywords?: string[];
    excludeTitleKeywords?: string[];
  };
  dataDir?: string;
  reportDir?: string;
  stateFile?: string;
  maxSearchResultsPerQuery?: number;
  perQueryTimeoutSeconds?: number;
  detailTimeoutSeconds?: number;
  commentTimeoutSeconds?: number;
  commentLimit?: number;
  detailBatch?: number;
  commentBatch?: number;
  harvestEvery?: number;
  sleepMinSeconds?: number;
  sleepMaxSeconds?: number;
  maxQueriesPerHarvest?: number;
  querySuccessCooldownMinutes?: number;
  queryDuplicateCooldownMinutes?: number;
  queryEmptyCooldownMinutes?: number;
  queryErrorCooldownMinutes?: number;
  queryTimeoutCooldownMinutes?: number;
  queryTimeoutEscalationFactor?: number;
  queryTimeoutMaxSeconds?: number;
  timeoutQuerySlotCost?: number;
  nightlyMaxConsecutiveFailures?: number;
  nightlyFailureBackoffSeconds?: number;
};

export type PipelineOptions = {
  workspace: string;
  prdPath: string;
  autoCommit: boolean;
  progressLogPath: string;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type PipelineStatus = {
  workspace: string;
  source: string;
  config_path: string;
  updated_at: string;
  stats: XhsStats;
  queries: {
    total: number;
    with_errors: number;
  };
  operations: PipelineOperationRecord[];
  whitelist: {
    authors: number;
    note_ids: number;
    title_keywords: number;
    urls: number;
  };
};

export type ScopeSnapshot = {
  scope: NonNullable<XhsPrdConfig['scopeFilter']>;
  total_candidates: number;
  strong: number;
  medium: number;
  rows: ScopeCandidate[];
};

export type ScopeCandidate = {
  note_id: string;
  title: string;
  company: string;
  published_at?: string | null;
  query: string;
  author?: string | null;
  url: string;
  strength: 'strong' | 'medium';
  match_reasons: string[];
  seller_flag: boolean;
  purchase_link_flag: boolean;
};
