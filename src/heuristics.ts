import type { SellerAuthorSummary, SellerSignal, XhsNote, XhsQuestionRow, XhsStats } from './types.js';

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

export function collectStats(notes: XhsNote[]): XhsStats {
  return {
    notes: notes.length,
    contentFilled: notes.filter((note) => Boolean(String(note.content || '').trim())).length,
    questionsFilled: notes.filter((note) => (note.interview_questions || []).length > 0).length,
    commentsEnriched: notes.filter((note) => note.comments != null).length,
    sellerFlagged: notes.filter((note) => Boolean(note.seller_flag)).length,
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
