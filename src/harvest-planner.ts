import type { QueryState, XhsNote, XhsPrdConfig, XhsState } from './types.js';

const SEARCH_TIMEOUT_FLOOR_SECONDS = 75;
const DEFAULT_MAX_QUERIES_PER_HARVEST = 10;
const DEFAULT_QUERY_TIMEOUT_ESCALATION_FACTOR = 2;
const DEFAULT_QUERY_TIMEOUT_MAX_SECONDS = 300;
const DEFAULT_TIMEOUT_QUERY_SLOT_COST = 2;

export type HarvestPlannerConfig = Pick<Required<XhsPrdConfig>, 'queries'> & Partial<Pick<
  Required<XhsPrdConfig>,
  | 'maxQueriesPerHarvest'
  | 'perQueryTimeoutSeconds'
  | 'queryTimeoutEscalationFactor'
  | 'queryTimeoutMaxSeconds'
  | 'timeoutQuerySlotCost'
>>;

export type HarvestQueryPlan = {
  query: string;
  due: boolean;
  nextRunAfter: string | null;
  slotCost: number;
  timeoutSeconds: number;
  priority: number;
};

export function buildHarvestQueryPlans(input: {
  notes: XhsNote[];
  seedNotes?: XhsNote[];
  state: XhsState;
  config: HarvestPlannerConfig;
  queryLimit?: number;
  nowMs?: number;
}): HarvestQueryPlan[] {
  const baseQueries = input.config.queries
    .map((query) => query.trim())
    .filter(Boolean);
  const configuredQueries = new Set(baseQueries);
  const extraCounts = new Map<string, number>();

  for (const note of [...input.notes, ...(input.seedNotes || [])]) {
    const query = String(note.query || '').trim();
    if (!query || configuredQueries.has(query)) {
      continue;
    }
    extraCounts.set(query, (extraCounts.get(query) || 0) + 1);
  }

  const extras = [...extraCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([query]) => query);
  const nowMs = input.nowMs ?? Date.now();
  const plans = [...baseQueries, ...extras].map((query) => {
    const queryState = input.state.queries?.[query];
    const nextRunAfter = String(queryState?.next_run_after || '').trim() || null;
    const nextRunAt = nextRunAfter ? Date.parse(nextRunAfter) : NaN;

    return {
      query,
      due: !nextRunAfter || !Number.isFinite(nextRunAt) || nextRunAt <= nowMs,
      nextRunAfter,
      slotCost: computeQuerySlotCost(queryState, input.config),
      timeoutSeconds: resolveSearchTimeoutSeconds(queryState, input.config),
      priority: computeQueryPriority(queryState),
    };
  });
  const duePlans = plans
    .filter((plan) => plan.due)
    .sort((left, right) =>
      compareQueryPlans(
        left.query,
        left.priority,
        input.state.queries?.[left.query],
        right.query,
        right.priority,
        input.state.queries?.[right.query],
      ),
    );
  const selected: HarvestQueryPlan[] = [];
  let usedSlots = 0;
  const maxQueriesPerHarvest = Math.max(1, Number(input.config.maxQueriesPerHarvest || DEFAULT_MAX_QUERIES_PER_HARVEST));

  for (const plan of duePlans) {
    if (input.queryLimit != null && selected.length >= input.queryLimit) {
      break;
    }
    if (selected.length > 0 && usedSlots + plan.slotCost > maxQueriesPerHarvest) {
      continue;
    }
    selected.push(plan);
    usedSlots += plan.slotCost;
    if (usedSlots >= maxQueriesPerHarvest) {
      break;
    }
  }

  return selected;
}

function resolveSearchTimeoutSeconds(
  queryState: QueryState | undefined,
  config: HarvestPlannerConfig,
): number {
  const timeoutRuns = Math.max(0, Number(queryState?.timeout_runs || 0));
  const factor = Math.max(1, Number(config.queryTimeoutEscalationFactor || DEFAULT_QUERY_TIMEOUT_ESCALATION_FACTOR));
  const base = Math.max(Number(config.perQueryTimeoutSeconds || 0), SEARCH_TIMEOUT_FLOOR_SECONDS);
  const escalated = Math.round(base * Math.pow(factor, timeoutRuns));
  return Math.min(Math.max(base, escalated), Number(config.queryTimeoutMaxSeconds || DEFAULT_QUERY_TIMEOUT_MAX_SECONDS));
}

function computeQuerySlotCost(
  queryState: QueryState | undefined,
  config: HarvestPlannerConfig,
): number {
  const timeoutRuns = Math.max(0, Number(queryState?.timeout_runs || 0));
  if (timeoutRuns <= 0) {
    return 1;
  }
  return Math.max(
    1,
    Math.min(3, Number(config.timeoutQuerySlotCost || DEFAULT_TIMEOUT_QUERY_SLOT_COST) + timeoutRuns - 1),
  );
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
