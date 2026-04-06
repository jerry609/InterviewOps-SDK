import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_OPERATION_KINDS,
  createEmptyControlPlaneState,
} from './contracts.js';

describe('control-plane contracts', () => {
  it('creates an empty control-plane state with no active operation', () => {
    const state = createEmptyControlPlaneState();

    expect(CONTROL_PLANE_OPERATION_KINDS).toEqual([
      'harvest',
      'hydrate',
      'comments',
      'normalize',
      'export',
      'validate',
    ]);
    expect(state.scheduler_mode).toBe('polling');
    expect(state.objective).toBe('collect');
    expect(state.active_operation).toBeNull();
    expect(state.cooldowns).toEqual({});
    expect(state.circuits).toEqual({});
    expect(state.backlog_snapshot).toBeNull();
  });
});
