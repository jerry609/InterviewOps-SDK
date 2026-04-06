import * as path from 'node:path';

import { buildHarvestQueryPlans, type HarvestPlannerConfig } from '../harvest-planner.js';
import { appendJsonLine } from '../json.js';
import type { XhsNote, XhsPrdConfig, XhsState } from '../types.js';
import {
  type BacklogSnapshot,
  type ControlPlaneJournalEvent,
  type ControlPlaneState,
  createEmptyControlPlaneState,
} from './contracts.js';

export function buildBacklogSnapshot(
  notes: XhsNote[],
  state: XhsState,
  config: Pick<Required<XhsPrdConfig>, 'queries'> & Partial<HarvestPlannerConfig>,
  nowMs = Date.now(),
  seedNotes: XhsNote[] = [],
): BacklogSnapshot {
  const dueQueries = buildHarvestQueryPlans({
    notes,
    seedNotes,
    state,
    config,
    nowMs,
  }).length;

  const pendingHydrate = notes.filter((note) => {
    const nextAttemptAt = Date.parse(String(note.detail_next_attempt_after || '').trim());
    return !String(note.content || '').trim() && (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= nowMs);
  }).length;

  const pendingComments = notes.filter((note) => {
    const nextAttemptAt = Date.parse(String(note.comment_next_attempt_after || '').trim());
    return note.comments == null && (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= nowMs);
  }).length;

  return {
    due_queries: dueQueries,
    pending_hydrate: pendingHydrate,
    pending_comments: pendingComments,
    notes_total: notes.length,
    strict_export_ready: dueQueries === 0 && pendingHydrate === 0 && pendingComments === 0,
  };
}

export function ensureControlPlaneState(state: XhsState): ControlPlaneState {
  if (!state.control_plane) {
    return createEmptyControlPlaneState();
  }

  const defaults = createEmptyControlPlaneState();
  return {
    ...defaults,
    ...state.control_plane,
    cooldowns: {
      ...defaults.cooldowns,
      ...(state.control_plane.cooldowns || {}),
    },
    circuits: {
      ...defaults.circuits,
      ...(state.control_plane.circuits || {}),
    },
  };
}

export function appendControlPlaneJournalEvent(
  journalPath: string,
  event: ControlPlaneJournalEvent,
): void {
  appendJsonLine(journalPath, event);
}

export function resolveControlPlaneJournalPath(reportDir: string): string {
  return path.resolve(reportDir, 'operation_journal.jsonl');
}
