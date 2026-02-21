/**
 * 章节标题预处理模块 (v9.1)
 * 
 * 基于"零筛选全文推理 + 两轮 LLM 校验"方案。
 * 
 * 核心思路：
 * 1. 不做任何候选筛选，将 content_list.json 全文交给 1M 上下文窗口的大模型
 * 2. 第一轮：从全文中识别所有结构化标题（章/节/小节/训练/复习等）
 * 3. 代码后处理：移除噪声条目（题型标签、教学标签等）
 * 4. 第二轮：LLM 自我校验修正（补全缺失、修复层级、合并碎片）
 * 5. 构建 chapter_flat_map：为下游题目抽取提供结构化章节信息
 * 
 * 对齐 DataFlow 官方流水线的"输入格式化与标准化"阶段。
 * 
 * @module chapterPreprocess
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { flattenContentList, FlatBlock } from './blockFlattener';

// ============================================================
// 类型定义
// ============================================================

/** content_list.json 中的原始 block */
interface RawBlock {
  type?: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  inside?: RawBlock[];
  [key: string]: any;
}

// FlatBlock 类型从 blockFlattener.ts 导入
export type { FlatBlock } from './blockFlattener';

/** 章节目录树中的单个条目 */
export interface ChapterFlatEntry {
  id: number;
  merged_ids?: number[];
  text: string;
  level: number;           // 1=章, 2=节, 3=小节
  page: number;
  block_range: { start: number; end: number };
  parent_id: number | null;
}

/** LLM 输出中的目录条目 */
interface DirectoryEntry {
  id: number | number[];
  level: number;
  title: string;
}

/** 章节预处理的 LLM 配置 */
export interface ChapterLLMConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  timeout?: number;
  contextWindow?: number;
}

/** 章节预处理结果 */
export interface ChapterPreprocessResult {
  flatMap: ChapterFlatEntry[];
  blocks: FlatBlock[];
  coverageRate: number;
  totalEntries: number;
  round1Entries: number;
  round2Entries: number;
}

// ============================================================
// Step 0: 展平 block 列表（使用共享的 flattenContentList）
// ============================================================

// flattenBlocks 已迁移到 blockFlattener.ts 的 flattenContentList()
// 保留此函数作为兼容性包装
export function flattenBlocks(raw: RawBlock[]): FlatBlock[] {
  return flattenContentList(raw);
}

// ============================================================
// Step 1: 全文格式化（用于 LLM 输入）
// ============================================================

/**
 * 格式化全文用于 LLM 输入
 * 
 * 优化策略：
 * 1. 移除图片、公式等非文本噪声
 * 2. 对非标题文本进行激进截断 (50 chars)
 * 3. 保留潜在标题的完整性 (150 chars)
 * 4. 保持 ID 和页码引用
 */
function formatFullText(blocks: FlatBlock[]): string {
  const lines: string[] = [];

  for (const b of blocks) {
    // 1. 过滤明显噪声块
    if (b.type === 'image' || b.type === 'figure') {
      // 仅保留占位符，不发送内容
      lines.push(`[${b.id}|p${b.page_idx}] [Image]`);
      continue;
    }
    
    if (b.type === 'equation') {
      lines.push(`[${b.id}|p${b.page_idx}] [Equation]`);
      continue;
    }

    if (!b.text) continue;

    // 2. 文本清洗
    let cleanText = b.text
      // 移除 Markdown 图片
      .replace(/!\[.*?\]\(.*?\)/g, '[IMG]')
      // 移除 Block Math
      .replace(/\$\$[\s\S]*?\$\$/g, '[EQ]')
      // 移除 Inline Math (简单匹配)
      .replace(/\$[^$]+\$/g, '[EQ]')
      // 压缩空白
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText) continue;

    // 3. 智能截断
    // 标题通常较短且可能有 text_level 标记
    // 即使没有标记，超过 100 字符的段落几乎不可能是标题
    // 标题保留更多上下文 (200)，正文适度截断 (200) 以保留上下文
    const limit = 200;
    const truncated = cleanText.length > limit ? cleanText.substring(0, limit) + '...' : cleanText;

    // 4. 构建行
    const typeTag = b.type === 'header'
      ? 'H'
      : (b.text_level !== null && b.text_level !== undefined ? `T${b.text_level}` : '');
    const tag = typeTag ? `${b.id}|p${b.page_idx}|${typeTag}` : `${b.id}|p${b.page_idx}`;
    lines.push(`[${tag}] ${truncated}`);
  }

  return lines.join('\n');
}

// ============================================================
// Step 1.5: 分块处理 (支持超长文本)
// ============================================================

/**
 * 将 blocks 切分为适合上下文窗口的 chunks
 * 
 * 策略：
 * 1. 估算每个 block 格式化后的 token 数
 * 2. 累积直到 limit (留 20% buffer)
 * 3. 保持一定 overlap (2000 tokens) 避免切断边界标题
 */
function splitBlocksIntoChunks(blocks: FlatBlock[], maxTokens: number): FlatBlock[][] {
  // 安全阈值：预留 20% 给 prompt 和 output
  const safeLimit = Math.floor(maxTokens * 0.8);
  const overlapTokens = 2000; // 重叠部分 token 数
  
  const chunks: FlatBlock[][] = [];
  let currentChunk: FlatBlock[] = [];
  let currentTokens = 0;
  
  // 预计算每个 block 的 token 大小 (粗略估计)
  const blockSizes = blocks.map(b => {
    // 模拟 formatFullText 的逻辑
    if (b.type === 'image' || b.type === 'figure' || b.type === 'equation') return 30; // 占位符长度
    if (!b.text) return 0;
    // 简单清洗逻辑 + 截断逻辑 (200 chars)
    const len = Math.min(b.text.length, 200); 
    // ID tags (20 chars) + text
    return Math.ceil((len + 20) / 1.5);
  });

  for (let i = 0; i < blocks.length; i++) {
    const size = blockSizes[i];
    
    // 如果单个 block 就超过 limit (极不可能，但也防一下)
    if (size > safeLimit) {
      console.warn(`[ChapterPreprocess] Block ${blocks[i].id} exceeds token limit (${size} > ${safeLimit}), truncated.`);
      // 仍然加入，依赖截断
    }

    if (currentTokens + size > safeLimit && currentChunk.length > 0) {
      // 当前 chunk 已满，保存
      chunks.push([...currentChunk]);
      
      // 开启新 chunk，带入 overlap
      // 回溯寻找重叠的 blocks
      let overlapSize = 0;
      let backtrackIndex = i - 1;
      const newChunk: FlatBlock[] = [];
      
      // 从后往前找，直到凑够 overlapTokens
      while (backtrackIndex >= 0 && overlapSize < overlapTokens) {
        newChunk.unshift(blocks[backtrackIndex]);
        overlapSize += blockSizes[backtrackIndex];
        backtrackIndex--;
      }
      
      currentChunk = newChunk;
      currentTokens = overlapSize;
      
      console.log(`[ChapterPreprocess] Chunk cut at block ${blocks[i].id}. New chunk starts with ${newChunk.length} overlap blocks.`);
    }

    currentChunk.push(blocks[i]);
    currentTokens += size;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ============================================================
// Step 2: Prompt 构建
// ============================================================

function buildExtractionPrompt(fullText: string, totalBlocks: number, totalPages: number): string {
  return `You are a document structure analyst specializing in educational textbooks.

## Task
Analyze the FULL TEXT of an educational document and identify ALL structural chapter/section headings.
Each line is a text block: [ID|pageNumber|optionalTypeTag] text
optionalTypeTag may include:
- T1/T2/T3: text_level hints from OCR (higher likelihood of headings)
- H: explicit heading marker

## High-Confidence Heading Signals
- Lines tagged with T1/T2/T3 or H
- Short, title-like lines (usually < 120 chars)
- Lines with explicit structure markers (Chapter, Unit, Module, Part, 1.1, 2.3.4)

## CRITICAL: Table of Contents vs. Document Body
The first few pages may contain a TABLE OF CONTENTS (listing chapter names with page numbers).
You MUST IGNORE the actual Table of Contents lists.
HOWEVER, do NOT ignore "Front Matter" sections (like Introduction, Preface) or "Unit" title pages that appear before the main chapters.

Table of contents signs (IGNORE these):
- Pages explicitly labeled "Contents" or "Table of Contents"
- Lists of titles followed by page numbers (e.g., "1.1 ... 5", "Chapter 2 ... 12")
- Dense lists of headings on a single page

## What ARE Structural Headings (INCLUDE)
- **Front Matter**: Introduction, Preface, How to use this book, Acknowledgements, etc.
- **Back Matter**: Glossary, Index, Answers, etc.
- **Organization Containers**: Units, Modules, Parts, Themes (e.g., "Unit 1", "Module A")
- **Chapters**: (e.g., "Chapter 1", "1 Review of number concepts")
- **Sections**: (e.g., "1.1 Different types of numbers")
- **Sub-sections**: (e.g., "1.1.1", "Case Study")
- **Assessments**: "Past paper questions", "Project", "Review", "Summary"

## What Are NOT Headings (MUST EXCLUDE)
- The actual Table of Contents list itself
- Instructional labels: "Key points", "Tip", "Note", "Activity", "Exercise", "Q&A"
- Problem type labels: "Question 1", "Section A", "Multiple Choice"
- Question statements or solution steps (e.g., "Simplify...", "Show the steps...", equations)
- Figure/table captions and diagram descriptions
- Running headers/footers (often repeated at top/bottom of pages)

## Hierarchy (Map to logical levels)
        - **Level 1**: Top-level containers.
          - Front Matter / Back Matter categories (e.g., "Front Matter", "Back Matter")
          - Units / Parts / Modules / Themes (e.g., "Unit 1", "Part A")
          - Standalone Chapters if no Units exist
        - **Level 2**: Main content divisions.
          - Chapters (if inside a Unit)
          - Sections (if inside a standalone Chapter)
          - Specific Front/Back Matter sections (e.g., "Introduction", "Foreword", "Glossary")
        - **Level 3**: Sub-divisions.
          - Sections (if inside a Unit->Chapter)
          - Sub-sections
          - Specific items like "1.1 Understanding units"
        - **Level 4**: Deep sub-divisions (if needed).
          - Sub-sections (e.g., "1.1.1")

        ## Fragmented Titles
If a heading is split across consecutive blocks (e.g., block 100="Chapter" + block 101="1"), merge them: output id as [100, 101].

## Completeness
- Include EVERY structural heading from the very beginning (Introduction) to the very end (Index).
- Do not skip "Unit" pages.

## Output Format
Return ONLY valid JSON:
{
  "directory": [
    {"id": <number or [n1, n2]>, "level": <1|2|3>, "title": "<heading text>"},
    ...
  ]
}
Array MUST be in the LOGICAL order of the document.

## CRITICAL RULE: RETURN ORIGINAL IDs
The block IDs you see (e.g., [12479|p394|T1]) are GLOBAL IDs. You MUST return these exact IDs. DO NOT generate your own sequential IDs starting from 0.
- CORRECT: {"id": 12479, ...}
- WRONG: {"id": 0, ...} (when the block shown was [12479|...])

---

Document: ${totalBlocks} blocks, ${totalPages} pages.

${fullText}`;
}

function buildVerificationPrompt(
  firstResult: DirectoryEntry[],
  fullText: string,
  totalBlocks: number,
  totalPages: number
): string {
  const firstResultJson = JSON.stringify(firstResult, null, 2);

  return `You are a document structure analyst. A previous analysis of an educational document produced the directory tree below. Your job is to VERIFY and CORRECT it.

## Previous Result (may have errors)
${firstResultJson}

## Common Errors to Check and Fix
1. **Missing headings**: Check that ALL numbered sub-sections are included. Check for missing "Front Matter" or "Back Matter".
2. **False positives**: Instructional labels like "Key points", "Exercises", "Questions" are NOT structural headings — remove them.
3. **Missing parent**: If sections like "22.1", "22.2" exist but "Chapter 22" (or "Unit X") is missing, find and add it.
4. **Fragmented titles**: Merge adjacent title fragments (e.g., "Chapter" + "1") into one entry.
5. **Level errors**: Ensure correct hierarchy: Unit (L1) -> Chapter (L2) -> Section (L3). If no Units, then Chapter (L1).
6. **Table of contents entries**: Only remove entries that are explicitly part of a "Contents" list (with page numbers at the end). DO NOT remove "Introduction" or "Unit" pages.

## Instructions
- Review the previous result against the full document text below
- Fix any of the above errors
- Output the CORRECTED directory in the same JSON format
- Keep entries in LOGICAL document order (not necessarily ascending ID)

## Output Format
Return ONLY valid JSON:
{
  "directory": [
    {"id": <number or [n1, n2]>, "level": <1|2|3>, "title": "<heading text>"},
    ...
  ]
}

---

Document: ${totalBlocks} blocks, ${totalPages} pages.

${fullText}`;
}

// ============================================================
// Step 3: 调用 LLM（使用用户配置的 API）
// ============================================================

async function callChapterLLM(prompt: string, config: ChapterLLMConfig): Promise<string> {
  const base = config.apiUrl.replace(/\/+$/, '');
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const client = axios.create({
    timeout: config.timeout || 300000, // Default to 5 minutes
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  axiosRetry(client, {
    retries: 2,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
      return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        (error.response?.status ? error.response.status >= 500 : false);
    },
  });

  const response = await client.post(endpoint, {
    model: config.modelName,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 32000,
    // response_format: { type: 'json_object' }, // Removed for better compatibility
  });

  return response.data.choices[0].message.content;
}

// ============================================================
// Step 4: 解析 LLM 输出
// ============================================================

/**
 * 尝试修复截断的 JSON
 * 
 * LLM 输出可能会因为 max_tokens 限制而被截断。
 * 此函数尝试通过查找最后一个闭合的大括号或中括号来修复 JSON。
 */
function tryRepairJSON(raw: string): any {
  try { return JSON.parse(raw); } catch {}
  let repaired = raw.trim();
  repaired = repaired.replace(/("level"\s*:\s*),/g, '$1 1,');
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  repaired = repaired.replace(/,\s*,+/g, ',');
  try { return JSON.parse(repaired); } catch {}
  let jsonString = repaired;
  const firstBrace = jsonString.indexOf('{');
  if (firstBrace === -1) throw new Error('No JSON object found');
  jsonString = jsonString.substring(firstBrace);

  // 3. 尝试简单的修复 (补全末尾的 })
  try { return JSON.parse(jsonString + '}'); } catch {}
  try { return JSON.parse(jsonString + ']}'); } catch {}
  try { return JSON.parse(jsonString + '"]}}'); } catch {}

  // 4. 倒序查找有效的闭合点
  // 假设结构是 {"directory": [ ... ]}，我们尝试在每一个 '}' 处截断并补全 ']}'
  let lastBrace = jsonString.lastIndexOf('}');
  
  // 限制尝试次数，避免死循环太久 (最多尝试最后 20 个闭合点)
  let attempts = 0;
  while (lastBrace > firstBrace && attempts < 20) {
    attempts++;
    
    // 方案 A: 假设是在数组项之间截断 -> 补全 ]}
    const candidateA = jsonString.substring(0, lastBrace + 1) + ']}';
    try {
      const parsed = JSON.parse(candidateA);
      // 验证结构
      if (parsed.directory || parsed.chapters || parsed.entries) {
        console.warn(`[ChapterPreprocess] JSON repaired by appending ']}' at pos ${lastBrace + 1}`);
        return parsed;
      }
    } catch {}

    // 方案 B: 假设就是在根对象结束处 (即完整的 JSON) -> 已经在第 1 步试过了，但可能中间有乱码
    const candidateB = jsonString.substring(0, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidateB);
      return parsed;
    } catch {}

    // 方案 C: 假设是在对象内部截断 -> 补全 }]}
    // 这比较复杂，暂不处理，依赖方案 A 的回退

    // 继续向前寻找下一个 '}'
    lastBrace = jsonString.lastIndexOf('}', lastBrace - 1);
  }

  throw new Error('Failed to repair truncated JSON');
}

function parseLLMOutput(
  raw: string,
  validIds: Set<number>,
  indexToId?: number[]
): { entries: DirectoryEntry[]; warnings: string[] } {
  const warnings: string[] = [];

  let parsed: any;
  try {
    parsed = tryRepairJSON(raw);
  } catch (err: any) {
    // Fallback: try regex extraction if repair failed
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw err;
      parsed = JSON.parse(match[0]);
      warnings.push('JSON extracted via regex');
    } catch {
       throw new Error(`JSON parsing failed: ${err.message}`);
    }
  }

  const rawEntries = parsed.directory || parsed.chapters || parsed.entries;
  if (!Array.isArray(rawEntries)) throw new Error('Missing "directory" array');

  const outputIdsList: number[] = rawEntries
    .map((e: any) => Array.isArray(e.id) ? e.id[0] : e.id)
    .filter((id: any) => typeof id === 'number') as number[];
  if (outputIdsList.length > 0 && indexToId && indexToId.length > 0) {
    const outOfRange = outputIdsList.filter(id => !validIds.has(id));
    const looksLocal = outOfRange.length > 0 && outOfRange.every(id => id >= 0 && id < indexToId.length);
    if (looksLocal) {
      warnings.push('ID space drift detected: mapping local indices to global IDs.');
    }
  } else if (outputIdsList.length > 0) {
    const validIdsList = Array.from(validIds.values());
    const minValid = Math.min(...validIdsList);
    const maxOutput = Math.max(...outputIdsList);
    const minOutput = Math.min(...outputIdsList);
    if (maxOutput < 100 && minValid > 1000) {
      warnings.push('ID space drift detected: output IDs appear 0-based while valid IDs are large.');
      return { entries: [], warnings };
    }
    if (minOutput === 0 && maxOutput < 100 && minValid > 500) {
      warnings.push('ID space drift detected (heuristic): small sequential IDs against large valid ID range.');
      return { entries: [], warnings };
    }
  }

  const entries: DirectoryEntry[] = [];
  let invalidCount = 0;

  const mapId = (value: number): number | null => {
    if (validIds.has(value)) return value;
    if (indexToId && value >= 0 && value < indexToId.length) {
      return indexToId[value];
    }
    return null;
  };

  for (const item of rawEntries) {
    const id = item.id;
    if (typeof id === 'number') {
      const mapped = mapId(id);
      if (mapped === null) { invalidCount++; continue; }
      item.id = mapped;
    } else if (Array.isArray(id)) {
      const mappedIds: number[] = [];
      for (const entryId of id) {
        if (typeof entryId !== 'number') continue;
        const mapped = mapId(entryId);
        if (mapped !== null) mappedIds.push(mapped);
      }
      if (mappedIds.length === 0) { invalidCount++; continue; }
      item.id = mappedIds;
    } else { invalidCount++; continue; }

    const level = item.level;
    if (typeof level !== 'number' || level < 1 || level > 3) continue;

    entries.push({ id: item.id, level, title: (item.title ?? '').trim() });
  }

  if (invalidCount > 0) warnings.push(`${invalidCount} entries with invalid IDs removed`);

  // 去重
  const seen = new Set<number>();
  const deduped: DirectoryEntry[] = [];
  for (const e of entries) {
    const pid = Array.isArray(e.id) ? e.id[0] : e.id;
    if (seen.has(pid)) continue;
    seen.add(pid);
    deduped.push(e);
  }

  return { entries: deduped, warnings };
}

// ============================================================
// Step 5: 后处理 — 清理噪声条目
// ============================================================

function postProcessCleanup(entries: DirectoryEntry[], blocks: FlatBlock[]): DirectoryEntry[] {
  const blockMap = new Map<number, FlatBlock>();
  for (const b of blocks) blockMap.set(b.id, b);

  const minTitleLength = Number(process.env.CHAPTER_TITLE_MIN_LENGTH ?? 2);
  const maxTitleLength = Number(process.env.CHAPTER_TITLE_MAX_LENGTH ?? 120);
  const maxWords = Number(process.env.CHAPTER_TITLE_MAX_WORDS ?? 16);
  const maxDigitRatio = Number(process.env.CHAPTER_TITLE_MAX_DIGIT_RATIO ?? 0.5);

  const noisePatterns = [
    /^要点归纳$/,
    /^疑难分析$/,
    /^基础训练$/,
    /^拓展训练$/,
    /^综合训练$/,
    /^[一二三四五六七八九十]\s*[、.．]\s*(填空题|选择题|解答题|计算题|综合题|证明题)/,
    /^例题?\s*\d/,
    /^练习\s*\d/,
    /^习题\s*\d/,

    /^Key\s+Points$/i,
    /^Tip$/i,
    /^Note$/i,
    /^Activity\s*\d*$/i,
    /^Exercise\s*\d*$/i,
    /^Exercises\s*\d*$/i,
    /^Q\s*&\s*A$/i,
    /^Multiple\s+Choice$/i,
    /^Section\s+[A-Z]$/i,
    /^Question\s*\d+$/i,
    /^Example\s*\d*/i,
    /^Practice\s*(Test|Questions)?/i,
    /^Past\s+paper\s+questions?/i,
  ];

  const structuralTokens = /(chapter|unit|module|part|section|lesson|topic|appendix|glossary|index|review|summary|preface|introduction|foreword)/i;
  const questionVerbPattern = /^(simplify|solve|find|calculate|evaluate|show|prove|determine|given|use|draw|write|work\s+out)\b/i;
  const equationPattern = /[=<>$]|\\frac|\\sqrt|\\sum|\\int/;

  return entries.filter(e => {
    const pid = Array.isArray(e.id) ? e.id[0] : e.id;
    const text = (blockMap.get(pid)?.text ?? e.title).trim();
    for (const p of noisePatterns) {
      if (p.test(text)) {
        return false;
      }
    }
    if (!text && !e.title.trim()) {
      return false;
    }
    if (text.length < minTitleLength || text.length > maxTitleLength) {
      return false;
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > maxWords) {
      return false;
    }
    const digitCount = (text.match(/\d/g) ?? []).length;
    const digitRatio = text.length > 0 ? digitCount / text.length : 0;
    if (digitRatio > maxDigitRatio && !structuralTokens.test(text)) {
      return false;
    }
    if (questionVerbPattern.test(text) && !structuralTokens.test(text)) {
      return false;
    }
    if (equationPattern.test(text) && !structuralTokens.test(text)) {
      return false;
    }
    return true;
  });
}

// ============================================================
// Step 6: 构建 chapter_flat_map（保持 LLM 逻辑顺序）
// ============================================================

function buildFlatMap(entries: DirectoryEntry[], blocks: FlatBlock[]): ChapterFlatEntry[] {
  const totalBlocks = blocks.length;
  const blockMap = new Map<number, FlatBlock>();
  for (const b of blocks) blockMap.set(b.id, b);

  const parentStack: { id: number; level: number }[] = [];
  const result: ChapterFlatEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const primaryId = Array.isArray(entry.id) ? entry.id[0] : entry.id;
    const allIds = Array.isArray(entry.id) ? entry.id : [entry.id];

    // ID 回填：取原始文本，截断避免带入题目内容
    const texts = allIds.map(id => {
      const t = blockMap.get(id)?.text ?? '';
      return t.length > 80 ? t.substring(0, 80) : t;
    }).filter(t => t);
    const mergedText = texts.join(' ');
    const page = blockMap.get(primaryId)?.page_idx ?? 0;

    // block_range 计算
    const minId = Math.min(...allIds);
    const start = minId;

    let end: number;
    if (i + 1 < entries.length) {
      const nextIds = Array.isArray(entries[i + 1].id) ? entries[i + 1].id as number[] : [entries[i + 1].id as number];
      end = Math.min(...nextIds);
    } else {
      end = totalBlocks;
    }

    // 处理 start >= end 的情况（Mineru 解析顺序问题）
    if (start >= end && i + 1 < entries.length) {
      end = start + 1;
    }

    // parent_id 计算
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= entry.level) {
      parentStack.pop();
    }
    const parentId = parentStack.length > 0 ? parentStack[parentStack.length - 1].id : null;
    parentStack.push({ id: primaryId, level: entry.level });

    result.push({
      id: primaryId,
      merged_ids: allIds.length > 1 ? allIds : undefined,
      text: mergedText || entry.title,
      level: entry.level,
      page,
      block_range: { start, end },
      parent_id: parentId,
    });
  }

  return result;
}

export function validateChapterEntries(entries: DirectoryEntry[], blocks: FlatBlock[]): { ok: boolean; error?: string } {
  const allIds = new Set(blocks.map(b => b.id));
  for (const entry of entries) {
    const ids = Array.isArray(entry.id) ? entry.id : [entry.id];
    for (const id of ids) {
      if (!allIds.has(id)) {
        return { ok: false, error: `Invalid block ID ${id}` };
      }
    }
    if (typeof entry.level !== 'number' || entry.level < 1 || entry.level > 4) {
      return { ok: false, error: `Invalid level ${entry.level}` };
    }
  }
  const totalBlocks = blocks.length;
  const totalEntries = entries.length;
  const level1Count = entries.filter(e => e.level === 1).length;
  const maxLevel1Ratio = Number(process.env.CHAPTER_VALIDATION_MAX_LEVEL1_RATIO ?? 0.5);
  const maxEntriesRatio = Number(process.env.CHAPTER_VALIDATION_MAX_ENTRIES_RATIO ?? 0.25);
  if (totalEntries > 20 && level1Count / totalEntries > maxLevel1Ratio) {
    return { ok: false, error: `Abnormally high percentage of level-1 entries (${level1Count}/${totalEntries})` };
  }
  if (totalBlocks > 100 && totalEntries / totalBlocks > maxEntriesRatio) {
    return { ok: false, error: `Too many chapter entries (${totalEntries}) relative to total blocks (${totalBlocks})` };
  }
  return { ok: true };
}

// ============================================================
// Step 7: 完整性校验
// ============================================================

function validateCompleteness(flatMap: ChapterFlatEntry[], totalBlocks: number): { covered: number; uncovered: number; coverageRate: number } {
  if (flatMap.length === 0) return { covered: 0, uncovered: totalBlocks, coverageRate: 0 };

  const covered = new Set<number>();
  for (const entry of flatMap) {
    for (let i = entry.block_range.start; i < entry.block_range.end; i++) {
      covered.add(i);
    }
  }
  const firstId = Math.min(...flatMap.map(e => e.block_range.start));
  let uncovered = 0;
  for (let i = firstId; i < totalBlocks; i++) {
    if (!covered.has(i)) uncovered++;
  }
  const relevant = totalBlocks - firstId;
  const rate = relevant > 0 ? (relevant - uncovered) / relevant : 1;
  return { covered: covered.size, uncovered, coverageRate: rate };
}

// ============================================================
// 主函数：章节预处理
// ============================================================

/**
 * 执行章节标题预处理
 * 
 * 从 content_list.json 中提取文档结构（章/节/小节），
 * 生成 chapter_flat_map 供下游题目抽取使用。
 * 
 * @param contentListPath - content_list.json 文件路径
 * @param taskDir - 任务目录（用于保存中间产物和日志）
 * @param llmConfig - LLM 配置（使用用户配置的 API）
 * @param onProgress - 进度回调
 * @returns ChapterPreprocessResult
 */
export async function preprocessChapters(
  contentListPath: string,
  taskDir: string,
  llmConfig: ChapterLLMConfig,
  onProgress?: (message: string) => Promise<void>
): Promise<ChapterPreprocessResult> {
  const debugDir = path.join(taskDir, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  // ========== Step 0: 展平 ==========
  if (onProgress) await onProgress('章节预处理：加载并展平 content_list.json...');
  const raw: RawBlock[] = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const blocks = flattenBlocks(raw);
  const totalPages = Math.max(...blocks.map(b => b.page_idx ?? 0)) + 1;
  console.log(`[ChapterPreprocess] 展平: ${raw.length} 原始 → ${blocks.length} blocks, ${totalPages} pages`);

  // ========== Step 1: 全文格式化 ==========
  if (onProgress) await onProgress('章节预处理：格式化全文...');
  const fullText = formatFullText(blocks);
  // 估算 token 数 (粗略估算: 1 token ≈ 1.5 chars for Chinese/English mix, or use length/2 safe bound)
  const estTokens = Math.ceil(fullText.length / 1.5); 
  console.log(`[ChapterPreprocess] 全文格式化: ${fullText.length} chars, ~${estTokens} tokens`);
  
  const limit = llmConfig.contextWindow ? Math.floor(llmConfig.contextWindow * 0.8) : 128000;
  const validIds = new Set(blocks.map(b => b.id));
  
  // ========== Step 2: 第一轮 LLM 抽取 ==========
  let round1Entries: DirectoryEntry[] = [];
  
  if (estTokens <= limit) {
    // --------------------------------------------------------
    // A. 单次全量处理 (Original Logic)
    // --------------------------------------------------------
    if (onProgress) await onProgress('章节预处理：第一轮 LLM 抽取（全文推理）...');
    const prompt1 = buildExtractionPrompt(fullText, blocks.length, totalPages);
    fs.writeFileSync(path.join(debugDir, 'chapter_prompt_round1.txt'), prompt1);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const startTime = Date.now();
        const llmRaw = await callChapterLLM(prompt1, llmConfig);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[ChapterPreprocess] Round 1 attempt ${attempt}: ${elapsed}s, ${llmRaw.length} chars`);
        fs.writeFileSync(path.join(debugDir, `chapter_llm_round1_attempt${attempt}.json`), llmRaw);

        const { entries, warnings } = parseLLMOutput(llmRaw, validIds);
        for (const w of warnings) console.warn(`[ChapterPreprocess] [WARN] ${w}`);
        round1Entries = entries;
        console.log(`[ChapterPreprocess] Round 1: ${entries.length} entries (L1=${entries.filter(e => e.level === 1).length}, L2=${entries.filter(e => e.level === 2).length}, L3=${entries.filter(e => e.level === 3).length})`);
        break;
      } catch (err: any) {
        console.error(`[ChapterPreprocess] Round 1 attempt ${attempt} failed: ${err.message}`);
      }
    }
  } else {
    // --------------------------------------------------------
    // B. 分块处理 (Chunked Logic)
    // --------------------------------------------------------
    const msg = `文档内容过长 (~${estTokens} tokens)，超出模型上下文限制 (${llmConfig.contextWindow} tokens, 安全阈值 ${limit})，切换到分块处理模式。`;
    console.warn(`[ChapterPreprocess] ${msg}`);
    if (onProgress) await onProgress(`章节预处理：${msg}`);

    // 切分 chunks (使用 formatFullText 的逻辑估算)
    // 注意：这里需要传入 blocks 和 limit (token limit)
    const blocksForChunks = splitBlocksIntoChunks(blocks, limit);
    console.log(`[ChapterPreprocess] Split into ${blocksForChunks.length} chunks.`);

    for (const [idx, chunkBlocks] of blocksForChunks.entries()) {
      if (onProgress) await onProgress(`章节预处理：处理分块 ${idx + 1}/${blocksForChunks.length}...`);
      
      const chunkText = formatFullText(chunkBlocks);
      const chunkPrompt = buildExtractionPrompt(chunkText, chunkBlocks.length, totalPages);
      // Debug: Write chunk prompt to file
      fs.writeFileSync(path.join(debugDir, `chapter_chunk_${idx + 1}_prompt.txt`), chunkPrompt);

      const chunkValidIds = new Set(chunkBlocks.map(b => b.id));

      let chunkEntries: DirectoryEntry[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const startTime = Date.now();
          const llmRaw = await callChapterLLM(chunkPrompt, llmConfig);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[ChapterPreprocess] Chunk ${idx + 1} attempt ${attempt}: ${elapsed}s`);
          
          // Debug: Write chunk response to file
          fs.writeFileSync(path.join(debugDir, `chapter_chunk_${idx + 1}_response_attempt${attempt}.json`), llmRaw);
          
          const { entries, warnings } = parseLLMOutput(llmRaw, chunkValidIds, chunkBlocks.map(b => b.id));
          for (const w of warnings) console.warn(`[ChapterPreprocess] [WARN] ${w}`);
          chunkEntries = entries;
          break;
        } catch (err: any) {
           console.error(`[ChapterPreprocess] Chunk ${idx + 1} attempt ${attempt} failed: ${err.message}`);
        }
      }
      
      // Accumulate
      round1Entries.push(...chunkEntries);
    }
    
    // Deduplicate round1Entries (simple ID check)
    const seenIds = new Set<number>();
    const uniqueEntries: DirectoryEntry[] = [];
    // Sort by ID first to ensure order? Usually output is ordered.
    // Chunk output is ordered locally. Merging sequentially preserves global order.
    
    for (const entry of round1Entries) {
      const pid = Array.isArray(entry.id) ? entry.id[0] : entry.id;
      if (!seenIds.has(pid)) {
        seenIds.add(pid);
        uniqueEntries.push(entry);
      }
    }
    round1Entries = uniqueEntries;
    console.log(`[ChapterPreprocess] Merged Chunk Results: ${round1Entries.length} entries.`);
  }

  if (round1Entries.length === 0) {
    const errMsg = '第一轮章节抽取失败：LLM 未能识别任何章节标题';
    console.error(`[ChapterPreprocess] ${errMsg}`);
    throw new Error(errMsg);
  }

  // ========== Step 3: 后处理清理 ==========
  if (onProgress) await onProgress('章节预处理：清理噪声条目...');
  const cleaned = postProcessCleanup(round1Entries, blocks);
  console.log(`[ChapterPreprocess] 清理后: ${cleaned.length} entries (移除 ${round1Entries.length - cleaned.length} 个噪声)`);

  // ========== Step 4: 第二轮 LLM 校验修正 ==========
  if (onProgress) await onProgress('章节预处理：第二轮 LLM 校验修正...');
  
  let finalEntries: DirectoryEntry[] = cleaned;

  if (estTokens <= limit) {
    // --------------------------------------------------------
    // A. 单次全量校验 (Original Logic)
    // --------------------------------------------------------
    const prompt2 = buildVerificationPrompt(cleaned, fullText, blocks.length, totalPages);
    fs.writeFileSync(path.join(debugDir, 'chapter_prompt_round2.txt'), prompt2);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const startTime = Date.now();
        const llmRaw = await callChapterLLM(prompt2, llmConfig);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[ChapterPreprocess] Round 2 attempt ${attempt}: ${elapsed}s, ${llmRaw.length} chars`);
        fs.writeFileSync(path.join(debugDir, `chapter_llm_round2_attempt${attempt}.json`), llmRaw);

        const { entries, warnings } = parseLLMOutput(llmRaw, validIds);
        for (const w of warnings) console.warn(`[ChapterPreprocess] [WARN] ${w}`);

        if (entries.length >= cleaned.length * 0.8) {
          finalEntries = entries;
          console.log(`[ChapterPreprocess] Round 2: ${entries.length} entries (L1=${entries.filter(e => e.level === 1).length}, L2=${entries.filter(e => e.level === 2).length}, L3=${entries.filter(e => e.level === 3).length})`);
        } else {
          console.warn(`[ChapterPreprocess] Round 2 结果过少 (${entries.length} < ${Math.floor(cleaned.length * 0.8)})，保留第一轮结果`);
        }
        break;
      } catch (err: any) {
        console.error(`[ChapterPreprocess] Round 2 attempt ${attempt} failed: ${err.message}`);
      }
    }
  } else {
    // --------------------------------------------------------
    // B. 分块校验 (Chunked Verification)
    // --------------------------------------------------------
    if (onProgress) await onProgress('章节预处理：第二轮校验 (分块模式)...');
    
    // 复用之前切分的 blocksForChunks
    const blocksForChunks = splitBlocksIntoChunks(blocks, limit);
    const chunkResults: DirectoryEntry[] = [];
    
    for (const [idx, chunkBlocks] of blocksForChunks.entries()) {
      const chunkText = formatFullText(chunkBlocks);
      const chunkValidIds = new Set(chunkBlocks.map(b => b.id));
      
      // 找出当前 chunk 相关的 entries (ID 在 chunk 范围内)
      // 注意：entries 可能跨越 chunk 边界，但通常只要主 ID 在范围内即可
      const relevantEntries = cleaned.filter(e => {
        const pid = Array.isArray(e.id) ? e.id[0] : e.id;
        return chunkValidIds.has(pid);
      });
      
      if (relevantEntries.length === 0) {
        // 如果这个 chunk 没有识别出任何 entries，可能不需要校验，或者跳过
        continue;
      }

      const chunkPrompt = buildVerificationPrompt(relevantEntries, chunkText, chunkBlocks.length, totalPages);
      
      let chunkVerified = relevantEntries; // 默认回退
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const llmRaw = await callChapterLLM(chunkPrompt, llmConfig);
          const { entries, warnings } = parseLLMOutput(llmRaw, chunkValidIds, chunkBlocks.map(b => b.id));
          for (const w of warnings) console.warn(`[ChapterPreprocess] [WARN] ${w}`);
          
          if (entries.length >= relevantEntries.length * 0.5) { // 分块校验容忍度稍高
            chunkVerified = entries;
            console.log(`[ChapterPreprocess] Chunk ${idx + 1} verified: ${relevantEntries.length} -> ${entries.length}`);
          }
          break;
        } catch (err: any) {
          console.error(`[ChapterPreprocess] Chunk ${idx + 1} verification failed: ${err.message}`);
        }
      }
      chunkResults.push(...chunkVerified);
    }
    
    // Dedupe again
    const seenIds = new Set<number>();
    const uniqueEntries: DirectoryEntry[] = [];
    for (const entry of chunkResults) {
      const pid = Array.isArray(entry.id) ? entry.id[0] : entry.id;
      if (!seenIds.has(pid)) {
        seenIds.add(pid);
        uniqueEntries.push(entry);
      }
    }
    finalEntries = uniqueEntries;
    console.log(`[ChapterPreprocess] Merged Verification Results: ${finalEntries.length} entries.`);
  }

  // 再次清理
  finalEntries = postProcessCleanup(finalEntries, blocks);

  // ========== Step 5: 构建 flat_map ==========
  if (onProgress) await onProgress('章节预处理：构建目录树...');
  const validation = validateChapterEntries(finalEntries, blocks);
  if (!validation.ok) {
    const errMsg = `章节验证失败: ${validation.error}`;
    console.error(`[ChapterValidation] ${errMsg}`);
    throw new Error(errMsg);
  }
  const flatMap = buildFlatMap(finalEntries, blocks);
  console.log(`[ChapterPreprocess] flat_map: ${flatMap.length} entries`);

  // 完整性校验
  const comp = validateCompleteness(flatMap, blocks.length);
  console.log(`[ChapterPreprocess] 覆盖率: ${(comp.coverageRate * 100).toFixed(1)}%`);

  // 保存结果
  fs.writeFileSync(path.join(debugDir, 'chapter_flat_map.json'), JSON.stringify(flatMap, null, 2));

  // 打印目录树（日志）
  for (const entry of flatMap) {
    const indent = '  '.repeat(entry.level - 1);
    const tag = `L${entry.level}`;
    console.log(`[ChapterPreprocess] ${indent}${tag} p.${entry.page} | ${entry.text.substring(0, 70)} [${entry.block_range.start}-${entry.block_range.end})`);
  }

  return {
    flatMap,
    blocks,
    coverageRate: comp.coverageRate,
    totalEntries: flatMap.length,
    round1Entries: round1Entries.length,
    round2Entries: finalEntries.length,
  };
}

/**
 * 根据 block ID 查找其所属的章节标题
 * 
 * 用于题目抽取时，将 block 映射到章节。
 * 
 * @param blockId - block 的 ID
 * @param flatMap - 章节目录树
 * @returns 最深层级的匹配章节标题，如果找不到则返回空字符串
 */
export function findChapterForBlock(blockId: number, flatMap: ChapterFlatEntry[]): string {
  let bestMatch: ChapterFlatEntry | null = null;

  for (const entry of flatMap) {
    if (blockId >= entry.block_range.start && blockId < entry.block_range.end) {
      // 选择最深层级的匹配（最具体的章节）
      if (!bestMatch || entry.level > bestMatch.level) {
        bestMatch = entry;
      }
    }
  }

  if (bestMatch) {
    // 构建完整的章节路径（如 "第19章 > 19.1 > 19.1(一)"）
    const ancestors: string[] = [];
    let current: ChapterFlatEntry | undefined = bestMatch;
    while (current) {
      ancestors.unshift(current.text);
      current = current.parent_id !== null
        ? flatMap.find(e => e.id === current!.parent_id)
        : undefined;
    }
    return ancestors.join(' > ');
  }

  return '';
}

/**
 * 根据 block ID 查找其所属的最近章节标题（不含路径）
 * 
 * @param blockId - block 的 ID
 * @param flatMap - 章节目录树
 * @returns 最近的章节标题文本
 */
export function findNearestChapter(blockId: number, flatMap: ChapterFlatEntry[]): string {
  let bestMatch: ChapterFlatEntry | null = null;

  for (const entry of flatMap) {
    if (blockId >= entry.block_range.start && blockId < entry.block_range.end) {
      if (!bestMatch || entry.level > bestMatch.level) {
        bestMatch = entry;
      }
    }
  }

  return bestMatch?.text ?? '';
}
