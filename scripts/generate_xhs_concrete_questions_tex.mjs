import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const workspace = path.resolve(repoRoot, 'workspaces/xhs-agent-algo-feb2026');
const strictQuestionsPath = path.resolve(workspace, 'interview_data/xhs_questions_strict.json');
const notesPath = path.resolve(workspace, 'interview_data/xhs_scope_notes.json');
const outputDir = path.resolve(repoRoot, 'output/pdf');
const outputTexPath = path.resolve(outputDir, 'xhs-concrete-question-classification-2026-04-05.tex');

/** @typedef {{
 * title?: string;
 * query?: string;
 * seller_flag?: boolean;
 * interview_questions?: string[];
 * }} ScopeNote
 */

/** @typedef {{
 * question?: string;
 * title?: string;
 * query?: string;
 * company?: string;
 * }} QuestionRow
 */

/**
 * @param {string | undefined | null} value
 */
function cleanText(value) {
  return String(value || '')
    .replace(/\[[^\]]*R\]/g, '')
    .replace(/🆕/gu, '')
    .replace(/π/gu, 'pi')
    .replace(/θ/gu, 'theta')
    .replace(/λ/gu, 'lambda')
    .replace(/β/gu, 'beta')
    .replace(/[◆★☆◎●■□△▲▼▽※]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u203C\u2049\u20E3\u2122\u2139\u2190-\u21FF\u231A-\u27BF\u2934-\u2935\u3030\u303D\u3297\u3299\uFE0F]/gu, '')
    .replace(/^\s*[*\-•]+\s*/g, '')
    .replace(/^\s*\d+[-.:：]?\d*\s*[：:]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string | undefined | null} value
 */
function escapeLatex(value) {
  return cleanText(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

/**
 * @param {string} value
 */
function inferCompany(value) {
  const hay = value.toLowerCase();
  const rules = [
    ['Kimi / Moonshot / 月之暗面', [/kimi/i, /moonshot/i, /月之暗面/]],
    ['MiniMax', [/minimax/i]],
    ['智谱', [/智谱/]],
    ['面壁', [/面壁/]],
    ['腾讯', [/腾讯/]],
    ['字节', [/字节/, /抖音/]],
    ['阿里', [/阿里/, /通义/]],
    ['蚂蚁', [/蚂蚁/]],
    ['美团', [/美团/]],
    ['百度', [/百度/]],
    ['京东', [/京东/]],
    ['快手', [/快手/]],
    ['小红书', [/小红书/, /redstar/i]],
    ['米哈游', [/米哈游/]],
  ];
  for (const [label, patterns] of rules) {
    if (patterns.some((pattern) => pattern.test(hay))) return label;
  }
  return '其他';
}

/**
 * @param {string} question
 */
function classifyQuestion(question) {
  const rules = [
    ['对齐 / RLHF / DPO', /(DPO|SFT|RLHF|GRPO|PPO|奖励模型|Reward Hacking|对齐)/i],
    ['推理优化 / KV', /(推理|inference|KV|cache|FlashAttention|MTP|显存|RoPE|YaRN|MLA|长文本|外推|Prefix Caching)/i],
    ['Agent / RAG', /(Agent|智能体|RAG|检索|Rerank|Memory|记忆|工具调用|BM25|上下文工程|父子索引|上下文管理|chunk size|LangGraph)/i],
    ['训练 / 微调 / 分布式', /(LoRA|MoE|ZeRO|分布式|并行|训练数据|微调|Embedding|蒸馏|负样本|对比学习|Instruction)/i],
    ['工程 / 后端', /(Redis|LIKE|索引|并发|限流|数据库|一人一单|超卖|幂等|死锁|事务|消息队列|WebSocket|SpringBoot|ThreadLocal|JWT|ElasticSearch|ELK|Docker|代码沙箱)/i],
    ['算法 / 手撕', /(手撕|leetcode|滑动窗口|中位数|第k|LIS|最长递增子序列|最长无重复子串|字符串|二分查找|矩阵|复杂度|反转链表|大数加法)/i],
  ];
  for (const [label, pattern] of rules) {
    if (pattern.test(question)) return label;
  }
  return '项目 / 开放题';
}

/**
 * @param {string} question
 */
function isGoodQuestion(question) {
  const s = cleanText(question);
  if (!s) return false;
  if (s.length < 8 || s.length > 160) return false;
  if (/(活动|哈哈|点赞|评论|主页|群聊|已过|已拿offer|offer|反问|后续流程|失望|挂了|base|hr)/i.test(s)) return false;
  if (/^(什么时候能实习|什么时候到岗|问实习时长|个人毕设的情况)/.test(s)) return false;
  if (/(攒人品|答成一坨|面试结束|约面|约了)/.test(s)) return false;
  return true;
}

/**
 * @template T
 * @param {T[]} values
 */
function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'));
}

fs.mkdirSync(outputDir, { recursive: true });

/** @type {ScopeNote[]} */
const hasStrictQuestions = fs.existsSync(strictQuestionsPath);
/** @type {QuestionRow[]} */
const strictRows = hasStrictQuestions
  ? JSON.parse(fs.readFileSync(strictQuestionsPath, 'utf8'))
  : [];
/** @type {ScopeNote[]} */
const notes = hasStrictQuestions
  ? []
  : JSON.parse(fs.readFileSync(notesPath, 'utf8'));

const rawItems = [];
if (hasStrictQuestions) {
  for (const row of strictRows) {
    const cleaned = cleanText(row.question || '');
    if (!isGoodQuestion(cleaned)) continue;
    const sourceTitle = cleanText(row.title || '无标题');
    const sourceQuery = cleanText(row.query || '-');
    const company = cleanText(row.company || inferCompany(`${sourceTitle}\n${sourceQuery}`));
    rawItems.push({
      question: cleaned,
      sourceTitle,
      sourceQuery,
      company,
      category: classifyQuestion(cleaned),
    });
  }
} else {
  for (const note of notes) {
    if (note.seller_flag) continue;
    for (const question of note.interview_questions || []) {
      const cleaned = cleanText(question);
      if (!isGoodQuestion(cleaned)) continue;
      const sourceTitle = cleanText(note.title || '无标题');
      const company = inferCompany(`${sourceTitle}\n${cleanText(note.query || '')}`);
      rawItems.push({
        question: cleaned,
        sourceTitle,
        sourceQuery: cleanText(note.query || '-'),
        company,
        category: classifyQuestion(cleaned),
      });
    }
  }
}

const uniqueItems = [...new Map(rawItems.map((item) => [item.question, item])).values()];
const categoryCounts = countBy(uniqueItems.map((item) => item.category));
const companyCounts = countBy(uniqueItems.map((item) => item.company));

const categorySections = categoryCounts
  .map(([category]) => {
    const rows = uniqueItems
      .filter((item) => item.category === category)
      .sort((a, b) => a.company.localeCompare(b.company, 'zh-Hans-CN') || a.question.localeCompare(b.question, 'zh-Hans-CN'));

    const items = rows
      .map((item) => {
        const q = escapeLatex(item.question);
        const source = escapeLatex(`${item.company}｜${item.sourceTitle}`);
        const query = escapeLatex(item.sourceQuery);
        return `  \\item \\textbf{题目：} ${q}\\\\\n  \\textit{来源：} ${source}；query=${query}`;
      })
      .join('\n');

    return `
\\subsection*{${escapeLatex(category)}（${rows.length}）}
\\begin{itemize}
${items}
\\end{itemize}`;
  })
  .join('\n');

const topCompanyLines = companyCounts
  .slice(0, 12)
  .map(([company, count]) => `  \\item ${escapeLatex(company)}：${count} 题`)
  .join('\n');

const categoryLines = categoryCounts
  .map(([category, count]) => `  \\item ${escapeLatex(category)}：${count} 题`)
  .join('\n');

const tex = `\\documentclass[UTF8,a4paper,11pt]{ctexart}

\\usepackage[a4paper,margin=1in]{geometry}
\\usepackage{enumitem}
\\usepackage{hyperref}
\\usepackage{titlesec}

\\hypersetup{
  colorlinks=true,
  linkcolor=blue,
  urlcolor=blue
}

\\setlist[itemize]{leftmargin=1.8em, itemsep=0.28em, topsep=0.3em}
\\titleformat{\\section}{\\large\\bfseries}{}{0em}{}
\\titleformat{\\subsection}{\\normalsize\\bfseries}{}{0em}{}

\\begin{document}
\\sloppy

\\begin{center}
  {\\LARGE \\textbf{具体题目分类总表}}\\\\[0.5em]
  {\\large 从 334 条采集帖中抽出的高质量具体题目}
\\end{center}

\\vspace{0.8em}

\\section*{一、口径}

\\begin{itemize}
  \\item 334 是采集到的帖子数量，不是题目数量。
  \\item 本文档按“题目文本”整理，不再把帖子标题或链接当主体。
  \\item 题目来源：${hasStrictQuestions ? '\\texttt{xhs\\_questions\\_strict.json}（strict 默认题库）' : '\\texttt{xhs\\_scope\\_notes.json} 中非 seller 帖子的 \\texttt{interview\\_questions}'}。
  \\item 过滤后保留 ${uniqueItems.length} 条高质量具体题目。
\\end{itemize}

\\section*{二、按公司分布}

\\begin{itemize}
${topCompanyLines}
\\end{itemize}

\\section*{三、按类别分布}

\\begin{itemize}
${categoryLines}
\\end{itemize}

\\section*{四、题目明细}
\\small
${categorySections}
\\normalsize

\\end{document}
`;

fs.writeFileSync(outputTexPath, tex, 'utf8');
process.stdout.write(`${outputTexPath}\n`);
