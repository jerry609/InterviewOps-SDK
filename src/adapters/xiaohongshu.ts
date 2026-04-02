import { OpenCliRunner } from './opencli.js';
import type { InterviewSourceAdapter, SourceCommentRow, SourceDetailRow, SourceSearchRow } from './types.js';

export class XiaohongshuAdapter implements InterviewSourceAdapter {
  readonly sourceName = 'xiaohongshu';

  constructor(private readonly runner: OpenCliRunner) {}

  search(query: string, limit: number, timeoutSeconds: number): SourceSearchRow[] {
    return this.runner.search(query, limit, timeoutSeconds);
  }

  comments(target: string, limit: number, timeoutSeconds: number): SourceCommentRow[] {
    return this.runner.comments(target, limit, timeoutSeconds);
  }

  detail(target: string, timeoutSeconds: number): SourceDetailRow[] {
    return this.runner.noteDetail(target, timeoutSeconds);
  }
}

export function createSourceAdapter(source: string, runner: OpenCliRunner): InterviewSourceAdapter {
  switch (source) {
    case 'xiaohongshu':
      return new XiaohongshuAdapter(runner);
    default:
      throw new Error(`unsupported source adapter: ${source}`);
  }
}
