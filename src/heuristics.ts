import type { PurchaseLinkSignal, ScopeCandidate, SellerAuthorSummary, SellerSignal, SellerWhitelistConfig, SellerWhitelistDecision, XhsNote, XhsQuestionRow, XhsStats } from './types.js';

const COMPANY_NAMES = [
  '腾讯', '字节', '美团', '阿里', '阿里云', '通义', '蚂蚁', '京东', '百度', '快手',
  'MiniMax', 'Minimax', '面壁', '智谱', '平安', '宇树', '高德', '小红书', '豆包', 'Qwen', 'qwen',
];

const TOPIC_RULES: Record<string, string[]> = {
  nlp: ['nlp', '文本', '语言', 'bert', 'rag', 'agent', '大模型', 'llm'],
  backend: ['后端', 'java', 'redis', 'mysql', 'mq', '缓存', '数据库', 'spring'],
  algo: ['算法', '推荐', '召回', '精排', '排序', 'auc', 'gauc', 'mmr', 'rlhf'],
};

const SELLER_PATTERNS = [
  { tag: '简历服务', regex: /简历|看简历|改简历|简历辅导|简历投递|投递助手/gi, weight: 0.45 },
  { tag: '导流转化', regex: /滴滴我|私信|私聊|加v|vx|v我|内推|offer大楼|咨询/gi, weight: 0.35 },
  { tag: '卖课训练营', regex: /训练营|课程|社群|陪跑|求职服务|一对一/gi, weight: 0.4 },
];

const PURCHASE_DOMAIN_PATTERNS = [
  /https?:\/\/(?:e\.)?tb\.cn\/[^\s]+/gi,
  /https?:\/\/(?:item|detail)\.(?:taobao|tmall)\.com\/[^\s]+/gi,
  /https?:\/\/(?:u\.)?jd\.com\/[^\s]+/gi,
  /https?:\/\/(?:item\.)?jd\.com\/[^\s]+/gi,
  /https?:\/\/(?:mobile\.)?yangkeduo\.com\/[^\s]+/gi,
  /https?:\/\/(?:weidian\.com|koudai\.com)\/[^\s]+/gi,
  /https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:goods-detail|store|shop|discovery\/item)\/[^\s]+/gi,
];

const PURCHASE_TEXT_PATTERNS = [
  { tag: '购买链接', regex: /购买链接|商品链接|下单链接|店铺链接|拍下链接/gi, weight: 0.45 },
  { tag: '电商平台', regex: /淘宝|天猫|京东|拼多多|微店/gi, weight: 0.25 },
  { tag: '站内导购', regex: /橱窗|小黄车|店铺首页|商品卡|立即购买/gi, weight: 0.25 },
];

export function nowIsoUtc8(): string {
  const now = new Date(Date.now() + 8 * 3600_000);
  return now.toISOString().replace('Z', '+08:00');
}

export function extractNoteId(input: string): string {
  const match = String(input || '').match(/\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i);
  return match ? match[1] : String(input || '').trim();
}

export function noteIdToDate(input: string): string {
  const noteId = extractNoteId(input);
  if (!/^[0-9a-f]{24}$/i.test(noteId)) return '';
  const ts = parseInt(noteId.slice(0, 8), 16);
  if (!Number.isFinite(ts) || ts < 1_000_000_000 || ts > 4_000_000_000) return '';
  return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

export function parseApproxPublishedAt(value: string, reference = new Date()): Date | null {
  const text = String(value || '').trim();
  if (!text) return null;
  let match = text.match(/^(\d+)小时前/);
  if (match) {
    return new Date(reference.getTime() - Number(match[1]) * 3600_000);
  }
  match = text.match(/^(\d+)天前/);
  if (match) {
    return new Date(reference.getTime() - Number(match[1]) * 24 * 3600_000);
  }
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`);
  }
  return null;
}

export function normalizeQuestion(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^Q[:：]\s*/i, '')
    .replace(/^\d+[、.](?!\d)\s*/, '')
    .replace(/^[0-9]️⃣\s*/, '')
    .trim();
}

function splitQuestionCandidates(line: string): string[] {
  if (/[？?]/.test(line)) {
    return line
      .split(/[？?]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (/[？?]$/.test(part) ? part : `${part}`));
  }

  const splitKeys = ['系统介绍一下', '详细讲讲', '什么是', '为什么', '有没有', '说一下', '讲讲', '如何', '怎么', '什么', '哪些', '是否', '如果', '若要'];
  const pattern = new RegExp(`(?=(${splitKeys.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g');
  return line.split(pattern).map((part) => part.trim()).filter(Boolean);
}

export function extractQuestions(text: string): string[] {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/Q[:：]\s*/g, '\nQ: ')
    .replace(/(?<!\d)(\d+[、.](?!\d)\s*)/g, '\n$1')
    .replace(/([0-9])\ufe0f?\u20e3/g, '\n$1️⃣ ')
    .replace(/(一面|二面|三面|四面|五面|HR面|hr面|终面)\s*/g, '\n$1 ');

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    if (
      line.length < 6 ||
      line.includes('编辑于') ||
      line.includes('#') ||
      /^\d+\.\d/.test(line) ||
      /^\d{4}-\d{2}-\d{2}/.test(line) ||
      /^\d+[小时天]前/.test(line) ||
      /^(昨天|今天|前天)$/.test(line) ||
      /^(一面|二面|三面|四面|五面|HR面|hr面|终面)$/.test(line)
    ) {
      continue;
    }

    for (const candidate of splitQuestionCandidates(line)) {
      const value = normalizeQuestion(candidate);
      const looksLikeQuestion =
        value.startsWith('问') ||
        value.includes('面试官问') ||
        value.includes('八股') ||
        value.includes('算法题') ||
        value.includes('讲讲') ||
        value.includes('说一下') ||
        value.includes('如何') ||
        value.includes('怎么') ||
        value.includes('为什么') ||
        value.includes('什么') ||
        value.includes('是否') ||
        value.includes('有没有') ||
        /[？?]/.test(value);

      if (looksLikeQuestion && value.length >= 6 && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }

  return out;
}

export function parseCompany(text: string): string {
  for (const company of COMPANY_NAMES) {
    if (text.includes(company)) {
      return company;
    }
  }
  return '';
}

export function parseRounds(text: string): string {
  const matches = text.match(/(?:一面|二面|三面|四面|五面|HR面|hr面|终面)/g) ?? [];
  return [...new Set(matches)].join(' / ');
}

export function inferTopics(title: string, query: string, question: string): string[] {
  const haystack = `${title} ${query} ${question}`.toLowerCase();
  const topics = Object.entries(TOPIC_RULES)
    .filter(([, keywords]) => keywords.some((keyword) => haystack.includes(keyword.toLowerCase())))
    .map(([topic]) => topic);
  return topics.length > 0 ? topics : ['algo'];
}

export function detectSellerSignals(note: Pick<XhsNote, 'title' | 'content' | 'author'>): SellerSignal {
  const haystack = `${note.title || ''}\n${note.content || ''}\n${note.author || ''}`;
  const tags: string[] = [];
  let confidence = 0;

  for (const rule of SELLER_PATTERNS) {
    if (rule.regex.test(haystack)) {
      tags.push(rule.tag);
      confidence += rule.weight;
    }
    rule.regex.lastIndex = 0;
  }

  confidence = Math.min(0.99, Number(confidence.toFixed(2)));
  return {
    flag: confidence >= 0.45,
    tags: [...new Set(tags)],
    confidence,
  };
}

export function applySellerWhitelist(
  note: Pick<XhsNote, 'note_id' | 'author' | 'title' | 'url'>,
  whitelist?: SellerWhitelistConfig,
): SellerWhitelistDecision {
  if (!whitelist) {
    return { whitelisted: false, reason: '' };
  }

  const author = String(note.author || '').trim();
  const noteId = String(note.note_id || '').trim();
  const title = String(note.title || '').trim();
  const url = String(note.url || '').trim();

  if ((whitelist.note_ids || []).includes(noteId)) {
    return { whitelisted: true, reason: `note_id:${noteId}` };
  }
  if (author && (whitelist.authors || []).includes(author)) {
    return { whitelisted: true, reason: `author:${author}` };
  }
  for (const keyword of whitelist.title_keywords || []) {
    if (keyword && title.includes(keyword)) {
      return { whitelisted: true, reason: `title_keyword:${keyword}` };
    }
  }
  for (const keyword of whitelist.urls || []) {
    if (keyword && url.includes(keyword)) {
      return { whitelisted: true, reason: `url:${keyword}` };
    }
  }
  return { whitelisted: false, reason: '' };
}

export function detectPurchaseLinks(note: Pick<XhsNote, 'title' | 'content' | 'comments'>): PurchaseLinkSignal {
  const parts = [
    String(note.title || ''),
    String(note.content || ''),
    ...(note.comments || []).map((item) => String(item.content || '')),
  ];
  const haystack = parts.join('\n');
  const links = new Set<string>();
  const tags = new Set<string>();
  let confidence = 0;

  for (const pattern of PURCHASE_DOMAIN_PATTERNS) {
    const matches = haystack.match(pattern) || [];
    for (const match of matches) {
      links.add(match.trim());
    }
  }

  if (links.size > 0) {
    tags.add('购买链接');
    confidence += 0.6;
  }

  for (const rule of PURCHASE_TEXT_PATTERNS) {
    if (rule.regex.test(haystack)) {
      tags.add(rule.tag);
      confidence += rule.weight;
    }
    rule.regex.lastIndex = 0;
  }

  confidence = Math.min(0.99, Number(confidence.toFixed(2)));
  return {
    flag: links.size > 0 || confidence >= 0.45,
    links: [...links],
    tags: [...tags],
    confidence,
  };
}

export function collectStats(notes: XhsNote[]): XhsStats {
  return {
    notes: notes.length,
    contentFilled: notes.filter((note) => Boolean(String(note.content || '').trim())).length,
    questionsFilled: notes.filter((note) => (note.interview_questions || []).length > 0).length,
    commentsEnriched: notes.filter((note) => note.comments != null).length,
    sellerFlagged: notes.filter((note) => Boolean(note.seller_flag)).length,
    sellerWhitelisted: notes.filter((note) => Boolean(note.seller_whitelisted)).length,
    purchaseLinkFlagged: notes.filter((note) => Boolean(note.purchase_link_flag)).length,
  };
}

export function questionRowKey(row: XhsQuestionRow): string {
  return `${row.note_id}::${row.question}`;
}

export function summarizeSellerAuthors(notes: XhsNote[]): SellerAuthorSummary[] {
  const byAuthor = new Map<string, SellerAuthorSummary>();

  for (const note of notes) {
    const author = String(note.author || '').trim() || '未知作者';
    const current = byAuthor.get(author) || {
      author,
      note_count: 0,
      seller_note_count: 0,
      seller_tags: [],
      max_confidence: 0,
      note_ids: [],
      titles: [],
    };

    current.note_count += 1;
    current.note_ids.push(note.note_id);
    current.titles.push(note.title);
    if (note.seller_flag) {
      current.seller_note_count += 1;
      current.max_confidence = Math.max(current.max_confidence, Number(note.seller_confidence || 0));
      current.seller_tags = [...new Set([...current.seller_tags, ...(note.seller_tags || [])])];
    }
    byAuthor.set(author, current);
  }

  return [...byAuthor.values()]
    .filter((item) => item.seller_note_count > 0)
    .sort((a, b) => b.seller_note_count - a.seller_note_count || b.max_confidence - a.max_confidence || a.author.localeCompare(b.author));
}

export function buildScopeCandidates(
  notes: XhsNote[],
  filter: {
    since?: string;
    companies?: string[];
    agentKeywords?: string[];
    algoKeywords?: string[];
    excludeTitleKeywords?: string[];
  },
  reference = new Date(),
): ScopeCandidate[] {
  const since = filter.since ? new Date(`${filter.since}T00:00:00+08:00`) : null;
  const companies = filter.companies || [];
  const agentKeywords = filter.agentKeywords || [];
  const algoKeywords = filter.algoKeywords || [];
  const excludeTitleKeywords = filter.excludeTitleKeywords || [];

  const rows: ScopeCandidate[] = [];
  for (const note of notes) {
    const title = String(note.title || '');
    const content = String(note.content || '');
    const query = String(note.query || '');
    const combined = `${title}\n${content}\n${query}`;
    const company = companies.find((item) => combined.includes(item)) || '';
    if (!company) continue;

    if (excludeTitleKeywords.some((item) => item && title.includes(item))) {
      continue;
    }

    const published = parseApproxPublishedAt(String(note.published_at || ''), reference);
    if (!published) continue;
    if (since && published < since) continue;

    const agentInText = agentKeywords.some((item) => combined.toLowerCase().includes(item.toLowerCase()));
    const algoInText = algoKeywords.some((item) => combined.toLowerCase().includes(item.toLowerCase()));
    if (!agentInText || !algoInText) continue;

    const reasons: string[] = [];
    let score = 0;
    if (title.includes(company)) {
      score += 2;
      reasons.push('company:title');
    } else {
      score += 1;
      reasons.push('company:body');
    }
    if (agentKeywords.some((item) => title.toLowerCase().includes(item.toLowerCase()))) {
      score += 2;
      reasons.push('agent:title');
    } else {
      score += 1;
      reasons.push('agent:body');
    }
    if (algoKeywords.some((item) => title.toLowerCase().includes(item.toLowerCase()))) {
      score += 2;
      reasons.push('algo:title');
    } else {
      score += 1;
      reasons.push('algo:body');
    }

    const strength = score >= 6 ? 'strong' : 'medium';
    rows.push({
      note_id: note.note_id,
      title,
      company,
      published_at: note.published_at,
      query,
      author: note.author || null,
      url: note.url,
      strength,
      match_reasons: reasons,
      seller_flag: Boolean(note.seller_flag),
      purchase_link_flag: Boolean(note.purchase_link_flag),
    });
  }

  return rows.sort((left, right) => {
    if (left.strength !== right.strength) {
      return left.strength === 'strong' ? -1 : 1;
    }
    return `${left.company} ${left.published_at || ''} ${left.title}`.localeCompare(
      `${right.company} ${right.published_at || ''} ${right.title}`,
    );
  });
}
