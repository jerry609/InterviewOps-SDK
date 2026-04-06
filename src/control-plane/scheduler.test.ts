import { describe, expect, it } from 'vitest';

import { chooseFallbackOperation } from './scheduler.js';

describe('chooseFallbackOperation', () => {
  it('prioritizes hydrate before harvest when hydrate backlog exists', () => {
    expect(chooseFallbackOperation({
      workspace: '/tmp/workspace',
      config_path: '/tmp/workspace/interviewops.xhs.json',
      backlog: {
        due_queries: 4,
        pending_hydrate: 2,
        pending_comments: 1,
        notes_total: 9,
        strict_export_ready: false,
      },
      control_plane: {
        scheduler_mode: 'polling',
        objective: 'collect',
        last_decision_at: null,
        last_decision_reason: null,
        active_operation: null,
        cooldowns: {},
        circuits: {},
        backlog_snapshot: null,
      },
      recent_operations: [],
    })).toEqual({
      kind: 'hydrate',
      reason: 'pending hydrate backlog dominates current cycle',
      limit: 12,
    });
  });
});
