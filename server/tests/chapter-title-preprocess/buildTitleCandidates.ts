/**
 * 章节标题候选集构建模块 (v2)
 * 
 * 功能：从 Mineru 的 content_list.json 中，利用三路信号提取标题候选者：
 *   1. type 信号：type === 'header'
 *   2. text_level 信号：text_level === 1
 *   3. 正则模式信号：匹配常见的教育文本章节标题模式
 * 
 * v2 改进：
 *   - 增加标题破碎合并（如 "期末测试卷" + "A卷" → "期末测试卷A卷"）
 *   - 改进目录页条目过滤规则
 *   - 保留更多上下文信息供 LLM 判断
 * 
 * 设计原则：
 *   - 宁可多选（高召回），不可遗漏（低精确率可由 LLM 后续修正）
 *   - 保留原始 block 的所有结构化信号，供 LLM 判断
 *   - 不做硬编码过滤，所有规则可配置
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= 类型定义 =============

/** Mineru content_list.json 中的原始 block */
export interface RawContentBlock {
  type: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  bbox?: number[];
  img_path?: string;
  list_items?: string[];
  sub_type?: string;
  [key: string]: any;
}

/** 带有全局 ID 的 block */
export interface IndexedBlock extends RawContentBlock {
  id: number;
}

/** 标题候选者 */
export interface TitleCandidate {
  id: number;
  text: string;
  page_idx: number;
  type: string;
  text_level?: number;
  signals: string[];
  merged_from?: number[];  // 如果是合并的，记录原始 block ID 列表
  context_before?: string;
  context_after?: string;
}

// ============= 可配置的正则模式库 =============

export const TITLE_PATTERNS: Array<{ name: string; pattern: RegExp; description: string }> = [
  // === 一级标题模式 ===
  {
    name: 'chapter_cn',
    pattern: /^第[一二三四五六七八九十百千\d]+章/,
    description: '中文章标题：第X章...'
  },
  {
    name: 'chapter_num',
    pattern: /^Chapter\s+\d+/i,
    description: '英文章标题：Chapter X...'
  },
  {
    name: 'unit_cn',
    pattern: /^第[一二三四五六七八九十百千\d]+单元/,
    description: '中文单元标题：第X单元...'
  },
  {
    name: 'module_cn',
    pattern: /^第[一二三四五六七八九十百千\d]+模块/,
    description: '中文模块标题：第X模块...'
  },

  // === 二级标题模式（节） ===
  {
    name: 'section_dotnum',
    pattern: /^\d+\.\d+\s+\S/,
    description: '数字节标题：X.Y 标题名'
  },
  {
    name: 'subsection_dotnum',
    pattern: /^\d+\.\d+[\(（][一二三四五六七八九十\d]+[\)）]/,
    description: '数字子节标题：X.Y(一) 标题名'
  },
  {
    name: 'section_cn',
    pattern: /^第[一二三四五六七八九十百千\d]+节/,
    description: '中文节标题：第X节...'
  },

  // === 功能性标题模式（教育文本特有） ===
  {
    name: 'exercise_section',
    pattern: /^(阶段训练|阶段测试|单元测试|章末测试|期中测试|期末测试|综合测试|模拟测试)/,
    description: '阶段性测试/训练标题'
  },
  {
    name: 'review_section',
    pattern: /^(本章复习|本章小结|章末复习|单元复习|复习题)/,
    description: '复习/归纳类标题'
  },
  {
    name: 'exam_paper',
    pattern: /^(期末测试卷|期中测试卷|模拟试卷|综合测试卷)/,
    description: '试卷类标题'
  },
];

// ============= 目录页条目过滤规则 =============

/**
 * 判断是否为目录页条目（带尾部页码的条目）
 * 
 * 规则：文本末尾有 2-3 位数字，且前面有空格或省略号
 * 例外：
 *   - "阶段训练 5" 不应被过滤（⑤被OCR为5，只有1位数字）
 *   - "19.2(四) 实数的绝对值和大小比较" 不应被过滤（没有尾部页码）
 */
function isTocPageEntry(text: string): boolean {
  // 末尾有 2-3 位数字，前面有空格、省略号或点号
  return /[\s…·.]+\d{2,3}\s*$/.test(text);
}

// ============= 标题破碎合并 =============

/**
 * 合并破碎的标题
 * 
 * 策略：同页关联合并
 * 
 * 检测模式：
 *   - 在同一页中，如果有"期末测试卷"(text_level=1) 和 "A卷"/"B卷"(type=header)
 *   - 则将它们合并为 "期末测试卷A卷"
 *   - 注意：它们之间可能隔了很多 block（题目内容），不是相邻的
 * 
 * 实现方式：
 *   - 先按页分组，在每页内寻找可合并的标题对
 *   - 标记被合并的 block，在后续处理中跳过
 */
function mergeFragmentedTitles(blocks: IndexedBlock[]): IndexedBlock[] {
  // Step 1: 按页分组，找到需要合并的 block 对
  const mergeMap = new Map<number, { mainId: number; fragmentId: number; mergedText: string }>();
  const fragmentIds = new Set<number>();

  // 按页分组
  const pageGroups = new Map<number, IndexedBlock[]>();
  for (const block of blocks) {
    const page = block.page_idx ?? -1;
    if (!pageGroups.has(page)) pageGroups.set(page, []);
    pageGroups.get(page)!.push(block);
  }

  // 在每页内寻找可合并的标题对
  for (const [page, pageBlocks] of pageGroups) {
    // 模式1：试卷类标题 + 卷号（如"期末测试卷" + "A卷"）
    const examTitles = pageBlocks.filter(b => 
      /^(期末测试卷|期中测试卷|模拟试卷|综合测试卷)$/.test((b.text || '').trim())
    );
    const volumeLabels = pageBlocks.filter(b => 
      /^[A-Ba-b]卷$/.test((b.text || '').trim())
    );

    if (examTitles.length === 1 && volumeLabels.length === 1) {
      const main = examTitles[0];
      const fragment = volumeLabels[0];
      const mergedText = (main.text || '').trim() + (fragment.text || '').trim();
      mergeMap.set(main.id, { mainId: main.id, fragmentId: fragment.id, mergedText });
      fragmentIds.add(fragment.id);
    }

    // 模式2：不完整的章标题 + 章名（如"第19章" + "实数"）
    // 仅当相邻时合并
    for (let i = 0; i < pageBlocks.length - 1; i++) {
      const a = pageBlocks[i];
      const b = pageBlocks[i + 1];
      const textA = (a.text || '').trim();
      const textB = (b.text || '').trim();
      if (/^第[一二三四五六七八九十百千\d]+章\s*$/.test(textA) &&
          textB.length < 20 && !/^\d/.test(textB)) {
        mergeMap.set(a.id, { mainId: a.id, fragmentId: b.id, mergedText: textA + textB });
        fragmentIds.add(b.id);
      }
    }
  }

  // Step 2: 构建结果，应用合并
  const result: IndexedBlock[] = [];
  for (const block of blocks) {
    // 跳过被合并的 fragment
    if (fragmentIds.has(block.id)) continue;

    const merge = mergeMap.get(block.id);
    if (merge) {
      result.push({
        ...block,
        text: merge.mergedText,
        _merged_from: [merge.mainId, merge.fragmentId],
      } as any);
    } else {
      result.push(block);
    }
  }

  return result;
}

// ============= 核心函数 =============

/**
 * Step 1: 加载并索引 content_list.json
 */
export function loadAndIndex(contentListPath: string): IndexedBlock[] {
  const raw: RawContentBlock[] = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const indexed: IndexedBlock[] = [];
  let globalId = 0;

  for (const item of raw) {
    if (item.type === 'list' && item.sub_type === 'text' && item.list_items) {
      for (const listItem of item.list_items) {
        indexed.push({
          ...item,
          type: 'text',
          text: listItem,
          id: globalId++,
        });
      }
    } else {
      indexed.push({
        ...item,
        id: globalId++,
      });
    }
  }

  return indexed;
}

/**
 * Step 2: 构建标题候选集
 * 三路信号并行检测，任一命中即纳入候选
 * 
 * v2: 先做破碎合并，再做候选筛选
 */
export function buildTitleCandidates(blocks: IndexedBlock[]): TitleCandidate[] {
  // Step 2a: 合并破碎标题
  const mergedBlocks = mergeFragmentedTitles(blocks);

  const candidates: TitleCandidate[] = [];

  for (let i = 0; i < mergedBlocks.length; i++) {
    const block = mergedBlocks[i];
    const text = (block.text || '').trim();

    // 跳过无文本的 block
    if (!text || text.length === 0) continue;
    // 跳过过长的文本（标题通常较短）
    if (text.length > 100) continue;

    // 过滤目录页条目
    if (isTocPageEntry(text)) continue;

    const signals: string[] = [];

    // === 信号 1: type === 'header' ===
    if (block.type === 'header') {
      signals.push('type:header');
    }

    // === 信号 2: text_level === 1 ===
    if (block.text_level === 1) {
      signals.push('text_level:1');
    }

    // === 信号 3: 正则模式匹配 ===
    for (const rule of TITLE_PATTERNS) {
      if (rule.pattern.test(text)) {
        signals.push(`pattern:${rule.name}`);
      }
    }

    // 任一信号命中即纳入候选
    if (signals.length > 0) {
      const mergedFrom = (block as any)._merged_from as number[] | undefined;
      
      // 在原始 blocks 数组中找上下文
      const origIdx = blocks.findIndex(b => b.id === block.id);
      
      candidates.push({
        id: block.id,
        text: text,
        page_idx: block.page_idx ?? -1,
        type: block.type,
        text_level: block.text_level,
        signals: signals,
        merged_from: mergedFrom,
        context_before: origIdx > 0 ? (blocks[origIdx - 1].text || '').trim().substring(0, 80) : undefined,
        context_after: origIdx < blocks.length - 1 ? (blocks[origIdx + 1].text || '').trim().substring(0, 80) : undefined,
      });
    }
  }

  return candidates;
}

/**
 * Step 3: 统计分析
 */
export function analyzeCandidates(candidates: TitleCandidate[]): {
  total: number;
  bySignal: Record<string, number>;
  multiSignal: number;
  singleSignal: number;
  byPage: Record<number, number>;
  mergedCount: number;
} {
  const bySignal: Record<string, number> = {};
  let multiSignal = 0;
  let singleSignal = 0;
  let mergedCount = 0;
  const byPage: Record<number, number> = {};

  for (const c of candidates) {
    if (c.signals.length > 1) multiSignal++;
    else singleSignal++;

    if (c.merged_from) mergedCount++;

    for (const s of c.signals) {
      bySignal[s] = (bySignal[s] || 0) + 1;
    }

    byPage[c.page_idx] = (byPage[c.page_idx] || 0) + 1;
  }

  return {
    total: candidates.length,
    bySignal,
    multiSignal,
    singleSignal,
    byPage,
    mergedCount,
  };
}

// ============= 主入口 =============

async function main() {
  const testDataDir = path.resolve(__dirname, '../../uploads/tasks/202602121048-1770864524079');
  const contentListPath = path.join(testDataDir, 'content_list.json');

  if (!fs.existsSync(contentListPath)) {
    console.error(`❌ 测试数据不存在: ${contentListPath}`);
    process.exit(1);
  }

  console.log('=== Step 1: 加载并索引 content_list.json ===');
  const blocks = loadAndIndex(contentListPath);
  console.log(`  总 block 数: ${blocks.length}`);
  console.log(`  type 分布: ${JSON.stringify(
    blocks.reduce((acc, b) => { acc[b.type] = (acc[b.type] || 0) + 1; return acc; }, {} as Record<string, number>)
  )}`);

  console.log('\n=== Step 2: 构建标题候选集 ===');
  const candidates = buildTitleCandidates(blocks);
  console.log(`  候选标题数: ${candidates.length}`);

  console.log('\n=== Step 3: 统计分析 ===');
  const stats = analyzeCandidates(candidates);
  console.log(`  多信号命中: ${stats.multiSignal} (高置信度)`);
  console.log(`  单信号命中: ${stats.singleSignal} (需 LLM 确认)`);
  console.log(`  合并标题数: ${stats.mergedCount}`);
  console.log(`  按信号分布:`);
  for (const [signal, count] of Object.entries(stats.bySignal).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${signal}: ${count}`);
  }

  // 输出候选列表到文件
  const outputDir = path.resolve(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'title_candidates.json');
  fs.writeFileSync(outputPath, JSON.stringify(candidates, null, 2), 'utf-8');
  console.log(`\n✅ 候选列表已保存到: ${outputPath}`);

  // 输出人类可读的摘要
  console.log('\n=== 候选标题列表（按页码排序） ===');
  console.log('ID\tPage\tType\tLevel\tSignals\t\t\t\tText');
  console.log('-'.repeat(120));
  for (const c of candidates) {
    const signalStr = c.signals.join(', ').padEnd(40);
    const mergeTag = c.merged_from ? ' [MERGED]' : '';
    console.log(`${c.id}\t${c.page_idx}\t${c.type}\t${c.text_level ?? '-'}\t${signalStr}\t${c.text.substring(0, 50)}${mergeTag}`);
  }
}

main().catch(console.error);
