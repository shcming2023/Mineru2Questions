/**
 * 章节标题候选集构建模块
 * 
 * 功能：从 Mineru 的 content_list.json 中，利用三路信号提取标题候选者：
 *   1. type 信号：type === 'header'
 *   2. text_level 信号：text_level === 1
 *   3. 正则模式信号：匹配常见的教育文本章节标题模式
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
  [key: string]: any;  // 保留其他未知字段
}

/** 带有全局 ID 的 block（模拟官方 _convert_json 后的格式） */
export interface IndexedBlock extends RawContentBlock {
  id: number;
}

/** 标题候选者 */
export interface TitleCandidate {
  id: number;              // 全局 block ID
  text: string;            // 文本内容
  page_idx: number;        // 页码
  type: string;            // 原始 type (header / text / ...)
  text_level?: number;     // Mineru 的 text_level 字段
  signals: string[];       // 命中的信号列表 ['type:header', 'text_level:1', 'pattern:chapter', ...]
  context_before?: string; // 前一个 block 的文本（辅助 LLM 判断）
  context_after?: string;  // 后一个 block 的文本（辅助 LLM 判断）
}

// ============= 可配置的正则模式库 =============

/**
 * 标题模式库：可扩展的正则规则集
 * 每个规则包含：name（信号名）、pattern（正则）、description（说明）
 * 
 * 设计原则：
 * - 基于通用的教育文本结构模式，而非硬编码特定教材
 * - 优先匹配结构化编号（章、节、小节）
 * - 兼顾常见的教育文本功能性标题（练习、复习、训练等）
 */
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
    pattern: /^(本章复习|本章小结|章末复习|单元复习|复习题|要点归纳|知识梳理|知识归纳)/,
    description: '复习/归纳类标题'
  },
  {
    name: 'practice_section',
    pattern: /^(练习|习题|课后练习|课时练习|随堂练习|巩固练习|拓展训练|拓展提升)/,
    description: '练习/习题类标题'
  },
  // 注意：带圈数字模式已移除，因为 ①②③ 在教育文本中更多出现在题目选项/步骤中
  // 「阶段训练①」这类标题会被 exercise_section 模式覆盖
  // {
  //   name: 'numbered_circled',
  //   pattern: /^[①②③④⑤⑥⑦⑧⑨⑩]\s*\S/,
  //   description: '带圈数字开头的标题（如阶段训练①）'
  // },

  // === 通用编号模式 ===
  // 注意：罗马数字模式已移除，因为 C./I./V. 等在中文教育文本中误匹配率极高
  // 如需支持英文教材，可按需启用并增加长度约束
  // {
  //   name: 'roman_section',
  //   pattern: /^(?:II|III|IV|VI|VII|VIII|IX|XI|XII)[\.]\s+\S/,
  //   description: '罗马数字编号标题（仅匹配 II 及以上，避免 I/V/C 误匹配）'
  // },
];

// ============= 核心函数 =============

/**
 * Step 1: 加载并索引 content_list.json
 * 模拟官方 DataFlow 的 MinerU2LLMInputOperator._convert_json
 * 关键区别：保留 type、text_level 等所有字段，不过滤任何 block
 */
export function loadAndIndex(contentListPath: string): IndexedBlock[] {
  const raw: RawContentBlock[] = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const indexed: IndexedBlock[] = [];
  let globalId = 0;

  for (const item of raw) {
    // 展平 list 类型（对齐官方逻辑）
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
 */
export function buildTitleCandidates(blocks: IndexedBlock[]): TitleCandidate[] {
  const candidates: TitleCandidate[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = (block.text || '').trim();

    // 跳过无文本的 block（图片、表格等）
    if (!text || text.length === 0) continue;
    // 跳过过长的文本（标题通常较短）
    if (text.length > 100) continue;

    // === 过滤目录页条目：文本末尾带页码的条目（如 "阶段训练1 11"、"22.2角平分线 148"）===
    // 使用 2-3 位数字避免误过滤“阶段训练 5”（⑤被OCR为5）
    if (/\s+\d{2,3}$/.test(text)) continue;

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
      candidates.push({
        id: block.id,
        text: text,
        page_idx: block.page_idx ?? -1,
        type: block.type,
        text_level: block.text_level,
        signals: signals,
        context_before: i > 0 ? (blocks[i - 1].text || '').trim().substring(0, 80) : undefined,
        context_after: i < blocks.length - 1 ? (blocks[i + 1].text || '').trim().substring(0, 80) : undefined,
      });
    }
  }

  return candidates;
}

/**
 * Step 3: 统计分析（用于诊断和调试）
 */
export function analyzeCandidates(candidates: TitleCandidate[]): {
  total: number;
  bySignal: Record<string, number>;
  multiSignal: number;
  singleSignal: number;
  byPage: Record<number, number>;
} {
  const bySignal: Record<string, number> = {};
  let multiSignal = 0;
  let singleSignal = 0;
  const byPage: Record<number, number> = {};

  for (const c of candidates) {
    if (c.signals.length > 1) multiSignal++;
    else singleSignal++;

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
    console.log(`${c.id}\t${c.page_idx}\t${c.type}\t${c.text_level ?? '-'}\t${signalStr}\t${c.text.substring(0, 50)}`);
  }
}

main().catch(console.error);
