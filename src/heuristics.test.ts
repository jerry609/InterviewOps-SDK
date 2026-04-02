import { describe, expect, it } from 'vitest';

import { applySellerWhitelist, buildScopeCandidates, collectStats, detectPurchaseLinks, detectSellerSignals, extractQuestions, inferTopics, parseApproxPublishedAt, parseCompany, parseRounds, summarizeSellerAuthors } from './heuristics.js';
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

  it('applies seller whitelist and detects purchase links', () => {
    expect(applySellerWhitelist(
      {
        note_id: 'note-1',
        author: '白名单作者',
        title: '普通面经',
        url: 'https://www.xiaohongshu.com/explore/abc',
      },
      { authors: ['白名单作者'] },
    )).toEqual({
      whitelisted: true,
      reason: 'author:白名单作者',
    });

    const purchase = detectPurchaseLinks({
      title: '课程笔记',
      content: '购买链接在这里 https://e.tb.cn/demo 也可以看店铺链接',
      comments: [],
    });
    expect(purchase.flag).toBe(true);
    expect(purchase.links.some((item) => item.includes('tb.cn'))).toBe(true);
    expect(purchase.tags).toContain('购买链接');
  });

  it('builds scoped candidates for agent/llm algo notes', () => {
    const rows = buildScopeCandidates(
      [
        {
          note_id: '1',
          url: 'https://example.com/1',
          title: '腾讯 Agent 算法面经',
          query: 'Agent 面经',
          first_seen_at: 'a',
          last_seen_at: 'b',
          crawl_source: 'c',
          content: '智能体 算法 问题记录',
          published_at: '2026-03-12',
        },
        {
          note_id: '2',
          url: 'https://example.com/2',
          title: '腾讯 后端面经',
          query: '面经',
          first_seen_at: 'a',
          last_seen_at: 'b',
          crawl_source: 'c',
          content: '后端 java',
          published_at: '2026-03-12',
        },
      ],
      {
        since: '2026-02-01',
        companies: ['腾讯'],
        agentKeywords: ['agent', '智能体', 'llm'],
        algoKeywords: ['算法', 'nlp'],
        excludeTitleKeywords: ['后端', '前端'],
      },
      new Date('2026-04-02T14:23:01+08:00'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].note_id).toBe('1');
    expect(parseApproxPublishedAt('3天前广东', new Date('2026-04-02T14:23:01+08:00'))).not.toBeNull();
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
      sellerWhitelisted: 0,
      purchaseLinkFlagged: 0,
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
