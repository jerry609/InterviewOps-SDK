export type SourceSearchRow = {
  title?: unknown;
  author?: unknown;
  author_url?: unknown;
  likes?: unknown;
  url?: unknown;
  published_at?: unknown;
};

export type SourceCommentRow = {
  author?: unknown;
  text?: unknown;
  content?: unknown;
  likes?: unknown;
  time?: unknown;
};

export type SourceDetailRow = {
  url?: unknown;
  title?: unknown;
  author?: unknown;
  published_at?: unknown;
  content?: unknown;
  tags?: unknown;
};

export interface InterviewSourceAdapter {
  readonly sourceName: string;
  search(query: string, limit: number, timeoutSeconds: number): SourceSearchRow[];
  comments(target: string, limit: number, timeoutSeconds: number): SourceCommentRow[];
  detail(target: string, timeoutSeconds: number): SourceDetailRow[];
}
