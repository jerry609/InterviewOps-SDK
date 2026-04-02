import { describe, expect, it } from 'vitest';

import { collectStats, detectSellerSignals, extractQuestions, inferTopics, parseCompany, parseRounds, summarizeSellerAuthors } from './heuristics.js';
import type { XhsNote } from './types.js';

describe('heuristics', () => {
  it('extracts questions from mixed interview text', () => {
    const questions = extractQuestions('一面 1. 讲讲 transformer？2. 如何做 rag 优化 3. 项目里为什么这么设计');
    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions.some((item) => item.includes('transformer'))).toBe(true);
  });

  it('detects seller signals conservatively', () => {
    const signal = detectSellerSignals({
      title: '面经整理，滴滴我送简历模板',
      content: '可私信看简历，训练营内推',
      author: '某某求职',
    });
    expect(signal.flag).toBe(true);
    expect(signal.tags).toContain('简历服务');
  });

  it('parses company, rounds and stats', () => {
    expect(parseCompany('腾讯 NLP 一面面经')).toBe('腾讯');
    expect(parseRounds('腾讯 一面 二面 HR面')).toBe('一面 / 二面 / HR面');
    expect(inferTopics('NLP面经', '大模型 面经', '讲讲RAG')).toContain('nlp');

    const notes: XhsNote[] = [
      {
        note_id: '1',
        url: 'u1',
        title: 't1',
        query: 'q1',
        first_seen_at: 'a',
        last_seen_at: 'b',
        crawl_source: 'c',
        content: '正文',
        interview_questions: ['问题'],
        comments: [],
        seller_flag: true,
      },
      {
        note_id: '2',
        url: 'u2',
        title: 't2',
        query: 'q2',
        first_seen_at: 'a',
        last_seen_at: 'b',
        crawl_source: 'c',
      },
    ];

    expect(collectStats(notes)).toEqual({
      notes: 2,
      contentFilled: 1,
      questionsFilled: 1,
      commentsEnriched: 1,
      sellerFlagged: 1,
    });

    expect(summarizeSellerAuthors(notes)).toEqual([
      {
        author: '未知作者',
        note_count: 2,
        seller_note_count: 1,
        seller_tags: [],
        max_confidence: 0,
        note_ids: ['1', '2'],
        titles: ['t1', 't2'],
      },
    ]);
  });
});
