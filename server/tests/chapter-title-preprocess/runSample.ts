/**
 * 通用样本测试脚本 v3 (泛化改进版)
 * 
 * 用法: npx tsx server/tests/chapter-title-preprocess/runSample.ts <sample_json_path>
 * 
 * 改进:
 * 1. 移除 part_en 模式（噪声过高）
 * 2. 修复 isTocEntry 的长度豁免导致目录页条目泄漏
 * 3. 收紧后处理补漏：仅补入确定性极高的条目
 * 4. 改进候选集过滤：频率去噪
 * 5. 改进 Prompt：更明确的排除规则
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import axiosRetry from 'axios-retry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= 通用 block 展平 =============

interface RawBlock {
  id?: number;
  type?: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  blocks?: RawBlock[];
  [key: string]: any;
}

interface FlatBlock {
  id: number;
  type: string;
  text: string;
  text_level: number | null;
  page_idx: number;
  original: RawBlock;
}

function flattenContentList(data: any): FlatBlock[] {
  const items: RawBlock[] = Array.isArray(data) ? data : (data.content_list || data.items || []);
  const blocks: FlatBlock[] = [];
  let globalId = 0;

  for (const item of items) {
    if (item.blocks && Array.isArray(item.blocks)) {
      for (const b of item.blocks) {
        blocks.push({
          id: globalId++,
          type: b.type || 'text',
          text: (b.text || '').trim(),
          text_level: b.text_level ?? null,
          page_idx: b.page_idx ?? item.page_idx ?? -1,
          original: b,
        });
      }
    } else {
      blocks.push({
        id: globalId++,
        type: item.type || 'text',
        text: (item.text || '').trim(),
        text_level: item.text_level ?? null,
        page_idx: item.page_idx ?? -1,
        original: item,
      });
    }
  }

  return blocks;
}

// ============= 通用标题候选集构建（泛化 v3） =============

interface TitleCandidate {
  id: number;
  text: string;
  type: string;
  text_level: number | null;
  page_idx: number;
  signals: string[];
  merged_from?: number[];
}

/**
 * 通用正则模式库 v3
 * 
 * 改进: 移除了 part_en（"Part A/B/C" 在教育文本中几乎都是题型标签）
 * 改进: 收紧 review_en 避免匹配 "Practice" 等高频词
 */
const TITLE_PATTERNS: { name: string; regex: RegExp; description: string }[] = [
  // === 中文模式 ===
  { name: 'chapter_cn', regex: /^第[一二三四五六七八九十百千\d]+(?:章|篇|部(?!分))/, description: '中文章/篇/部（排除"第X部分"）' },
  { name: 'section_cn', regex: /^第[一二三四五六七八九十百千\d]+[节课]/, description: '中文节/课' },
  { name: 'lesson_cn', regex: /^第[一二三四五六七八九十百千\d]+课时/, description: '中文课时' },
  { name: 'unit_cn', regex: /^第[一二三四五六七八九十百千\d]+单元/, description: '中文单元' },
  { name: 'module_cn', regex: /^模块[一二三四五六七八九十\d]+/, description: '中文模块' },
  
  // === 数字编号模式 ===
  { name: 'section_dotnum', regex: /^\d+\.\d+\s+\S/, description: '数字编号节 X.Y 标题' },
  { name: 'subsection_dotnum', regex: /^\d+\.\d+[\(（][一二三四五六七八九十\d]+[\)）]/, description: '数字编号子节 X.Y(Z)' },
  
  // === 英文模式 ===
  { name: 'chapter_en', regex: /^Chapter\s+\d+/i, description: '英文 Chapter' },
  { name: 'unit_en', regex: /^Unit\s+\d+/i, description: '英文 Unit' },
  { name: 'topic_en', regex: /^TOPIC\s+\d+/, description: '英文 TOPIC（全大写）' },
  { name: 'lesson_en', regex: /^Lesson\s+\d+/i, description: '英文 Lesson' },
  { name: 'module_en', regex: /^Module\s+\d+/i, description: '英文 Module' },
  { name: 'section_en', regex: /^Section\s+\d+/i, description: '英文 Section' },
  
  // === 中文功能性标题模式 ===
  { name: 'exercise_section', regex: /^(阶段训练|单元测试|综合测试|期中测试|期末测试|模拟测试|专题训练|测试卷|检测卷|练习卷)/, description: '中文练习/测试标题' },
  { name: 'review_section', regex: /^(本章复习|本单元复习|总复习|复习题|复习与测试|回顾与思考|整理与复习)/, description: '中文复习标题' },
  { name: 'exam_paper', regex: /^(期末测试卷|期中测试卷|模拟试卷|综合测试卷|检测卷)/, description: '中文试卷标题' },
  { name: 'unit_review_cn', regex: /^第[一二三四五六七八九十百千\d]+单元(综合练习|知识梳理|测试)/, description: '中文单元综合练习' },
  
  // === 英文功能性标题（仅高置信度模式） ===
  { name: 'summary_en', regex: /^SUMMARY\s+OF\s+(UNIT|CHAPTER|TOPIC)/i, description: '英文 Summary of Unit/Chapter' },
  { name: 'appendix_en', regex: /^(APPENDIX\s+[A-Z]|GLOSSARY|INDEX)\b/i, description: '英文附录/术语表/索引' },
];

/**
 * 目录页检测 v3：文本末尾带 2-3 位页码的条目很可能是目录页内容
 * 改进：移除了长度豁免，所有末尾带页码的条目都被标记
 */
function isTocEntry(text: string): boolean {
  // 匹配末尾的 2-3 位数字（可能有空格），但排除 "X.Y 标题" 这种编号开头的情况
  if (/\s+\d{2,3}\s*$/.test(text)) {
    // 如果文本本身就是一个数字编号标题（如 "19.1 平方根"），不应被过滤
    if (/^\d+\.\d+\s/.test(text)) return false;
    return true;
  }
  return false;
}

/**
 * 检测是否为重复出现的教学环节标签（高频噪声）
 */
function isPedagogicalLabel(text: string): boolean {
  const labels = [
    // 中文
    /^(要点归纳|疑难分析|基础训练|拓展训练|课堂练习|课后练习|课前预习|知识链接|学习目标|教学目标|思考与讨论|探究活动|实验|活动|想一想|做一做|练一练|试一试|读一读|议一议)\b/,
    // 英文
    /^(EXERCISE|PRACTICE|HOMEWORK|ACTIVITY|WARM[- ]?UP|DO NOW|TRY IT|CHECK|EXPLORE|INVESTIGATE|THINK ABOUT|KEY ?POINT|TASK TIP|FURTHER PRACTICE|WRITING TIP|READING TIP)\b/i,
  ];
  return labels.some(r => r.test(text.trim()));
}

function buildTitleCandidates(blocks: FlatBlock[]): TitleCandidate[] {
  const candidates: TitleCandidate[] = [];

  for (const block of blocks) {
    if (!block.text || block.text.length === 0) continue;
    if (block.type === 'footer' || block.type === 'page_number' || block.type === 'page_footnote') continue;
    
    // 排除明确的教学环节标签
    if (isPedagogicalLabel(block.text)) continue;

    const signals: string[] = [];

    // 信号 1: type=header
    if (block.type === 'header') {
      signals.push('type:header');
    }

    // 信号 2: text_level=1
    if (block.text_level === 1) {
      signals.push('text_level:1');
    }

    // 信号 3: 正则模式匹配
    for (const pattern of TITLE_PATTERNS) {
      if (pattern.regex.test(block.text)) {
        signals.push(`pattern:${pattern.name}`);
      }
    }

    // 至少命中一个信号才纳入候选
    if (signals.length > 0) {
      // 过滤目录页条目（文本末尾带页码）
      if (isTocEntry(block.text)) continue;

      candidates.push({
        id: block.id,
        text: block.text,
        type: block.type,
        text_level: block.text_level,
        page_idx: block.page_idx,
        signals,
      });
    }
  }

  return candidates;
}

// ============= 候选集智能过滤 =============

/**
 * 对候选集进行智能过滤，确保不超过 LLM 的处理能力
 * 
 * 策略：
 * 1. 多信号命中的候选始终保留
 * 2. 单信号候选按优先级排序：pattern > type:header > text_level:1
 * 3. 如果某个 pattern 出现次数过多（>30），说明它匹配了噪声，降权处理
 */
function filterCandidates(candidates: TitleCandidate[], maxCount: number = 300): TitleCandidate[] {
  if (candidates.length <= maxCount) return candidates;

  // 统计每个 pattern 的出现次数
  const patternCounts: Record<string, number> = {};
  for (const c of candidates) {
    for (const s of c.signals) {
      if (s.startsWith('pattern:')) {
        patternCounts[s] = (patternCounts[s] || 0) + 1;
      }
    }
  }

  // 识别高频噪声 pattern（出现次数 > 30 且没有其他信号支持的）
  const noisyPatterns = new Set<string>();
  for (const [pattern, count] of Object.entries(patternCounts)) {
    if (count > 30) {
      noisyPatterns.add(pattern);
    }
  }

  if (noisyPatterns.size > 0) {
    console.log(`  ⚠️ 检测到高频模式（可能是噪声）: ${[...noisyPatterns].join(', ')}`);
  }

  // 分层过滤
  const tier1: TitleCandidate[] = []; // 多信号命中（始终保留）
  const tier2: TitleCandidate[] = []; // 非噪声 pattern 命中
  const tier3: TitleCandidate[] = []; // type:header 或 text_level:1（单信号）
  const tier4: TitleCandidate[] = []; // 噪声 pattern 单独命中

  for (const c of candidates) {
    const hasMultipleSignals = c.signals.length >= 2;
    const hasNonNoisyPattern = c.signals.some(s => s.startsWith('pattern:') && !noisyPatterns.has(s));
    const hasOnlyNoisyPattern = c.signals.every(s => !s.startsWith('pattern:') || noisyPatterns.has(s));

    if (hasMultipleSignals) {
      tier1.push(c);
    } else if (hasNonNoisyPattern) {
      tier2.push(c);
    } else if (c.signals.some(s => s === 'type:header' || s === 'text_level:1') && hasOnlyNoisyPattern) {
      tier3.push(c);
    } else {
      tier4.push(c);
    }
  }

  let result = [...tier1, ...tier2];
  if (result.length < maxCount) {
    const remaining = maxCount - result.length;
    // 均匀采样而非截取前 N 个，确保大文档后半部分的标题不会被丢弃
    if (tier3.length <= remaining) {
      result.push(...tier3);
    } else {
      const step = tier3.length / remaining;
      for (let i = 0; i < remaining; i++) {
        result.push(tier3[Math.floor(i * step)]);
      }
    }
  }
  if (result.length < maxCount) {
    const remaining = maxCount - result.length;
    if (tier4.length <= remaining) {
      result.push(...tier4);
    } else {
      const step = tier4.length / remaining;
      for (let i = 0; i < remaining; i++) {
        result.push(tier4[Math.floor(i * step)]);
      }
    }
  }

  // 按 page_idx 排序
  result.sort((a, b) => a.page_idx - b.page_idx || a.id - b.id);

  console.log(`  ⚠️ 候选数过多 (${candidates.length})，分层过滤后: ${result.length}`);
  console.log(`    Tier 1 (多信号): ${tier1.length}`);
  console.log(`    Tier 2 (非噪声 pattern): ${tier2.length}`);
  console.log(`    Tier 3 (header/text_level): ${tier3.length}`);
  console.log(`    Tier 4 (噪声 pattern): ${tier4.length}`);

  return result;
}

// ============= 通用 Prompt 设计（泛化 v3） =============

function buildRevisionPrompt(candidates: TitleCandidate[], totalBlocks: number, totalPages: number): string {
  const candidateLines = candidates.map(c => {
    const signals = c.signals.join(', ');
    const merged = c.merged_from ? `, "merged_from": [${c.merged_from.join(',')}]` : '';
    return `  {"id": ${c.id}, "page": ${c.page_idx}, "type": "${c.type}", "text_level": ${c.text_level ?? 'null'}, "signals": "${signals}"${merged}, "text": ${JSON.stringify(c.text)}}`;
  }).join(',\n');

  return `You are an expert in analyzing educational textbook structures. Your task is to identify the real chapter/section titles from the "title candidate list" below and build an accurate, multi-level table of contents (TOC) tree.

## Input Description

Below is a list of "title candidates" extracted from an educational textbook (parsed from PDF via OCR). The document has ${totalBlocks} text blocks across ${totalPages} pages. Each candidate contains:
- **id**: Global unique ID of the original text block (DO NOT modify)
- **page**: Page number (0-indexed)
- **type**: OCR tool's type annotation (header or text)
- **text_level**: Font-size-based level inferred by OCR (1 = large font title; null = not annotated)
- **signals**: Pre-screening signals from code
- **text**: Text content

## Your Task

### Step 1: Understand the document's organizational structure

First, scan all candidates to understand the document's hierarchy. Common patterns include:
- "Chapter > Section > Subsection" (e.g., "第19章 > 19.1 > 19.1(一)")
- "Unit > Lesson" (e.g., "Unit 1 > Lesson 1-1")
- "Topic > Lesson" (e.g., "TOPIC 3 > Lesson 3-1")
- "Part > Unit > Section" (e.g., "Part 1 > Unit 1 > 1.1")
- Flat structure with only topic-level titles (e.g., "Personal Pronouns", "Future Tense")

### Step 2: Identify real structural titles

**KEEP** items that define the document's organizational structure:
- Top-level divisions (chapters, parts, units, topics, modules)
- Second-level divisions (sections, lessons, numbered subsections)
- Third-level divisions (sub-sections)
- Functional sections with unique identifiers (e.g., "阶段训练①", "本章复习题(一)", "SUMMARY OF UNIT 8", "TOPIC 3 Assessment Practice")

**EXCLUDE** all of the following:
- Table of contents page entries (typically in the first few pages, listing titles with page numbers)
- Repeated pedagogical labels that appear in EVERY unit/chapter with the same text (e.g., "REVIEW", "Practice", "Part 1 Editing Advice", "Part 2 Editing Practice", "Part 3 Write", "Part 4 Learner's Log")
- Question type headers (e.g., "Part A", "Part B", "一、填空题")
- Exercise instructions or activity labels
- Page headers/footers

**Critical distinction**: If a label like "REVIEW" or "PART 1 Editing Advice" appears in EVERY unit with the exact same text, it is a repeated pedagogical label and should be EXCLUDED. But if "TOPIC 3 Assessment Practice" appears only once (unique to Topic 3), it should be KEPT.

### Step 3: Assign levels

- **level 1**: Top-level structural divisions
- **level 2**: Second-level divisions within level 1
- **level 3**: Third-level divisions within level 2

### Step 4: Build tree

- level 1 nodes are top-level
- level 2 nodes are children of the nearest preceding level 1
- level 3 nodes are children of the nearest preceding level 2
- Order strictly by page number

## Important Notes

- OCR may misrecognize characters (e.g., circled numbers ⑤ → 5)
- **DO NOT create titles that don't exist in the candidate list**
- **DO NOT include any item that is clearly a repeated template label**
- The document may be in any language

## Output Format

Output ONLY valid JSON, no markdown fences:

{
  "document_title": "Document title or N/A",
  "document_language": "zh-CN or en-US or other",
  "chapters": [
    {
      "id": 129,
      "text": "Title text",
      "level": 1,
      "page": 9,
      "children": [
        {
          "id": 110,
          "text": "Section title",
          "level": 2,
          "page": 9,
          "children": []
        }
      ]
    }
  ],
  "excluded_count": 123,
  "notes": "Brief notes about structure decisions"
}

## Title Candidate List

[
${candidateLines}
]

Analyze the candidates and output the JSON result.`;
}

// ============= LLM 调用 =============

interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  timeout?: number;
}

async function callLLM(prompt: string, config: LLMConfig): Promise<string> {
  const base = config.apiUrl.replace(/\/+$/, '');
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const client = axios.create({
    timeout: config.timeout || 300000,
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
      return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        (error.response?.status ? error.response.status >= 500 : false);
    },
  });

  const response = await client.post(endpoint, {
    model: config.modelName,
    messages: [
      {
        role: 'system',
        content: 'You are an expert in analyzing educational textbook structures. You always respond with valid JSON only, no markdown fences or extra text.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.05,
    max_tokens: 16000,
  });

  return response.data.choices[0].message.content;
}

// ============= 结果解析 =============

function parseLLMResponse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {}

  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {}
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(raw.substring(start, end + 1));
    } catch {}
  }

  throw new Error(`无法解析 LLM 输出为 JSON: ${raw.substring(0, 200)}...`);
}

// ============= 扁平化目录树 =============

interface ChapterMapEntry {
  id: number;
  text: string;
  level: number;
  page_idx: number;
  full_path: string;
  parent_id?: number;
}

function flattenTree(chapters: any[], parentPath: string = '', parentId?: number): ChapterMapEntry[] {
  const result: ChapterMapEntry[] = [];

  for (const ch of chapters) {
    const fullPath = parentPath ? `${parentPath} > ${ch.text}` : ch.text;
    result.push({
      id: ch.id,
      text: ch.text,
      level: ch.level,
      page_idx: ch.page ?? ch.page_idx ?? -1,
      full_path: fullPath,
      parent_id: parentId,
    });

    if (ch.children && ch.children.length > 0) {
      result.push(...flattenTree(ch.children, fullPath, ch.id));
    }
  }

  return result;
}

// ============= 后处理：保守补漏 v3 =============

/**
 * 保守补漏策略 v3
 * 
 * 只补入"确定性极高"的条目：
 * 1. 中文功能性标题（阶段训练、本章复习题、期末测试卷等）+ text_level:1
 * 2. 中文章/单元标题（第X章、第X单元）+ text_level:1
 * 
 * 不补入：
 * - 英文模式（Lesson、Part 等在英文教材中噪声太高）
 * - 纯 text_level:1 + type:header（太宽泛）
 */
const HIGH_CONFIDENCE_PATTERNS = new Set([
  'pattern:chapter_cn',
  'pattern:section_cn', 
  'pattern:lesson_cn',
  'pattern:unit_cn',
  'pattern:module_cn',
  'pattern:exercise_section',
  'pattern:review_section',
  'pattern:exam_paper',
  'pattern:unit_review_cn',
  // 注意：section_dotnum 不纳入（正文中 "2.1 美元兑换多少元" 会误匹配）
  // 注意：topic_en 不纳入（大文档中目录页条目会泄漏）
  // 英文高置信度（仅 Chapter/Unit 级别）
  'pattern:chapter_en',
  'pattern:unit_en',
]);

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, m => {
      const map: Record<string, string> = {'①':'1','②':'2','③':'3','④':'4','⑤':'5','⑥':'6','⑦':'7','⑧':'8','⑨':'9','⑩':'10'};
      return map[m] || m;
    })
    .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
    .toLowerCase();
}

function backfillMissedEntries(
  flatMap: ChapterMapEntry[],
  candidates: TitleCandidate[],
  chapters: any[],
  totalPages: number
): { flatMap: ChapterMapEntry[]; chapters: any[] } {
  // 目录页区域：前 5% 的页面（通常是目录页）
  const tocPageThreshold = Math.max(3, Math.floor(totalPages * 0.05));

  // 识别强信号条目：text_level:1 + 高置信度 pattern
  const strongCandidates = candidates.filter(c =>
    c.signals.includes('text_level:1') &&
    c.signals.some(s => HIGH_CONFIDENCE_PATTERNS.has(s)) &&
    c.page_idx >= tocPageThreshold  // 排除目录页区域的候选
  );

  const existingIds = new Set(flatMap.map(e => e.id));
  // 文本去重：归一化后比较
  const existingTexts = new Set(flatMap.map(e => normalizeText(e.text)));
  const missed = strongCandidates.filter(c =>
    !existingIds.has(c.id) && !existingTexts.has(normalizeText(c.text))
  );

  if (missed.length === 0) {
    console.log('  后处理补漏: 无遗漏的强信号条目');
    return { flatMap, chapters };
  }

  console.log(`  后处理补漏: 发现 ${missed.length} 个被 LLM 遗漏的强信号条目:`);

  const level1Nodes = chapters
    .filter((ch: any) => ch.level === 1)
    .sort((a: any, b: any) => (a.page ?? 0) - (b.page ?? 0));

  // 顶级 pattern 集合
  const topLevelPatterns = new Set([
    'pattern:chapter_cn', 'pattern:chapter_en', 'pattern:unit_cn', 'pattern:unit_en',
    'pattern:topic_en', 'pattern:module_cn', 'pattern:module_en', 'pattern:exam_paper',
  ]);

  let backfilledCount = 0;
  for (const m of missed) {
    const mPage = m.page_idx;

    const isTopLevel = m.signals.some(s => topLevelPatterns.has(s));

    if (isTopLevel) {
      chapters.push({
        id: m.id, text: m.text, level: 1, page: mPage, children: [], _backfilled: true,
      });
      flatMap.push({
        id: m.id, text: m.text, level: 1, page_idx: mPage, full_path: m.text,
      });
      console.log(`    → [ID=${m.id}] "${m.text.substring(0, 40)}" → level 1 顶级节点`);
      backfilledCount++;
      continue;
    }

    // 找父章节（page <= mPage 的最后一个 level 1）
    let parentChapter: any = null;
    for (const ch of level1Nodes) {
      if ((ch.page ?? 0) <= mPage) parentChapter = ch;
      else break;
    }

    if (parentChapter) {
      if (!parentChapter.children) parentChapter.children = [];
      parentChapter.children.push({
        id: m.id, text: m.text, level: 2, page: mPage, children: [], _backfilled: true,
      });
      parentChapter.children.sort((a: any, b: any) => (a.page ?? 0) - (b.page ?? 0));
      flatMap.push({
        id: m.id, text: m.text, level: 2, page_idx: mPage,
        full_path: `${parentChapter.text} > ${m.text}`, parent_id: parentChapter.id,
      });
      console.log(`    → [ID=${m.id}] "${m.text.substring(0, 40)}" → level 2 under "${parentChapter.text.substring(0, 30)}"`);
      backfilledCount++;
    }
  }

  flatMap.sort((a, b) => a.page_idx - b.page_idx);
  console.log(`  补漏完成: 补入 ${backfilledCount} 个条目`);
  return { flatMap, chapters };
}

// ============= 主函数 =============

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: npx tsx runSample.ts <content_list.json_path>');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const sampleName = path.basename(inputPath, '.json');
  const outputDir = path.join(__dirname, 'output', sampleName);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  样本: ${sampleName}`);
  console.log(`  输入: ${inputPath}`);
  console.log(`  输出: ${outputDir}`);
  console.log(`${'='.repeat(60)}\n`);

  // Step 1: 加载并展平
  console.log('=== Step 1: 加载并展平 content_list.json ===');
  const rawData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const blocks = flattenContentList(rawData);
  console.log(`  总 block 数: ${blocks.length}`);
  const maxPage = Math.max(...blocks.map(b => b.page_idx));
  console.log(`  页码范围: 0 - ${maxPage}`);

  // Step 2: 构建候选集
  console.log('\n=== Step 2: 构建标题候选集 ===');
  let candidates = buildTitleCandidates(blocks);
  console.log(`  原始候选数: ${candidates.length}`);

  // 统计信号分布
  const signalCounts: Record<string, number> = {};
  for (const c of candidates) {
    for (const s of c.signals) {
      signalCounts[s] = (signalCounts[s] || 0) + 1;
    }
  }
  console.log('  信号分布:');
  for (const [sig, count] of Object.entries(signalCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${sig}: ${count}`);
  }

  // 智能过滤
  candidates = filterCandidates(candidates, 300);
  
  fs.writeFileSync(path.join(outputDir, 'title_candidates.json'), JSON.stringify(candidates, null, 2), 'utf-8');
  console.log(`  最终候选数: ${candidates.length}`);

  // Step 3: 构建 Prompt
  console.log('\n=== Step 3: 构建 LLM Prompt ===');
  const prompt = buildRevisionPrompt(candidates, blocks.length, maxPage + 1);
  fs.writeFileSync(path.join(outputDir, 'revision_prompt.txt'), prompt, 'utf-8');
  console.log(`  Prompt 长度: ${prompt.length} 字符`);

  // Step 4: 调用 LLM
  const config: LLMConfig = {
    apiUrl: process.env.LLM_API_URL || 'https://api.manus.im/api/llm-proxy/v1',
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    modelName: process.env.LLM_MODEL || 'gpt-4.1-mini',
  };
  console.log(`\n=== Step 4: 调用 LLM (model=${config.modelName}) ===`);
  const startTime = Date.now();
  const rawResponse = await callLLM(prompt, config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  LLM 响应时间: ${elapsed}s`);
  console.log(`  响应长度: ${rawResponse.length} 字符`);
  fs.writeFileSync(path.join(outputDir, 'llm_raw_response.txt'), rawResponse, 'utf-8');

  // Step 5: 解析
  console.log('\n=== Step 5: 解析 LLM 响应 ===');
  let parsed: any;
  try {
    parsed = parseLLMResponse(rawResponse);
    fs.writeFileSync(path.join(outputDir, 'chapter_tree.json'), JSON.stringify(parsed, null, 2), 'utf-8');
    console.log(`  ✅ 解析成功`);
    console.log(`  文档标题: ${parsed.document_title || 'N/A'}`);
    console.log(`  文档语言: ${parsed.document_language || 'N/A'}`);
  } catch (e: any) {
    console.error(`  ❌ 解析失败: ${e.message}`);
    process.exit(1);
  }

  // Step 6: 扁平化
  console.log('\n=== Step 6: 扁平化目录树 ===');
  let flatMap = flattenTree(parsed.chapters || []);
  console.log(`  目录条目数 (补漏前): ${flatMap.length}`);

  // Step 6.5: 保守补漏
  console.log('\n=== Step 6.5: 后处理补漏（保守策略） ===');
  const backfillResult = backfillMissedEntries(flatMap, candidates, parsed.chapters || [], maxPage + 1);
  flatMap = backfillResult.flatMap;
  parsed.chapters = backfillResult.chapters;
  console.log(`  目录条目数 (补漏后): ${flatMap.length}`);

  fs.writeFileSync(path.join(outputDir, 'chapter_flat_map.json'), JSON.stringify(flatMap, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'chapter_tree_final.json'), JSON.stringify(parsed, null, 2), 'utf-8');

  // Step 7: 输出目录树
  console.log('\n=== 最终目录树 ===');
  function printTree(nodes: any[]) {
    for (const n of nodes) {
      const levelTag = n.level === 1 ? '📖' : n.level === 2 ? '  📄' : '    📝';
      const bf = n._backfilled ? ' [BACKFILLED]' : '';
      console.log(`${levelTag} [ID=${n.id}] L${n.level} (p.${n.page ?? n.page_idx}) ${(n.text || '').substring(0, 60)}${bf}`);
      if (n.children && n.children.length > 0) {
        printTree(n.children);
      }
    }
  }
  printTree(parsed.chapters || []);

  // Step 8: 统计
  console.log('\n=== 统计 ===');
  const level1Count = flatMap.filter(e => e.level === 1).length;
  const level2Count = flatMap.filter(e => e.level === 2).length;
  const level3Count = flatMap.filter(e => e.level === 3).length;
  console.log(`  Level 1: ${level1Count}`);
  console.log(`  Level 2: ${level2Count}`);
  console.log(`  Level 3: ${level3Count}`);
  console.log(`  总计: ${flatMap.length}`);

  if (parsed.notes) {
    console.log(`\n📝 LLM 备注: ${parsed.notes}`);
  }

  console.log('\n✅ 测试完成！');
}

main().catch(console.error);
