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
      reason: 'pending_hydrate backlog dominates current cycle',
      limit: 12,
    });
  });

  it('uses the exact plan reason strings for each fallback operation', () => {
    expect(chooseFallbackOperation({
      workspace: '/tmp/workspace',
      config_path: '/tmp/workspace/interviewops.xhs.json',
      backlog: {
        due_queries: 0,
        pending_hydrate: 0,
        pending_comments: 2,
        notes_total: 2,
        strict_export_ready: false,
      },
      control_plane: {},
      recent_operations: [],
    })).toEqual({
      kind: 'comments',
      reason: 'pending_comments backlog dominates current cycle',
      limit: 8,
    });

    expect(chooseFallbackOperation({
      workspace: '/tmp/workspace',
      config_path: '/tmp/workspace/interviewops.xhs.json',
      backlog: {
        due_queries: 3,
        pending_hydrate: 0,
        pending_comments: 0,
        notes_total: 3,
        strict_export_ready: false,
      },
      control_plane: {},
      recent_operations: [],
    })).toEqual({
      kind: 'harvest',
      reason: 'due_queries backlog requires collection',
      query_limit: 3,
    });

    expect(chooseFallbackOperation({
      workspace: '/tmp/workspace',
      config_path: '/tmp/workspace/interviewops.xhs.json',
      backlog: {
        due_queries: 0,
        pending_hydrate: 0,
        pending_comments: 0,
        notes_total: 3,
        strict_export_ready: true,
      },
      control_plane: {},
      recent_operations: [],
    })).toEqual({
      kind: 'export',
      reason: 'workspace is export-ready after backlog drain',
    });

    expect(chooseFallbackOperation({
      workspace: '/tmp/workspace',
      config_path: '/tmp/workspace/interviewops.xhs.json',
      backlog: {
        due_queries: 0,
        pending_hydrate: 0,
        pending_comments: 0,
        notes_total: 3,
        strict_export_ready: false,
      },
      control_plane: {},
      recent_operations: [],
    })).toEqual({
      kind: 'validate',
      reason: 'no collection backlog remains; validate workspace health',
    });
  });
});
