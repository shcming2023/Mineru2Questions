/**
 * v9.1: 零筛选全文推理方案（改进版）
 *
 * 核心改进：
 * 1. 不做任何候选筛选，全文交给 gemini-2.5-flash
 * 2. 保持 LLM 输出的逻辑顺序（不按 ID 排序）
 * 3. 强化后处理：合并碎片标题、修复层级、清理噪声条目
 * 4. 二次 LLM 校验：将首次结果反馈给 LLM 进行修正
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ============================================================
// 类型定义
// ============================================================

interface RawBlock {
  type?: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  inside?: RawBlock[];
  [key: string]: any;
}

interface FlatBlock {
  id: number;
  text: string;
  page: number;
  type: string;
  text_level: number | null;
}

interface ChapterFlatEntry {
  id: number;
  merged_ids?: number[];
  text: string;
  level: number;
  page: number;
  block_range: { start: number; end: number };
  parent_id: number | null;
}

interface DirectoryEntry {
  id: number | number[];
  level: number;
  title: string;
}

// ============================================================
// 配置
// ============================================================

const LLM_MODEL = 'gemini-2.5-flash';

// ============================================================
// Step 0: 展平 block 列表
// ============================================================

function flattenBlocks(raw: RawBlock[]): FlatBlock[] {
  const blocks: FlatBlock[] = [];
  let id = 0;

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const page = item.page_idx ?? 0;

    if (item.type === 'table' && Array.isArray(item.inside)) {
      for (const sub of item.inside) {
        blocks.push({
          id: id++,
          text: (sub.text ?? '').trim(),
          page,
          type: sub.type ?? 'text',
          text_level: sub.text_level ?? null,
        });
      }
    } else {
      blocks.push({
        id: id++,
        text: (item.text ?? '').trim(),
        page,
        type: item.type ?? 'text',
        text_level: item.text_level ?? null,
      });
    }
  }

  return blocks;
}

// ============================================================
// Step 1: 全文格式化
// ============================================================

function formatFullText(blocks: FlatBlock[]): string {
  const lines: string[] = [];

  for (const b of blocks) {
    if (!b.text) continue;
    const truncated = b.text.length > 150 ? b.text.substring(0, 150) + '...' : b.text;
    const typeTag = b.type === 'header' ? 'H' : (b.text_level === 1 ? 'T1' : '');
    const tag = typeTag ? `${b.id}|p${b.page}|${typeTag}` : `${b.id}|p${b.page}`;
    lines.push(`[${tag}] ${truncated}`);
  }

  return lines.join('\n');
}

// ============================================================
// Step 2: 构建 Prompt（第一轮：全文抽取）
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

// ============================================================
// Step 2b: 构建 Prompt（第二轮：校验修正）
// ============================================================

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
// Step 3: 调用 LLM
// ============================================================

async function callLLM(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 32000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error: ${response.status} ${err}`);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

// ============================================================
// Step 4: 解析 LLM 输出
// ============================================================

function parseLLMOutput(raw: string, validIds: Set<number>): { entries: DirectoryEntry[]; warnings: string[] } {
  const warnings: string[] = [];

  // JSON 解析（容错）
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
      // 对 merged IDs，只要求第一个 ID 有效
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

  // 噪声模式（这些不是结构标题）
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
        console.log(`  [POST] Removed noise: id=${pid} "${text.substring(0, 50)}"`);
        return false;
      }
    }
    // 空文本条目
    if (!text.trim() && !e.title.trim()) {
      console.log(`  [POST] Removed empty: id=${pid}`);
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
    const page = blockMap.get(primaryId)?.page ?? 0;

    // block_range：使用排序后的最小 ID 作为 start
    const minId = Math.min(...allIds);
    const start = minId;

    // end：下一个条目的最小 ID，或 totalBlocks
    let end: number;
    if (i + 1 < entries.length) {
      const nextIds = Array.isArray(entries[i + 1].id) ? entries[i + 1].id as number[] : [entries[i + 1].id as number];
      end = Math.min(...nextIds);
    } else {
      end = totalBlocks;
    }

    // 如果 start > end（因为 Mineru 解析顺序问题），调整
    if (start >= end && i + 1 < entries.length) {
      // 这个条目的实际内容范围可能很小
      const nextStart = end;
      // 找到这个条目在 blocks 中实际覆盖的范围
      end = start + 1; // 最小范围
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

function validateCompleteness(flatMap: ChapterFlatEntry[], totalBlocks: number) {
  if (flatMap.length === 0) return { covered: 0, uncovered: totalBlocks, coverageRate: 0 };

  // 计算所有 block_range 覆盖的 block 数
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
// Step 8: 标准目录对比（八上数学专用）
// ============================================================

function compareWithStandard(flatMap: ChapterFlatEntry[]): void {
  const standardPatterns: { label: string; pattern: string }[] = [
    { label: '第19章', pattern: '第19章' },
    { label: '19.1 节标题', pattern: '19\\.1\\s' },
    { label: '19.1(一)', pattern: '19\\.1.*[（(]一[）)]' },
    { label: '19.1(二)', pattern: '19\\.1.*[（(]二[）)]' },
    { label: '19.1(三)', pattern: '19\\.1.*[（(]三[）)]' },
    { label: '阶段训练①', pattern: '阶段训练.*[①1]' },
    { label: '19.2 节标题', pattern: '19\\.2\\s' },
    { label: '19.2(一)', pattern: '19\\.2.*[（(]一[）)]' },
    { label: '阶段训练②', pattern: '阶段训练.*[②2]' },
    { label: '本章复习题-ch19', pattern: '本章复习题' },
    { label: '第20章', pattern: '第20章' },
    { label: '20.1 节标题', pattern: '20\\.1\\s' },
    { label: '20.1(一)', pattern: '20\\.1.*[（(]一[）)]' },
    { label: '20.1(二)', pattern: '20\\.1.*[（(]二[）)]' },
    { label: '阶段训练③', pattern: '阶段训练.*[③3]' },
    { label: '20.2 节标题', pattern: '20\\.2\\s' },
    { label: '20.2(二)', pattern: '20\\.2.*[（(]二[）)]' },
    { label: '20.2(三)', pattern: '20\\.2.*[（(]三[）)]' },
    { label: '20.2(四)', pattern: '20\\.2.*[（(]四[）)]' },
    { label: '阶段训练④', pattern: '阶段训练.*[④4]' },
    { label: '本章复习题-ch20', pattern: '本章复习题' },
    { label: '第21章', pattern: '第21章' },
    { label: '21.1 节标题', pattern: '21\\.1\\s' },
    { label: '21.2 节标题', pattern: '21\\.2\\s' },
    { label: '21.2(三)', pattern: '21\\.2.*[（(]三[）)]' },
    { label: '21.2(四)', pattern: '21\\.2.*[（(]四[）)]' },
    { label: '21.2(五)', pattern: '21\\.2.*[（(]五[）)]' },
    { label: '阶段训练⑤', pattern: '阶段训练.*[⑤5]' },
    { label: '21.3 节标题', pattern: '21\\.3\\s' },
    { label: '21.4 节标题', pattern: '21\\.4\\s' },
    { label: '阶段训练⑥', pattern: '阶段训练.*[⑥6]' },
    { label: '21.5 节标题', pattern: '21\\.5\\s' },
    { label: '21.5(一)', pattern: '21\\.5.*[（(]一[）)]' },
    { label: '21.5(二)', pattern: '21\\.5.*[（(]二[）)]' },
    { label: '21.5(三)', pattern: '21\\.5.*[（(]三[）)]' },
    { label: '21.5(四)', pattern: '21\\.5.*[（(]四[）)]' },
    { label: '阶段训练⑦', pattern: '阶段训练.*[⑦7]' },
    { label: '本章复习题-ch21', pattern: '本章复习题' },
    { label: '第22章', pattern: '第22章' },
    { label: '22.1 节标题', pattern: '22\\.1\\s' },
    { label: '22.1(一)', pattern: '22\\.1.*[（(]一[）)]' },
    { label: '22.1(二)', pattern: '22\\.1.*[（(]二[）)]' },
    { label: '阶段训练⑧', pattern: '阶段训练.*[⑧8]' },
    { label: '22.2 节标题', pattern: '22\\.2\\s' },
    { label: '22.2(二)', pattern: '22\\.2.*[（(]二[）)]' },
    { label: '22.3 节标题', pattern: '22\\.3\\s' },
    { label: '22.3(二)', pattern: '22\\.3.*[（(]二[）)]' },
    { label: '22.3(三)', pattern: '22\\.3.*[（(]三[）)]' },
    { label: '22.3(四)', pattern: '22\\.3.*[（(]四[）)]' },
    { label: '阶段训练⑨', pattern: '阶段训练.*[⑨9]' },
    { label: '本章复习题-ch22', pattern: '本章复习题' },
    { label: '期末测试卷A', pattern: '期末测试卷.*A' },
    { label: '期末测试卷B', pattern: '期末测试卷.*B' },
  ];

  const extractedTexts = flatMap.map(e => e.text);
  let matched = 0;
  const missing: string[] = [];
  const usedIndices = new Set<number>();

  for (const sp of standardPatterns) {
    const regex = new RegExp(sp.pattern);
    let found = false;
    for (let i = 0; i < extractedTexts.length; i++) {
      if (usedIndices.has(i)) continue;
      if (regex.test(extractedTexts[i])) {
        usedIndices.add(i);
        found = true;
        break;
      }
    }
    if (found) matched++;
    else missing.push(sp.label);
  }

  console.log(`\n=== 标准目录对比 ===`);
  console.log(`匹配: ${matched}/${standardPatterns.length} (${(matched / standardPatterns.length * 100).toFixed(1)}%)`);
  if (missing.length > 0) {
    console.log(`缺失 (${missing.length}):`);
    for (const m of missing) console.log(`  - ${m}`);
  }
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npx tsx v5_llm_toc.ts <path_to_content_list.json>');
    process.exit(1);
  }

  const outputDir = join(dirname(inputPath), 'v9_output');
  mkdirSync(outputDir, { recursive: true });

  console.log('=== v9.1: 零筛选全文推理 + 二次校验（gemini-2.5-flash）===\n');
  console.log(`输入: ${inputPath}`);
  console.log(`模型: ${LLM_MODEL}`);

  // Step 0: 展平
  const raw: RawBlock[] = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const blocks = flattenBlocks(raw);
  const totalPages = Math.max(...blocks.map(b => b.page)) + 1;
  console.log(`[Step 0] 展平: ${raw.length} 原始 → ${blocks.length} blocks, ${totalPages} pages`);

  // Step 1: 全文格式化
  const fullText = formatFullText(blocks);
  const estTokens = Math.ceil(fullText.length / 2);
  console.log(`[Step 1] 全文格式化: ${fullText.length} chars, ~${estTokens} tokens`);
  writeFileSync(join(outputDir, 'full_text.txt'), fullText);

  const validIds = new Set(blocks.map(b => b.id));

  // ========== 第一轮：全文抽取 ==========
  console.log(`\n[Step 2] 第一轮 LLM 抽取...`);
  const prompt1 = buildExtractionPrompt(fullText, blocks.length, totalPages);
  writeFileSync(join(outputDir, 'prompt_round1.txt'), prompt1);

  let round1Entries: DirectoryEntry[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const startTime = Date.now();
      const llmRaw = await callLLM(prompt1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Round 1 attempt ${attempt}: ${elapsed}s, ${llmRaw.length} chars`);
      writeFileSync(join(outputDir, `llm_round1_attempt${attempt}.json`), llmRaw);

      const { entries, warnings } = parseLLMOutput(llmRaw, validIds);
      for (const w of warnings) console.warn(`  [WARN] ${w}`);
      round1Entries = entries;
      console.log(`  解析: ${entries.length} 条目 (L1=${entries.filter(e => e.level === 1).length}, L2=${entries.filter(e => e.level === 2).length}, L3=${entries.filter(e => e.level === 3).length})`);
      break;
    } catch (err: any) {
      console.error(`  Round 1 attempt ${attempt} failed: ${err.message}`);
    }
  }

  if (round1Entries.length === 0) {
    console.error('第一轮抽取失败');
    process.exit(1);
  }

  // ========== 后处理清理 ==========
  console.log(`\n[Step 3] 后处理清理...`);
  const cleaned = postProcessCleanup(round1Entries, blocks);
  console.log(`  清理后: ${cleaned.length} 条目 (移除 ${round1Entries.length - cleaned.length} 个噪声)`);

  // ========== 第二轮：校验修正 ==========
  console.log(`\n[Step 4] 第二轮 LLM 校验修正...`);
  const prompt2 = buildVerificationPrompt(cleaned, fullText, blocks.length, totalPages);
  writeFileSync(join(outputDir, 'prompt_round2.txt'), prompt2);

  let finalEntries = cleaned;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const startTime = Date.now();
      const llmRaw = await callLLM(prompt2);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Round 2 attempt ${attempt}: ${elapsed}s, ${llmRaw.length} chars`);
      writeFileSync(join(outputDir, `llm_round2_attempt${attempt}.json`), llmRaw);

      const { entries, warnings } = parseLLMOutput(llmRaw, validIds);
      for (const w of warnings) console.warn(`  [WARN] ${w}`);

      if (entries.length >= cleaned.length * 0.8) {
        // 校验结果合理（没有大幅删减）
        finalEntries = entries;
        console.log(`  校验后: ${entries.length} 条目 (L1=${entries.filter(e => e.level === 1).length}, L2=${entries.filter(e => e.level === 2).length}, L3=${entries.filter(e => e.level === 3).length})`);
      } else {
        console.warn(`  校验结果条目过少 (${entries.length} < ${Math.floor(cleaned.length * 0.8)})，保留第一轮结果`);
      }
      break;
    } catch (err: any) {
      console.error(`  Round 2 attempt ${attempt} failed: ${err.message}`);
    }
  }

  // ========== 再次清理 ==========
  finalEntries = postProcessCleanup(finalEntries, blocks);

  // ========== 构建 flat_map ==========
  console.log(`\n[Step 5] 构建 flat_map...`);
  const flatMap = buildFlatMap(finalEntries, blocks);
  console.log(`  ${flatMap.length} 条目`);

  // 完整性校验
  const comp = validateCompleteness(flatMap, blocks.length);
  console.log(`[Step 6] 覆盖率: ${(comp.coverageRate * 100).toFixed(1)}% (covered=${comp.covered}, uncovered=${comp.uncovered})`);

  writeFileSync(join(outputDir, 'chapter_flat_map.json'), JSON.stringify(flatMap, null, 2));

  // 打印目录树
  console.log(`\n=== 目录树 ===`);
  for (const entry of flatMap) {
    const indent = '  '.repeat(entry.level - 1);
    const tag = `L${entry.level}`;
    const merge = entry.merged_ids ? ` [merged: ${entry.merged_ids.join('+')}]` : '';
    console.log(`${indent}${tag} p.${entry.page} | ${entry.text.substring(0, 70)}${merge} [${entry.block_range.start}-${entry.block_range.end})`);
  }

  // 标准对比
  if (inputPath.includes('202602121048')) {
    compareWithStandard(flatMap);
  }

  console.log(`\n=== 完成 ===`);
  console.log(`输出: ${outputDir}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
