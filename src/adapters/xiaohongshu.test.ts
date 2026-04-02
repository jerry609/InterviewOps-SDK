import { describe, expect, it, vi } from 'vitest';

import { createSourceAdapter } from './xiaohongshu.js';

describe('createSourceAdapter', () => {
  it('builds the xiaohongshu adapter against the runner surface', () => {
    const runner = {
      search: vi.fn(() => [{ title: 't1' }]),
      comments: vi.fn(() => [{ text: 'q1' }]),
      noteDetail: vi.fn(() => [{ content: 'detail' }]),
    };

    const adapter = createSourceAdapter('xiaohongshu', runner as never);
    expect(adapter.sourceName).toBe('xiaohongshu');
    expect(adapter.search('面经', 3, 30)).toEqual([{ title: 't1' }]);
    expect(adapter.comments('note-id', 5, 15)).toEqual([{ text: 'q1' }]);
    expect(adapter.detail('note-id', 20)).toEqual([{ content: 'detail' }]);
  });
});
