import { describe, expect, it } from 'vitest';

import { buildStableOmxEnv } from './omx.js';

describe('buildStableOmxEnv', () => {
  it('clears proxies and disables explore', () => {
    const env = buildStableOmxEnv({
      PATH: '/usr/bin',
      http_proxy: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      USE_OMX_EXPLORE_CMD: '1',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.http_proxy).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.USE_OMX_EXPLORE_CMD).toBe('0');
  });
});
