export type XhsComment = {
  author?: string | null;
  content?: string | null;
  likes?: string | number | null;
  time?: string | null;
};

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
  seller_flag?: boolean | null;
  seller_tags?: string[] | null;
  seller_confidence?: number | null;
};

export type QueryState = {
  last_run_at: string;
  newest_published_at: string | null;
  last_result_count: number;
  last_error?: string;
};

export type PipelineStageName =
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
};

export type XhsStats = {
  notes: number;
  contentFilled: number;
  questionsFilled: number;
  commentsEnriched: number;
  sellerFlagged: number;
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
  seller_tags: string[];
  seller_confidence: number;
};

export type SellerSignal = {
  flag: boolean;
  tags: string[];
  confidence: number;
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
};
