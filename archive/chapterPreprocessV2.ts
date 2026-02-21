/**
 * 章节预处理模块 v2.0 — 自适应三轨混合架构
 * 
 * 核心思路：
 * 1. 轨道一 (TOC-Driven)：检测目录页，纯代码提取章节结构
 * 2. 轨道二 (Pattern-Driven)：基于正则模式在正文中定位章节标题锚点
 * 3. 轨道三 (LLM-Assisted)：逐页/小窗口 LLM 辅助发现章节边界
 * 4. 自适应调度器：根据文档特征选择最优轨道组合，融合结果
 * 
 * 设计原则：
 * - 代码优先，LLM 兜底：能用代码解决的绝不依赖 LLM
 * - 多信号交叉验证：不依赖单一信号源
 * - 优雅降级：每一层失败都有回退方案
 * - 与现有接口完全兼容：输出 ChapterFlatEntry[] 和 ChapterPreprocessResult
 * 
 * @module chapterPreprocessV2
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { flattenContentList, FlatBlock } from './blockFlattener';
import type { ChapterFlatEntry, ChapterLLMConfig, ChapterPreprocessResult } from './chapterPreprocess';

// ============================================================
// 类型定义
// ============================================================

/** 原始 block（与 content_list.json 结构对齐） */
interface RawBlock {
  type?: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  inside?: RawBlock[];
  [key: string]: any;
}

/** TOC 页面中提取的条目 */
interface TOCEntry {
  title: string;           // 标题文本
  pageNumber: number | null; // 目录中标注的页码（可能不准确）
  level: number;           // 推断的层级 (1=章, 2=节, 3=小节)
  sourceBlockId: number;   // 来源 Block ID
  sourcePage: number;      // 来源页码
}

/** 正文中检测到的章节锚点 */
interface AnchorPoint {
  blockId: number;         // Block ID
  page: number;            // 页码
  text: string;            // 原始文本
  normalizedTitle: string; // 标准化后的标题
  level: number;           // 推断的层级
  confidence: number;      // 置信度 (0-1)
  source: 'toc_match' | 'pattern' | 'llm'; // 主要来源
  sources?: string[];      // 多轨道融合时的所有来源
}

/** 调度器决策 */
interface DispatchDecision {
  useTOC: boolean;
  usePattern: boolean;
  useLLM: boolean;
  reason: string;
  tocPages?: number[];     // 检测到的 TOC 页面
}

function fixOCRSpacing(text: string): string {
  return text.replace(/(\d)([A-Z])/g, '$1 $2');
}

// ============================================================
// 轨道一：TOC 驱动的纯代码章节定位
// ============================================================

/**
 * 检测文档中的目录页
 * 
 * 策略：
 * 1. 在前 30 页中寻找包含"Contents"/"Table of Contents"/"目录"的页面
 * 2. 验证该页面及后续页面是否包含大量"标题...页码"模式的条目
 * 3. 返回所有 TOC 页面的页码列表
 */
function detectTOCPages(blocks: FlatBlock[]): number[] {
  const tocPages: number[] = [];
  const maxSearchPage = 30; // 只在前30页搜索

  // 按页分组
  const pageMap = new Map<number, FlatBlock[]>();
  for (const b of blocks) {
    const p = b.page_idx ?? 0;
    if (p > maxSearchPage) continue;
    if (!pageMap.has(p)) pageMap.set(p, []);
    pageMap.get(p)!.push(b);
  }

  // TOC 标志词（清理前导符号后匹配）
  const tocMarkers = [
    /^contents$/i,
    /^table\s+of\s+contents$/i,
    /^目录$/,
    /^content$/i,
  ];

  /** 清理文本中的前导装饰符号（如 "> Contents" → "Contents"） */
  function cleanForMarkerMatch(text: string): string {
    return text.replace(/^[>\-–—•·*#\s]+/, '').trim();
  }

  // TOC 条目模式：标题 + 分隔符 + 页码
  // 关键改进：要求标题部分以字母或数字开头，排除版权页噪声
  const tocEntryPatterns = [
    /^\d+[\.\s][A-Z].{2,78}\s+\d{1,4}\s*$/,  // "1 Review of number concepts 1" / "1.1 Types 3"
    /^[A-Z].{2,78}\.{2,}\s*\d{1,4}\s*$/,       // "Introduction......5"
    /^\d+[\.\s][A-Z].{2,78}\.{2,}\s*\d{1,4}\s*$/, // "1. Introduction......5"
    /^(Chapter|Unit|Part|Topic|Section|Lesson)\s+.{1,60}\s+\d{1,4}\s*$/i, // "Unit 1 Project 148"
    /^(Past paper|Review|Practice|Glossary|Index|Appendix).{0,60}\s+\d{1,4}\s*$/i, // "Past paper questions 145"
  ];

  /** 版权页/前言页噪声模式（不应被识别为 TOC 条目） */
  const copyrightNoisePatterns = [
    /published/i,
    /edition/i,
    /ISBN/i,
    /copyright/i,
    /Cambridge University Press/i,
    /Printed in/i,
    /catalogue/i,
    /Assessment/i,
    /^\d+\s+\d+\s+\d+/,  // "20 19 18 17 16..." 印刷批次号
  ];

  /** 检查一个 block 是否匹配 TOC 条目模式（排除噪声） */
  function isTOCEntry(text: string): boolean {
    if (!text || text.length < 3) return false;
    // 先排除版权页噪声
    if (copyrightNoisePatterns.some(p => p.test(text))) return false;
    return tocEntryPatterns.some(p => p.test(text));
  }

  // 第一步：找到 TOC 标志页
  let tocStartPage = -1;
  for (const [page, pageBlocks] of pageMap) {
    for (const b of pageBlocks) {
      const rawText = (b.text ?? '').trim();
      const cleanedText = cleanForMarkerMatch(rawText);
      // 同时检查原始文本和清理后的文本
      if (tocMarkers.some(m => m.test(rawText) || m.test(cleanedText))) {
        // 验证：该页面或下一页确实有足够的 TOC 条目
        const thisPageEntries = pageBlocks.filter(pb => isTOCEntry((pb.text ?? '').trim())).length;
        const nextPageBlocks = pageMap.get(page + 1) ?? [];
        const nextPageEntries = nextPageBlocks.filter(pb => isTOCEntry((pb.text ?? '').trim())).length;
        if (thisPageEntries + nextPageEntries >= 5) {
          tocStartPage = page;
          break;
        }
      }
    }
    if (tocStartPage >= 0) break;
  }

  if (tocStartPage < 0) {
    // 没有找到明确的 TOC 标志，尝试启发式检测
    // 在前15页中寻找"条目密度"最高的连续页面
    for (const [page, pageBlocks] of pageMap) {
      if (page > 15) continue;
      const entryCount = pageBlocks.filter(b => isTOCEntry((b.text ?? '').trim())).length;
      // 提高阈值到 8+，避免版权页误报
      if (entryCount >= 8) {
        tocStartPage = page;
        break;
      }
    }
  }

  if (tocStartPage < 0) return [];

  // 第二步：从 TOC 起始页开始，向后扫描连续的 TOC 页
  tocPages.push(tocStartPage);
  for (let p = tocStartPage + 1; p <= Math.min(tocStartPage + 10, maxSearchPage); p++) {
    const pageBlocks = pageMap.get(p);
    if (!pageBlocks) break;
    
    const entryCount = pageBlocks.filter(b => {
      const text = (b.text ?? '').trim();
      return isTOCEntry(text) || /^\d+(\.\d+)*\s+[A-Z]/.test(text);
    }).length;

    // 如果条目密度下降到 3 以下，认为 TOC 结束
    if (entryCount < 3) break;
    tocPages.push(p);
  }

  return tocPages;
}

/**
 * 从 TOC 页面中提取章节条目
 * 
 * 解析每个 TOC 条目，提取标题和页码，推断层级
 */
function extractTOCEntries(blocks: FlatBlock[], tocPages: number[]): TOCEntry[] {
  const entries: TOCEntry[] = [];
  const tocPageSet = new Set(tocPages);

  const tocBlocks = blocks.filter(b => tocPageSet.has(b.page_idx ?? -1));

  // 版权页噪声过滤
  const copyrightNoise = [
    /published/i, /edition/i, /ISBN/i, /copyright/i,
    /Cambridge University Press/i, /Printed in/i, /catalogue/i,
    /Assessment/i, /^\d+\s+\d+\s+\d+/, /www\./i, /\.org/i,
    /Paperback/i, /Digital/i, /eBook/i, /NOTICE/i, /licence/i,
    /Printing House/i, /Liberty Plaza/i, /Williamstown/i,
    /Penang Road/i, /Jasola/i, /Singapore/i,
  ];

  for (const b of tocBlocks) {
    const text = (b.text ?? '').trim();
    if (!text || text.length < 2) continue;

    // 跳过 header/footer/page_number 类型的 block
    if (b.type === 'header' || b.type === 'footer' || b.type === 'page_number') continue;

    // 跳过 list 类型的空 block（MinerU 的 list 展开标记）
    if (b.type === 'list' && text.length < 3) continue;

    // 跳过 TOC 标题本身
    const cleaned = text.replace(/^[>\-\s]+/, '').trim();
    if (/^(table\s+of\s+)?contents?$/i.test(cleaned) || cleaned === '目录') continue;

    // 跳过版权页噪声
    if (copyrightNoise.some(p => p.test(text))) continue;

    // 尝试提取页码（末尾的数字）
    let title = text;
    let pageNum: number | null = null;

    // 模式1: "Title......123" 或 "Title   123"
    const pageMatch = text.match(/^(.+?)[\s.]{2,}(\d{1,4})\s*$/);
    if (pageMatch) {
      title = pageMatch[1].trim();
      pageNum = parseInt(pageMatch[2], 10);
    } else {
      // 模式2: "Title 123" (末尾空格+数字)
      const simpleMatch = text.match(/^(.+?)\s+(\d{1,4})\s*$/);
      if (simpleMatch && simpleMatch[1].length > 3) {
        title = simpleMatch[1].trim();
        pageNum = parseInt(simpleMatch[2], 10);
      }
    }

    // 清理标题中的前导编号和点号
    title = title.replace(/\.{2,}$/, '').trim();

    title = fixOCRSpacing(title);

    // 跳过太短或太长的标题
    if (title.length < 2 || title.length > 120) continue;

    // 跳过前言页条目（罗马数字页码或非章节内容）
    const frontMatterPatterns = [
      /^introduction(\s+[ivxlcdm]+)?$/i,  // "Introduction" 或 "Introduction viii"
      /^how\s+to\s+use/i,
      /^acknowledgement/i,
      /^preface$/i,
      /^foreword$/i,
      /^about\s+(this|the)/i,
      /^(note|key)\s+to/i,
    ];
    if (frontMatterPatterns.some(p => p.test(title))) continue;

    // 跳过纯 "Unit" 没有编号的条目（它们是分组标记，不是章节标题）
    if (/^unit\s*$/i.test(title)) continue;

    // 推断层级
    const level = inferTOCLevel(title);

    entries.push({
      title,
      pageNumber: pageNum,
      level,
      sourceBlockId: b.id,
      sourcePage: b.page_idx ?? 0,
    });
  }

  return entries;
}

/**
 * 推断 TOC 条目的层级
 * 
 * 基于编号模式和缩进推断：
 * - "Chapter X" / "Unit X" / 纯数字 "X" → level 1
 * - "X.Y" → level 2
 * - "X.Y.Z" → level 3
 */
function inferTOCLevel(title: string): number {
  // 先检查是否有明确的编号
  const cleaned = title.trim();

  // "Chapter X" / "Unit X" / "Part X" → level 1
  if (/^(chapter|unit|part|module|topic)\s+\d/i.test(cleaned)) return 1;

  // "X.Y.Z" → level 3
  if (/^\d+\.\d+\.\d+/.test(cleaned)) return 3;

  // "X.Y" → level 2
  if (/^\d+\.\d+/.test(cleaned)) return 2;

  // 纯数字开头 "X " → level 1
  if (/^\d+\s+[A-Z]/.test(cleaned)) return 1;

  // "Section X" / "Lesson X" → level 2
  if (/^(section|lesson)\s+/i.test(cleaned)) return 2;

  // "Exercise X.Y" → level 3（习题是章节下的子单元）
  if (/^exercise\s+/i.test(cleaned)) return 3;

  // "Review" / "Practice" → level 2
  if (/^(review|practice)\s+/i.test(cleaned)) return 2;

  // "Past paper questions" / "Glossary" / "Index" → level 1
  if (/^(past paper|glossary|index|appendix)/i.test(cleaned)) return 1;

  // 默认 level 1
  return 1;
}

/**
 * 将 TOC 条目与正文中的 Block 进行匹配，确定插入点
 * 
 * 核心策略：
 * 1. 精确匹配：在预期页码附近（±3页）搜索完全包含 TOC 标题文本的 Block
 * 2. 模糊匹配：使用编辑距离或子串匹配
 * 3. 页码推断：如果文本匹配失败，使用页码范围推断边界
 */
function matchTOCToBody(
  tocEntries: TOCEntry[],
  blocks: FlatBlock[],
  tocPages: number[]
): AnchorPoint[] {
  const anchors: AnchorPoint[] = [];
  const tocPageSet = new Set(tocPages);
  
  // 构建页码到 Block 的索引（排除 TOC 页面本身）
  const bodyBlocks = blocks.filter(b => !tocPageSet.has(b.page_idx ?? -1));
  const pageIndex = new Map<number, FlatBlock[]>();
  for (const b of bodyBlocks) {
    const p = b.page_idx ?? 0;
    if (!pageIndex.has(p)) pageIndex.set(p, []);
    pageIndex.get(p)!.push(b);
  }

  // 计算页码偏移量（TOC 中的页码 vs 实际 page_idx 的偏差）
  // 通过前几个能精确匹配的条目来校准
  let pageOffset = estimatePageOffset(tocEntries, bodyBlocks);

  for (const toc of tocEntries) {
    let bestMatch: AnchorPoint | null = null;

    // 确定搜索范围
    const expectedPage = toc.pageNumber !== null ? toc.pageNumber + pageOffset : -1;
    const searchRange = 5; // ±5 页

    // 收集搜索范围内的 blocks
    const candidateBlocks: FlatBlock[] = [];
    if (expectedPage >= 0) {
      for (let p = expectedPage - searchRange; p <= expectedPage + searchRange; p++) {
        const pBlocks = pageIndex.get(p);
        if (pBlocks) candidateBlocks.push(...pBlocks);
      }
    } else {
      // 没有页码信息，搜索全部正文 blocks
      candidateBlocks.push(...bodyBlocks);
    }

    // 策略1：精确子串匹配
    const normalizedTocTitle = normalizeTitle(toc.title);
    for (const b of candidateBlocks) {
      const blockText = normalizeTitle(b.text ?? '');
      if (!blockText) continue;

      // 完全匹配或包含匹配
      if (blockText === normalizedTocTitle || 
          blockText.includes(normalizedTocTitle) ||
          normalizedTocTitle.includes(blockText)) {
        const similarity = computeSimilarity(normalizedTocTitle, blockText);
        if (similarity > (bestMatch?.confidence ?? 0)) {
          bestMatch = {
            blockId: b.id,
            page: b.page_idx ?? 0,
            text: b.text ?? '',
            normalizedTitle: toc.title,
            level: toc.level,
            confidence: similarity,
            source: 'toc_match',
          };
        }
      }
    }

    // 策略2：编号前缀匹配（如 TOC 说 "7.1 Fractions"，正文有 "7.1 Fractions and decimals"）
    if (!bestMatch || bestMatch.confidence < 0.8) {
      const numberPrefix = toc.title.match(/^(\d+(?:\.\d+)*)\s*/);
      if (numberPrefix) {
        const prefix = numberPrefix[1];
        for (const b of candidateBlocks) {
          const blockText = (b.text ?? '').trim();
          // Block 文本以相同编号开头
          if (blockText.startsWith(prefix + ' ') || blockText.startsWith(prefix + '.')) {
            const similarity = computeSimilarity(normalizeTitle(toc.title), normalizeTitle(blockText));
            if (similarity > (bestMatch?.confidence ?? 0.5)) {
              bestMatch = {
                blockId: b.id,
                page: b.page_idx ?? 0,
                text: blockText,
                normalizedTitle: toc.title,
                level: toc.level,
                confidence: Math.max(similarity, 0.7),
                source: 'toc_match',
              };
            }
          }
        }
      }
    }

    // 策略3：模糊匹配（Jaccard 相似度）
    if (!bestMatch || bestMatch.confidence < 0.6) {
      for (const b of candidateBlocks) {
        const blockText = (b.text ?? '').trim();
        if (blockText.length < 3 || blockText.length > 200) continue;
        
        const similarity = computeSimilarity(normalizeTitle(toc.title), normalizeTitle(blockText));
        if (similarity > 0.6 && similarity > (bestMatch?.confidence ?? 0)) {
          bestMatch = {
            blockId: b.id,
            page: b.page_idx ?? 0,
            text: blockText,
            normalizedTitle: toc.title,
            level: toc.level,
            confidence: similarity,
            source: 'toc_match',
          };
        }
      }
    }

    if (bestMatch) {
      anchors.push(bestMatch);
    } else if (toc.pageNumber !== null) {
      // 策略4：文本匹配全部失败，使用页码推断创建"虚拟锚点"
      // 找到该页码对应的第一个 block
      const adjustedPage = toc.pageNumber + pageOffset;
      const pageBlocks = pageIndex.get(adjustedPage) ?? pageIndex.get(adjustedPage + 1) ?? pageIndex.get(adjustedPage - 1);
      if (pageBlocks && pageBlocks.length > 0) {
        anchors.push({
          blockId: pageBlocks[0].id,
          page: pageBlocks[0].page_idx ?? 0,
          text: '',
          normalizedTitle: toc.title,
          level: toc.level,
          confidence: 0.4, // 低置信度，仅基于页码
          source: 'toc_match',
        });
      }
    }
  }

  return anchors;
}

/**
 * 估算 TOC 页码与实际 page_idx 之间的偏移量
 * 
 * 通过前几个能精确匹配的 TOC 条目来校准
 */
function estimatePageOffset(tocEntries: TOCEntry[], bodyBlocks: FlatBlock[]): number {
  const offsets: number[] = [];

  // 只用前 10 个有页码的条目来估算
  const withPageNum = tocEntries.filter(e => e.pageNumber !== null).slice(0, 10);

  for (const toc of withPageNum) {
    const normalizedTitle = normalizeTitle(toc.title);
    if (normalizedTitle.length < 3) continue;

    for (const b of bodyBlocks) {
      const blockText = normalizeTitle(b.text ?? '');
      if (!blockText) continue;

      const similarity = computeSimilarity(normalizedTitle, blockText);
      if (similarity > 0.8) {
        const actualPage = b.page_idx ?? 0;
        const offset = actualPage - toc.pageNumber!;
        offsets.push(offset);
        break; // 只取第一个匹配
      }
    }
  }

  if (offsets.length === 0) return 0;

  // 取众数作为偏移量
  const freq = new Map<number, number>();
  for (const o of offsets) {
    freq.set(o, (freq.get(o) ?? 0) + 1);
  }
  let bestOffset = 0;
  let bestCount = 0;
  for (const [offset, count] of freq) {
    if (count > bestCount) {
      bestOffset = offset;
      bestCount = count;
    }
  }

  return bestOffset;
}

// ============================================================
// 轨道二：模式驱动的纯代码章节定位
// ============================================================

/**
 * 基于正则模式在正文中检测章节标题锚点
 * 
 * 适用于无 TOC 页面的文档，或作为 TOC 轨道的补充验证
 */
function detectPatternAnchors(blocks: FlatBlock[], excludePages?: Set<number>): AnchorPoint[] {
  const anchors: AnchorPoint[]= [];
  // 排除 TOC 页面上的 blocks
  const filteredBlocks = excludePages && excludePages.size > 0
    ? blocks.filter(b => !excludePages.has(b.page_idx ?? -1))
    : blocks;

  // 章节标题模式库（按置信度排序）
  const patterns: Array<{
    regex: RegExp;
    level: number;
    confidence: number;
    name: string;
  }> = [
    // Level 1: 章级标题
    { regex: /^Chapter\s+\d/i, level: 1, confidence: 0.95, name: 'Chapter N' },
    { regex: /^Unit\s+\d/i, level: 1, confidence: 0.95, name: 'Unit N' },
    { regex: /^(Part|Module)\s+\d/i, level: 1, confidence: 0.90, name: 'Part/Module N' },
    { regex: /^Topic\s+\d/i, level: 1, confidence: 0.90, name: 'Topic N' },
    // 大写章节标题（仅匹配明确的章节关键词）
    { regex: /^(CHAPTER|UNIT|PART|MODULE|TOPIC)\s+\d/i, level: 1, confidence: 0.88, name: 'UPPERCASE CHAPTER/UNIT' },
    { regex: /^第[一二三四五六七八九十百千\d]+[章篇部]/, level: 1, confidence: 0.95, name: '第X章' },

    // Level 2: 节级标题
    { regex: /^(\d+)\.(\d+)\s+[A-Z]/, level: 2, confidence: 0.85, name: 'N.N Title' },
    { regex: /^Section\s+(\d+)/i, level: 2, confidence: 0.85, name: 'Section N' },
    { regex: /^Lesson\s+(\d+)/i, level: 2, confidence: 0.85, name: 'Lesson N' },
    { regex: /^Exercise\s+(\d+[\.\-]\d+)/i, level: 3, confidence: 0.80, name: 'Exercise N.N' },
    { regex: /^第[一二三四五六七八九十百千\d]+[节课]/, level: 2, confidence: 0.90, name: '第X节' },

    // Level 3: 小节级标题
    { regex: /^(\d+)\.(\d+)\.(\d+)\s+[A-Z]/, level: 3, confidence: 0.80, name: 'N.N.N Title' },

    // 特殊结构标题（复习、测试等）
    { regex: /^(Mid-?Chapter|End.of.Chapter)\s+(Review|Test|Quiz)/i, level: 2, confidence: 0.85, name: 'Review/Test' },
    { regex: /^(Review|Practice|Assessment)\s+(Exercise|Test|Quiz)/i, level: 2, confidence: 0.75, name: 'Practice' },
    { regex: /^(Cumulative\s+)?Review/i, level: 2, confidence: 0.70, name: 'Review' },
  ];

  for (const b of filteredBlocks) {
    const text = (b.text ?? '').trim();
    if (!text || text.length < 3 || text.length > 200) continue;

    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        // 额外验证：排除明显的噪声
        if (isNoisyTitle(text)) continue;

        // 检查是否是 MinerU 标记的 header 类型或有 text_level
        let adjustedConfidence = pattern.confidence;
        if (b.type === 'header') adjustedConfidence = Math.min(adjustedConfidence + 0.05, 1.0);
        if (b.text_level === 1) adjustedConfidence = Math.min(adjustedConfidence + 0.03, 1.0);

        anchors.push({
          blockId: b.id,
          page: b.page_idx ?? 0,
          text,
          normalizedTitle: text,
          level: pattern.level,
          confidence: adjustedConfidence,
          source: 'pattern',
        });
        break; // 一个 block 只匹配第一个（最高优先级）模式
      }
    }
  }

  return anchors;
}

/**
 * 检查文本是否是噪声标题（不应被识别为章节标题）
 */
function isNoisyTitle(text: string): boolean {
  const noisePatterns = [
    // 题目标签（如 "Question 1", "1. Find the..."）
    /^(Question|Problem|Q)\s*\d/i,
    /^\d+\.\s+(Find|Calculate|Solve|Determine|Evaluate|Simplify|Write|Show|Prove|Given)/i,
    // 选项标签
    /^[A-E]\.\s/,
    /^\([a-e]\)/,
    // 图表标签
    /^(Figure|Table|Diagram|Graph)\s+\d/i,
    // 页眉页脚残留
    /^Page\s+\d/i,
    /^\d+\s*$/,
    // 答案/解析标签
    /^(Answer|Solution|Hint|Explanation)/i,
    // 教材内容标签（不是章节标题）
    /^(EXAMPLE|STEP|TRY IT|DO YOU|FOCUS ON|LOOK FOR|PRACTICE|APPLY|ASSESS|COMMON ERROR)\s/i,
    /^(Example|Step)\s+\d/i,
  ];

  return noisePatterns.some(p => p.test(text.trim()));
}

// ============================================================
// 轨道三：LLM 滑动窗口辅助发现
// ============================================================

/**
 * 使用 LLM 逐页/小窗口扫描，发现代码无法检测的章节边界
 * 
 * 策略：
 * - 将文档按页分组，每次发送 3-5 页的内容给 LLM
 * - LLM 只需回答：这几页中是否存在章节边界？如果有，在哪个 Block？
 * - 这是一个简单的分类任务，LLM 准确率高
 */
async function detectLLMAnchors(
  blocks: FlatBlock[],
  existingAnchors: AnchorPoint[],
  llmConfig: ChapterLLMConfig,
  debugDir: string,
  onProgress?: (message: string) => Promise<void>
): Promise<AnchorPoint[]> {
  const anchors: AnchorPoint[] = [];
  
  // 按页分组
  const pageMap = new Map<number, FlatBlock[]>();
  for (const b of blocks) {
    const p = b.page_idx ?? 0;
    if (!pageMap.has(p)) pageMap.set(p, []);
    pageMap.get(p)!.push(b);
  }
  const allPages = Array.from(pageMap.keys()).sort((a, b) => a - b);
  
  // 确定需要 LLM 扫描的区域：排除已有高置信度锚点覆盖的区域
  const coveredPages = new Set<number>();
  for (const a of existingAnchors) {
    if (a.confidence >= 0.7) {
      // 标记锚点前后各 3 页为"已覆盖"
      for (let p = a.page - 3; p <= a.page + 3; p++) {
        coveredPages.add(p);
      }
    }
  }

  // 找出未覆盖的"间隙区域"
  const gapRegions: Array<{ startPage: number; endPage: number }> = [];
  let gapStart = -1;
  for (const page of allPages) {
    if (!coveredPages.has(page)) {
      if (gapStart < 0) gapStart = page;
    } else {
      if (gapStart >= 0) {
        gapRegions.push({ startPage: gapStart, endPage: page - 1 });
        gapStart = -1;
      }
    }
  }
  if (gapStart >= 0) {
    gapRegions.push({ startPage: gapStart, endPage: allPages[allPages.length - 1] });
  }

  // 如果间隙区域太少或太小，跳过 LLM 扫描
  const significantGaps = gapRegions.filter(g => g.endPage - g.startPage >= 5);
  if (significantGaps.length === 0) {
    console.log('[ChapterV2:LLM] No significant gaps to scan, skipping LLM track');
    return anchors;
  }

  console.log(`[ChapterV2:LLM] Found ${significantGaps.length} significant gaps to scan`);

  // 对每个间隙区域，使用滑动窗口进行 LLM 扫描
  const windowSize = 5; // 每次 5 页
  const stride = 3;     // 步长 3 页（有重叠）
  let windowIndex = 0;

  for (const gap of significantGaps) {
    for (let startPage = gap.startPage; startPage <= gap.endPage; startPage += stride) {
      const endPage = Math.min(startPage + windowSize - 1, gap.endPage);
      
      // 收集窗口内的 blocks
      const windowBlocks: FlatBlock[] = [];
      for (let p = startPage; p <= endPage; p++) {
        const pBlocks = pageMap.get(p);
        if (pBlocks) windowBlocks.push(...pBlocks);
      }

      if (windowBlocks.length === 0) continue;

      windowIndex++;
      if (onProgress && windowIndex % 10 === 0) {
        await onProgress(`章节预处理(LLM)：扫描窗口 ${windowIndex}...`);
      }

      try {
        const windowAnchors = await scanWindowWithLLM(
          windowBlocks, startPage, endPage, llmConfig, debugDir, windowIndex
        );
        anchors.push(...windowAnchors);
      } catch (err: any) {
        console.warn(`[ChapterV2:LLM] Window ${windowIndex} (pages ${startPage}-${endPage}) failed: ${err.message}`);
      }
    }
  }

  return anchors;
}

/**
 * 对单个窗口进行 LLM 扫描
 */
async function scanWindowWithLLM(
  windowBlocks: FlatBlock[],
  startPage: number,
  endPage: number,
  llmConfig: ChapterLLMConfig,
  debugDir: string,
  windowIndex: number
): Promise<AnchorPoint[]> {
  // 格式化窗口内容
  const lines: string[] = [];
  for (const b of windowBlocks) {
    const text = (b.text ?? '').trim();
    if (!text) continue;
    lines.push(`[Block ${b.id}, Page ${b.page_idx}] ${text}`);
  }

  const prompt = `You are analyzing a section of an educational textbook (pages ${startPage}-${endPage}).

Your task: Identify any CHAPTER or SECTION headings in the following text blocks.

A chapter/section heading is a structural title that organizes the book's content, such as:
- "Chapter 5 Geometry"
- "5.1 Angles and Lines"  
- "Review Exercise"
- "Topic 3 Algebra"

Do NOT identify these as headings:
- Individual question numbers ("1.", "Question 3")
- Answer labels ("A.", "(a)")
- Figure/table captions
- Page numbers

TEXT BLOCKS:
${lines.join('\n')}

RESPOND in JSON format:
{
  "headings": [
    {"block_id": <number>, "title": "<heading text>", "level": <1|2|3>}
  ]
}

If no headings are found, respond: {"headings": []}`;

  const response = await callLLM(prompt, llmConfig);
  
  // 保存调试信息（每10个窗口保存一次）
  if (windowIndex <= 5 || windowIndex % 10 === 0) {
    const debugFile = path.join(debugDir, `llm_window_${windowIndex}.txt`);
    fs.writeFileSync(debugFile, `PROMPT:\n${prompt}\n\nRESPONSE:\n${response}`);
  }

  // 解析响应
  const anchors: AnchorPoint[] = [];
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.headings)) {
        const validBlockIds = new Set(windowBlocks.map(b => b.id));
        for (const h of parsed.headings) {
          if (typeof h.block_id === 'number' && validBlockIds.has(h.block_id)) {
            anchors.push({
              blockId: h.block_id,
              page: windowBlocks.find(b => b.id === h.block_id)?.page_idx ?? startPage,
              text: h.title ?? '',
              normalizedTitle: h.title ?? '',
              level: h.level ?? 1,
              confidence: 0.65, // LLM 发现的置信度适中
              source: 'llm',
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[ChapterV2:LLM] Failed to parse window ${windowIndex} response`);
  }

  return anchors;
}

// ============================================================
// 自适应调度器
// ============================================================

/**
 * 分析文档特征，决定使用哪些轨道
 */
function dispatch(blocks: FlatBlock[], tocPages: number[]): DispatchDecision {
  const hasTOC = tocPages.length > 0;
  const totalPages = Math.max(...blocks.map(b => b.page_idx ?? 0)) + 1;

  if (hasTOC) {
    return {
      useTOC: true,
      usePattern: true,  // 始终用模式匹配做交叉验证
      useLLM: false,     // 有 TOC 时通常不需要 LLM
      reason: `检测到 TOC 页面 (pages ${tocPages.join(',')}), 使用 TOC+Pattern 双轨道`,
      tocPages,
    };
  }

  // 无 TOC 页面
  if (totalPages <= 50) {
    return {
      useTOC: false,
      usePattern: true,
      useLLM: true,      // 小文档，LLM 扫描成本低
      reason: `无 TOC, 小文档 (${totalPages} pages), 使用 Pattern+LLM 双轨道`,
    };
  }

  return {
    useTOC: false,
    usePattern: true,
    useLLM: true,        // 大文档也用 LLM，但只扫描间隙区域
    reason: `无 TOC, 大文档 (${totalPages} pages), 使用 Pattern+LLM 双轨道（LLM 仅扫描间隙）`,
  };
}

// ============================================================
// 锚点融合与目录树构建
// ============================================================

/**
 * 融合来自多个轨道的锚点，去重并解决冲突
 */
function mergeAnchors(allAnchors: AnchorPoint[]): AnchorPoint[] {
  if (allAnchors.length === 0) return [];

  // 按 blockId 分组
  const byBlock = new Map<number, AnchorPoint[]>();
  for (const a of allAnchors) {
    if (!byBlock.has(a.blockId)) byBlock.set(a.blockId, []);
    byBlock.get(a.blockId)!.push(a);
  }

  const merged: AnchorPoint[] = [];
  for (const [, group] of byBlock) {
    if (group.length === 1) {
      merged.push(group[0]);
    } else {
      // 多个轨道都发现了同一个 Block，取置信度最高的，但提升其置信度
      group.sort((a, b) => b.confidence - a.confidence);
      const best = { ...group[0] };
      // 多源验证加分
      best.confidence = Math.min(best.confidence + 0.1 * (group.length - 1), 1.0);
      best.sources = group.map(g => g.source);
      merged.push(best);
    }
  }

  // 按 blockId 排序
  merged.sort((a, b) => a.blockId - b.blockId);

  // 过滤明显的误报："Chapter N" 后跟的是句子而不是标题
  const postFiltered = merged.filter(a => {
    const text = a.text.trim();
    // "Chapter 1 if you need some suggestions..." → 误报
    if (/^Chapter\s+\d+\s+\w{2,}/i.test(text) && text.length > 30) return false;
    return true;
  });

  // 合并相邻的 "Chapter N" 和 "N Title" 重复锚点
  // 例如 Block 301 "Chapter 1" + Block 302 "1 Review of number concepts" → 只保留后者
  const deduped: AnchorPoint[] = [];
  for (let i = 0; i < postFiltered.length; i++) {
    const curr = postFiltered[i];
    const next = postFiltered[i + 1];
    
    if (next && curr.level === next.level && next.blockId - curr.blockId <= 2) {
      // 检查是否是 "Chapter N" + "N Title" 模式
      const currIsChapterLabel = /^(Chapter|Unit|Part|Topic)\s+\d+\s*$/i.test(curr.text.trim());
      if (currIsChapterLabel) {
        // 跳过 "Chapter N"，保留带标题的下一个
        continue;
      }
    }
    deduped.push(curr);
  }

  // 去除过于密集的锚点（同一页面内不应有超过 3 个同级锚点）
  const filtered: AnchorPoint[] = [];
  const pageCountByLevel = new Map<string, number>();
  for (const a of deduped) {
    const key = `${a.page}_${a.level}`;
    const count = pageCountByLevel.get(key) ?? 0;
    if (count < 3) {
      filtered.push(a);
      pageCountByLevel.set(key, count + 1);
    }
  }

  return filtered;
}

/**
 * 从锚点列表构建 ChapterFlatEntry[] 目录树
 * 
 * 核心逻辑：
 * 1. 每个锚点的 startBlockId = 锚点的 blockId
 * 2. 每个锚点的 endBlockId = 下一个同级或更高级锚点的 blockId
 * 3. 构建父子关系
 */
function buildChapterTree(
  anchors: AnchorPoint[],
  blocks: FlatBlock[]
): ChapterFlatEntry[] {
  if (anchors.length === 0) return [];

  const totalBlocks = blocks.length;
  const entries: ChapterFlatEntry[] = [];

  // 按 blockId 排序
  const sorted = [...anchors].sort((a, b) => a.blockId - b.blockId);

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    
    // 确定 endBlockId：找到下一个同级或更高级的锚点
    let endBlockId = totalBlocks; // 默认到文档末尾
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].level <= anchor.level) {
        endBlockId = sorted[j].blockId;
        break;
      }
    }

    // 确定父节点
    let parentId: number | null = null;
    if (anchor.level > 1) {
      // 向前搜索最近的更高级别锚点
      for (let j = i - 1; j >= 0; j--) {
        if (sorted[j].level < anchor.level) {
          parentId = j; // 使用索引作为临时 ID
          break;
        }
      }
    }

    entries.push({
      id: i,
      text: anchor.normalizedTitle || anchor.text,
      level: anchor.level,
      page: anchor.page,
      block_range: {
        start: anchor.blockId,
        end: endBlockId,
      },
      parent_id: parentId,
    });
  }

  return entries;
}

// ============================================================
// 辅助函数
// ============================================================

/** 标准化标题文本（用于比较） */
function normalizeTitle(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s\u4e00-\u9fff]/g, '') // 保留字母数字中文
    .trim();
}

/** 计算两个字符串的相似度 (Jaccard on words) */
function computeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 0));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 0));
  
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** 调用 LLM API */
async function callLLM(prompt: string, config: ChapterLLMConfig): Promise<string> {
  const client = axios.create({
    timeout: config.timeout ?? 120000,
  });
  axiosRetry(client, { retries: 2, retryDelay: axiosRetry.exponentialDelay });

  const response = await client.post(
    config.apiUrl,
    {
      model: config.modelName,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    },
    {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data?.choices?.[0]?.message?.content ?? '';
}

// ============================================================
// 主入口：自适应章节预处理
// ============================================================

/**
 * 自适应三轨混合章节预处理
 * 
 * 完全兼容现有的 ChapterPreprocessResult 接口，可直接替换 preprocessChapters
 */
export async function preprocessChaptersV2(
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
  if (onProgress) await onProgress('章节预处理V2：加载并展平 content_list.json...');
  const raw: RawBlock[] = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const blocks = flattenContentList(raw) as FlatBlock[];
  const totalPages = Math.max(...blocks.map(b => b.page_idx ?? 0)) + 1;
  console.log(`[ChapterV2] 展平: ${raw.length} 原始 → ${blocks.length} blocks, ${totalPages} pages`);

  // ========== Step 1: 检测 TOC 页面 ==========
  if (onProgress) await onProgress('章节预处理V2：检测目录页...');
  const tocPages = detectTOCPages(blocks);
  console.log(`[ChapterV2] TOC 检测: ${tocPages.length > 0 ? `发现 TOC 页面 [${tocPages.join(',')}]` : '未发现 TOC 页面'}`);

  // 保存 TOC 检测结果
  fs.writeFileSync(path.join(debugDir, 'v2_toc_detection.json'), JSON.stringify({
    tocPages,
    hasTOC: tocPages.length > 0,
  }, null, 2));

  // ========== Step 2: 自适应调度 ==========
  const decision = dispatch(blocks, tocPages);
  console.log(`[ChapterV2] 调度决策: ${decision.reason}`);
  
  fs.writeFileSync(path.join(debugDir, 'v2_dispatch_decision.json'), JSON.stringify(decision, null, 2));

  // ========== Step 3: 执行各轨道 ==========
  const allAnchors: AnchorPoint[] = [];

  // 轨道一：TOC 驱动
  if (decision.useTOC && tocPages.length > 0) {
    if (onProgress) await onProgress('章节预处理V2：轨道一 - TOC 驱动定位...');
    const tocEntries = extractTOCEntries(blocks, tocPages);
    console.log(`[ChapterV2:TOC] 提取 ${tocEntries.length} 个 TOC 条目`);
    
    fs.writeFileSync(path.join(debugDir, 'v2_toc_entries.json'), JSON.stringify(tocEntries, null, 2));

    const tocAnchors = matchTOCToBody(tocEntries, blocks, tocPages);
    console.log(`[ChapterV2:TOC] 匹配到 ${tocAnchors.length} 个锚点 (${tocAnchors.filter(a => a.confidence >= 0.8).length} 高置信度)`);
    
    fs.writeFileSync(path.join(debugDir, 'v2_toc_anchors.json'), JSON.stringify(tocAnchors, null, 2));
    allAnchors.push(...tocAnchors);
  }

  // 轨道二：模式驱动（排除 TOC 页面）
  const tocPageSet = new Set(tocPages);
  if (decision.usePattern) {
    if (onProgress) await onProgress('章节预处理V2：轨道二 - 模式驱动定位...');
    const patternAnchors = detectPatternAnchors(blocks, tocPageSet);
    console.log(`[ChapterV2:Pattern] 检测到 ${patternAnchors.length} 个模式锚点`);
    
    fs.writeFileSync(path.join(debugDir, 'v2_pattern_anchors.json'), JSON.stringify(patternAnchors, null, 2));
    allAnchors.push(...patternAnchors);
  }

  // 轨道三：LLM 辅助（仅在需要时）
  if (decision.useLLM) {
    if (onProgress) await onProgress('章节预处理V2：轨道三 - LLM 辅助扫描...');
    const llmAnchors = await detectLLMAnchors(blocks, allAnchors, llmConfig, debugDir, onProgress);
    console.log(`[ChapterV2:LLM] 发现 ${llmAnchors.length} 个 LLM 锚点`);
    
    fs.writeFileSync(path.join(debugDir, 'v2_llm_anchors.json'), JSON.stringify(llmAnchors, null, 2));
    allAnchors.push(...llmAnchors);
  }

  // ========== Step 4: 融合锚点 ==========
  if (onProgress) await onProgress('章节预处理V2：融合多轨道结果...');
  const mergedAnchors = mergeAnchors(allAnchors);
  console.log(`[ChapterV2] 融合后: ${mergedAnchors.length} 个锚点`);
  
  fs.writeFileSync(path.join(debugDir, 'v2_merged_anchors.json'), JSON.stringify(mergedAnchors, null, 2));

  // ========== Step 5: 构建目录树 ==========
  if (onProgress) await onProgress('章节预处理V2：构建目录树...');
  const flatMap = buildChapterTree(mergedAnchors, blocks);
  console.log(`[ChapterV2] 目录树: ${flatMap.length} 个条目`);

  // 计算覆盖率
  let coveredBlocks = 0;
  for (const entry of flatMap) {
    coveredBlocks += entry.block_range.end - entry.block_range.start;
  }
  // 去重（因为子章节可能与父章节重叠）
  const coveredSet = new Set<number>();
  for (const entry of flatMap) {
    for (let i = entry.block_range.start; i < entry.block_range.end; i++) {
      coveredSet.add(i);
    }
  }
  const coverageRate = blocks.length > 0 ? coveredSet.size / blocks.length : 0;

  // 保存结果
  fs.writeFileSync(path.join(debugDir, 'chapter_flat_map.json'), JSON.stringify(flatMap, null, 2));

  // 打印目录树
  for (const entry of flatMap) {
    const indent = '  '.repeat(entry.level - 1);
    const tag = `L${entry.level}`;
    console.log(`[ChapterV2] ${indent}${tag} p.${entry.page} | ${entry.text.substring(0, 70)} [${entry.block_range.start}-${entry.block_range.end})`);
  }

  console.log(`[ChapterV2] 覆盖率: ${(coverageRate * 100).toFixed(1)}%`);

  return {
    flatMap,
    blocks,
    coverageRate,
    totalEntries: flatMap.length,
    round1Entries: allAnchors.length,
    round2Entries: mergedAnchors.length,
  };
}
