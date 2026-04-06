import { describe, expect, it } from 'vitest';

import { buildBacklogSnapshot } from './state.js';

describe('buildBacklogSnapshot', () => {
  it('counts due queries and pending note work from workspace state', () => {
    const snapshot = buildBacklogSnapshot(
      [
        {
          note_id: 'n1',
          content: null,
          comments: null,
          interview_questions: [],
          detail_next_attempt_after: null,
          comment_next_attempt_after: null,
        },
        {
          note_id: 'n2',
          content: 'done',
          comments: null,
          interview_questions: ['q1'],
          detail_next_attempt_after: null,
          comment_next_attempt_after: null,
        },
      ] as any,
      {
        version: 1,
        updated_at: '2026-04-06T10:00:00+08:00',
        queries: {
          alpha: {
            last_run_at: '2026-04-06T09:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            next_run_after: null,
          },
          beta: {
            last_run_at: '2026-04-06T09:00:00+08:00',
            newest_published_at: null,
            last_result_count: 0,
            next_run_after: '2099-01-01T00:00:00+08:00',
          },
        },
      } as any,
      { queries: ['alpha', 'beta'] } as any,
      Date.parse('2026-04-06T10:00:00+08:00'),
    );

    expect(snapshot.due_queries).toBe(1);
    expect(snapshot.pending_hydrate).toBe(1);
    expect(snapshot.pending_comments).toBe(2);
    expect(snapshot.notes_total).toBe(2);
    expect(snapshot.strict_export_ready).toBe(false);
  });
});
