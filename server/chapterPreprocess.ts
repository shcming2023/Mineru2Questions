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

function formatFullText(blocks: FlatBlock[]): string {
  const lines: string[] = [];

  for (const b of blocks) {
    if (!b.text) continue;
    const truncated = b.text.length > 150 ? b.text.substring(0, 150) + '...' : b.text;
    const typeTag = b.type === 'header' ? 'H' : (b.text_level === 1 ? 'T1' : '');
    const tag = typeTag ? `${b.id}|p${b.page_idx}|${typeTag}` : `${b.id}|p${b.page_idx}`;
    lines.push(`[${tag}] ${truncated}`);
  }

  return lines.join('\n');
}

// ============================================================
// Step 2: Prompt 构建
// ============================================================

function buildExtractionPrompt(fullText: string, totalBlocks: number, totalPages: number): string {
  return `You are a document structure analyst specializing in educational textbooks.

## Task
Analyze the FULL TEXT of an educational document and identify ALL structural chapter/section headings.
Each line is a text block: [ID|pageNumber|optionalTypeTag] text

## CRITICAL: Table of Contents vs. Document Body
The first few pages may contain a TABLE OF CONTENTS (目录) listing chapter names with page numbers.
You MUST IGNORE all table-of-contents entries. Only identify headings from the DOCUMENT BODY.

Table of contents signs:
- First few pages (typically pages 0-10)
- Page numbers at end of text (e.g., "19.1 平方根与立方根 1", "第20章 二次根式 … 38")
- Many heading-like entries densely packed on one page
- Same titles appear again later in the body — those later ones are the real headings

## What ARE Structural Headings (INCLUDE)
- Chapters/Units/Parts/Topics (e.g., "第19章 实数", "Unit 5", "TOPIC 3")
- Sections (e.g., "19.1 平方根与立方根", "Lesson 3-1")
- Sub-sections (e.g., "19.1(一) 算术平方根", "19.2（二） 无理数")
- Training sections (e.g., "阶段训练①" through "阶段训练⑨", "REVIEW")
- Chapter reviews (e.g., "本章复习题", "本章复习题（一）")
- Exam papers (e.g., "期末测试卷A卷", "期末测试卷B卷")

## What Are NOT Headings (MUST EXCLUDE)
- Table of contents entries (see above)
- Instructional labels: "要点归纳", "疑难分析", "基础训练", "拓展训练", "综合训练", "例题", "练习", "习题"
- Problem type labels: "一、填空题", "二、选择题", "三、解答题", "四、计算题", "五、综合题"
- Exercise numbers, problem text, page headers/footers

## Hierarchy (3 levels max)
- **Level 1**: Chapters, Units, Parts, Topics, standalone exam papers
- **Level 2**: Sections, Lessons, Reviews, Training sections within a L1
- **Level 3**: Sub-sections within a L2 (e.g., "19.1(一)")

## Fragmented Titles
If a heading is split across consecutive blocks (e.g., block 100="期末测试卷" + block 101="A卷"), merge them: output id as [100, 101].

## Completeness
- Include EVERY instance (e.g., "本章复习题" appears 4 times → 4 entries)
- Numbered series "阶段训练①②③④⑤⑥⑦⑧⑨" = 9 separate entries
- When in doubt, INCLUDE it

## Output Format
Return ONLY valid JSON:
{
  "directory": [
    {"id": <number or [n1, n2]>, "level": <1|2|3>, "title": "<heading text>"},
    ...
  ]
}
Array MUST be in the LOGICAL order of the document (the order headings appear in the document flow, NOT necessarily ascending ID order — because PDF parsing may place a chapter title block after its first section block).

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
1. **Missing headings**: Some sub-sections may be missing. Check that ALL numbered sub-sections are included (e.g., if 21.2(一)(二)(三)(四) exist, all four must be present; if 22.3(一)(二)(三)(四) exist, all four must be present).
2. **False positives**: "要点归纳", "疑难分析" are NOT structural headings — remove them.
3. **Missing chapter heading**: If sections like "22.1", "22.2", "22.3" exist but "第22章" is missing, find and add it.
4. **Fragmented exam titles**: "期末测试卷" + "A卷" on nearby blocks should be merged as one entry with id=[id1, id2], titled "期末测试卷A卷". Same for B卷.
5. **Level errors**: Sections (like "22.1") should be L2 under their chapter (L1), not L1 themselves.
6. **Table of contents entries**: Any entries from the first ~10 pages that look like TOC entries (with page numbers at end) should be removed.

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
    timeout: config.timeout || 120000,
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
    response_format: { type: 'json_object' },
  });

  return response.data.choices[0].message.content;
}

// ============================================================
// Step 4: 解析 LLM 输出
// ============================================================

function parseLLMOutput(raw: string, validIds: Set<number>): { entries: DirectoryEntry[]; warnings: string[] } {
  const warnings: string[] = [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No valid JSON found in LLM output');
    parsed = JSON.parse(match[0]);
    warnings.push('JSON extracted from non-clean output');
  }

  const rawEntries = parsed.directory || parsed.chapters || parsed.entries;
  if (!Array.isArray(rawEntries)) throw new Error('Missing "directory" array');

  const entries: DirectoryEntry[] = [];
  let invalidCount = 0;

  for (const item of rawEntries) {
    const id = item.id;
    if (typeof id === 'number') {
      if (!validIds.has(id)) { invalidCount++; continue; }
    } else if (Array.isArray(id)) {
      if (typeof id[0] !== 'number' || !validIds.has(id[0])) { invalidCount++; continue; }
    } else { invalidCount++; continue; }

    const level = item.level;
    if (typeof level !== 'number' || level < 1 || level > 3) continue;

    entries.push({ id, level, title: (item.title ?? '').trim() });
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

  // 可配置的噪声模式
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
  ];

  return entries.filter(e => {
    const pid = Array.isArray(e.id) ? e.id[0] : e.id;
    const text = blockMap.get(pid)?.text ?? e.title;
    for (const p of noisePatterns) {
      if (p.test(text.trim())) {
        return false;
      }
    }
    // 空文本条目
    if (!text.trim() && !e.title.trim()) {
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
  const estTokens = Math.ceil(fullText.length / 2);
  console.log(`[ChapterPreprocess] 全文格式化: ${fullText.length} chars, ~${estTokens} tokens`);
  fs.writeFileSync(path.join(debugDir, 'chapter_full_text.txt'), fullText);

  const validIds = new Set(blocks.map(b => b.id));

  // ========== Step 2: 第一轮 LLM 抽取 ==========
  if (onProgress) await onProgress('章节预处理：第一轮 LLM 抽取（全文推理）...');
  const prompt1 = buildExtractionPrompt(fullText, blocks.length, totalPages);
  fs.writeFileSync(path.join(debugDir, 'chapter_prompt_round1.txt'), prompt1);

  let round1Entries: DirectoryEntry[] = [];
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

  if (round1Entries.length === 0) {
    console.warn('[ChapterPreprocess] 第一轮抽取失败，返回空结果');
    return {
      flatMap: [],
      blocks,
      coverageRate: 0,
      totalEntries: 0,
      round1Entries: 0,
      round2Entries: 0,
    };
  }

  // ========== Step 3: 后处理清理 ==========
  if (onProgress) await onProgress('章节预处理：清理噪声条目...');
  const cleaned = postProcessCleanup(round1Entries, blocks);
  console.log(`[ChapterPreprocess] 清理后: ${cleaned.length} entries (移除 ${round1Entries.length - cleaned.length} 个噪声)`);

  // ========== Step 4: 第二轮 LLM 校验修正 ==========
  if (onProgress) await onProgress('章节预处理：第二轮 LLM 校验修正...');
  const prompt2 = buildVerificationPrompt(cleaned, fullText, blocks.length, totalPages);
  fs.writeFileSync(path.join(debugDir, 'chapter_prompt_round2.txt'), prompt2);

  let finalEntries = cleaned;
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

  // 再次清理
  finalEntries = postProcessCleanup(finalEntries, blocks);

  // ========== Step 5: 构建 flat_map ==========
  if (onProgress) await onProgress('章节预处理：构建目录树...');
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
