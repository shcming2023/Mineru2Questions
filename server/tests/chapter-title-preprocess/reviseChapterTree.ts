/**
 * LLM 目录修订模块 (v2)
 * 
 * v2 改进：
 *   - 修正层级定义：level 1=章/独立顶级, level 2=节/功能性章节, level 3=子节
 *   - 改进 Prompt：更精确的层级判断指令
 *   - 增加标题破碎合并的支持
 *   - 增加与标准目录的自动对比
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { loadAndIndex, buildTitleCandidates, TitleCandidate } from './buildTitleCandidates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= 类型定义 =============

export interface ChapterNode {
  id: number;
  text: string;
  level: number;        // 1=章/独立顶级, 2=节/功能性章节, 3=子节
  page_idx: number;
  children?: ChapterNode[];
}

export interface ChapterTree {
  title: string;
  chapters: ChapterNode[];
}

export interface ChapterMapEntry {
  id: number;
  text: string;
  level: number;
  page_idx: number;
  full_path: string;
  parent_id?: number;
}

// ============= Prompt 设计 (v2) =============

function buildRevisionPrompt(candidates: TitleCandidate[]): string {
  const candidateLines = candidates.map(c => {
    const signals = c.signals.join(', ');
    const merged = c.merged_from ? `, "merged_from": [${c.merged_from.join(',')}]` : '';
    return `  {"id": ${c.id}, "page": ${c.page_idx}, "type": "${c.type}", "text_level": ${c.text_level ?? 'null'}, "signals": "${signals}"${merged}, "text": ${JSON.stringify(c.text)}}`;
  }).join(',\n');

  return `你是一个专业的教育文本目录编辑。你的任务是从下面的"标题候选列表"中，识别出真正的章节标题，并构建一个准确的、多层级的目录树。

## 输入说明

下面是从一本教育教材（PDF 经 OCR 解析后）中提取的"标题候选列表"。每个候选者包含：
- **id**: 原始文本块的全局唯一 ID（不可修改）
- **page**: 所在页码（0-indexed）
- **type**: OCR 工具标注的类型（header 或 text）
- **text_level**: OCR 工具根据字体大小推断的层级（1 表示大字体标题；null 表示未标注）
- **signals**: 代码预筛选命中的信号
- **merged_from**: 如果该条目是由多个破碎 block 合并而成，记录原始 block ID 列表
- **text**: 文本内容

## 你的任务

### 1. 筛选：识别真正的章节标题

**应保留的章节结构标题**（定义文档组织结构的标题）：
- 章标题：如"第19章 实数"
- 节标题：如"19.1 平方根与立方根"
- 子节标题：如"19.1(一) 算术平方根"、"21.2(三) 一般的一元二次方程的解法——配方法"
- 功能性章节标题：如"阶段训练①"、"本章复习题"、"本章复习题（一）"、"期末测试卷A卷"等
  - 这些标题在整本书中是**唯一的**或**带有唯一编号的**
  - 它们标志着内容的结构性分割点

**应排除的噪声**：
- 封面、版权页、出版信息
- 目录页中的条目（带页码的，如"22.2角平分线 148"）
- 题型分类小标题（如"一、填空题"、"二、选择题"、"三、解答题"）
- **在每个节内重复出现的教学环节标签**（如"要点归纳"、"疑难分析"、"基础训练"、"拓展训练"）——这些在每个课时都会重复出现，不是结构性分割点

### 2. 分级：精确确定每个标题的层级

层级定义（**严格遵循**）：

| 层级 | 含义 | 典型模式 | 示例 |
|------|------|----------|------|
| **level 1** | 章级标题或独立顶级标题 | "第X章..."、"期末测试卷..." | "第19章 实数"、"期末测试卷A卷" |
| **level 2** | 节级标题或与节同级的功能性标题 | "X.Y ..."、"阶段训练X"、"本章复习题" | "19.1 平方根与立方根"、"阶段训练①"、"本章复习题（一）" |
| **level 3** | 子节标题（课时级） | "X.Y(Z) ..." | "19.1(一) 算术平方根"、"21.2(三) 一般的一元二次方程的解法——配方法" |

**关键层级判断规则**：
- "第X章 ..." → **level 1**（章标题）
- "期末测试卷..."、"期中测试卷..." → **level 1**（独立顶级标题，不属于任何章）
- "X.Y 标题名"（如 "19.1 平方根与立方根"）→ **level 2**（节标题）
- "阶段训练X"（如 "阶段训练①"）→ **level 2**（与节同级，穿插在节之间）
- "本章复习题"、"本章复习题（一）" → **level 2**（与节同级，在章末尾）
- "X.Y(Z) 标题名"（如 "19.1(一) 算术平方根"）→ **level 3**（子节标题，属于对应的 X.Y 节）

### 3. 组织：构建树形结构

- level 1 节点是顶级节点
- level 2 节点是 level 1 的子节点
- level 3 节点是 level 2 的子节点
- 阶段训练和本章复习题作为章的直接子节点（level 2），与节标题平级
- 期末测试卷作为顶级节点（level 1），与章标题平级

### 4. 注意事项

- OCR 可能将带圈数字识别为普通数字（如 ⑤ → 5），请注意这种变体
- 如果标题被拆分成多个 block（已在 merged_from 中标注），使用合并后的文本
- **不要创造原文中不存在的标题**
- 目录页的条目（page 2-8 左右）应全部排除，只保留正文中的标题

## 输出格式

请严格输出以下 JSON 格式，不要输出任何其他内容：

\`\`\`json
{
  "document_title": "文档标题",
  "chapters": [
    {
      "id": 129,
      "text": "第19章 实数",
      "level": 1,
      "page": 9,
      "children": [
        {
          "id": 109,
          "text": "19.1 平方根与立方根",
          "level": 2,
          "page": 9,
          "children": [
            {
              "id": 110,
              "text": "19.1(一) 算术平方根",
              "level": 3,
              "page": 9,
              "children": []
            }
          ]
        },
        {
          "id": 276,
          "text": "阶段训练①",
          "level": 2,
          "page": 19,
          "children": []
        }
      ]
    }
  ],
  "excluded_count": 123,
  "notes": "任何需要说明的特殊情况"
}
\`\`\`

## 标题候选列表

[
${candidateLines}
]

请开始分析并输出 JSON 结果。`;
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
    timeout: config.timeout || 180000,
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

// ============= 后处理：补漏强信号条目 =============

/**
 * 对比候选集中的"强信号"条目与 LLM 输出，自动补入被遗漏的条目。
 * 
 * 强信号定义：同时命中 text_level:1 + pattern:exercise_section/review_section/exam_paper 的候选者。
 * 这些条目有极高的置信度是真正的章节标题，如果 LLM 遗漏了，可以安全地补入。
 * 
 * 补入策略：
 *   - 根据 page_idx 找到该条目应属于的 chapter（level 1 节点）
 *   - 作为该 chapter 的 level 2 子节点插入
 *   - 按 page_idx 排序确保顺序正确
 */
function backfillMissedEntries(
  flatMap: ChapterMapEntry[],
  candidates: TitleCandidate[],
  chapters: any[]
): { flatMap: ChapterMapEntry[]; chapters: any[] } {
  // 识别强信号条目
  const strongPatterns = ['pattern:exercise_section', 'pattern:review_section', 'pattern:exam_paper'];
  const strongCandidates = candidates.filter(c =>
    c.signals.includes('text_level:1') &&
    c.signals.some(s => strongPatterns.includes(s))
  );

  // 找出 LLM 遗漏的
  const existingIds = new Set(flatMap.map(e => e.id));
  const missed = strongCandidates.filter(c => !existingIds.has(c.id));

  if (missed.length === 0) {
    console.log('  后处理补漏: 无遗漏的强信号条目');
    return { flatMap, chapters };
  }

  console.log(`  后处理补漏: 发现 ${missed.length} 个被 LLM 遗漏的强信号条目:`);
  for (const m of missed) {
    console.log(`    - ID=${m.id} page=${m.page_idx} "${m.text}"`);
  }

  // 获取所有 level 1 节点（章标题），按 page_idx 排序
  const level1Nodes = chapters.sort((a: any, b: any) => (a.page ?? a.page_idx ?? 0) - (b.page ?? b.page_idx ?? 0));

  for (const m of missed) {
    const mPage = m.page_idx;

    // 判断是否是 level 1 条目（期末测试卷）
    if (m.signals.includes('pattern:exam_paper')) {
      // 作为顶级节点插入
      const newNode = {
        id: m.id,
        text: m.text,
        level: 1,
        page: mPage,
        children: [],
        _backfilled: true,
      };
      chapters.push(newNode);
      flatMap.push({
        id: m.id,
        text: m.text,
        level: 1,
        page_idx: mPage,
        full_path: m.text,
      });
      console.log(`    → 补入为 level 1 顶级节点`);
      continue;
    }

    // 找到该条目应属于的 chapter（page_idx 最近且小于等于该条目的 level 1 节点）
    let parentChapter: any = null;
    for (const ch of level1Nodes) {
      const chPage = ch.page ?? ch.page_idx ?? 0;
      if (chPage <= mPage) {
        parentChapter = ch;
      } else {
        break;
      }
    }

    if (parentChapter) {
      const newChild = {
        id: m.id,
        text: m.text,
        level: 2,
        page: mPage,
        children: [],
        _backfilled: true,
      };
      if (!parentChapter.children) parentChapter.children = [];
      parentChapter.children.push(newChild);
      // 按 page 排序 children
      parentChapter.children.sort((a: any, b: any) => (a.page ?? a.page_idx ?? 0) - (b.page ?? b.page_idx ?? 0));

      flatMap.push({
        id: m.id,
        text: m.text,
        level: 2,
        page_idx: mPage,
        full_path: `${parentChapter.text} > ${m.text}`,
        parent_id: parentChapter.id,
      });
      console.log(`    → 补入为 "${parentChapter.text}" 的 level 2 子节点`);
    } else {
      console.log(`    ⚠️ 无法找到合适的父章节，跳过`);
    }
  }

  // 重新按 page_idx 排序 flatMap
  flatMap.sort((a, b) => a.page_idx - b.page_idx);

  return { flatMap, chapters };
}

// ============= 标准目录（用于自动对比） =============

interface StandardTocEntry {
  level: number;
  title: string;
  page: number;
}

const STANDARD_TOC: StandardTocEntry[] = [
  { level: 1, title: "第19章 实数", page: 1 },
  { level: 2, title: "19.1 平方根与立方根", page: 1 },
  { level: 3, title: "19.1(一) 算术平方根", page: 1 },
  { level: 3, title: "19.1(二) 平方根", page: 3 },
  { level: 3, title: "19.1(三) 立方根", page: 7 },
  { level: 2, title: "阶段训练1", page: 11 },
  { level: 2, title: "19.2 实数", page: 13 },
  { level: 3, title: "19.2(一) 有理数的小数形式", page: 13 },
  { level: 3, title: "19.2(二) 无理数", page: 16 },
  { level: 3, title: "19.2(三) 实数与数轴", page: 19 },
  { level: 3, title: "19.2(四) 实数的绝对值和大小比较", page: 22 },
  { level: 3, title: "19.2(五) 实数的运算", page: 26 },
  { level: 3, title: "19.2(六) 科学记数法", page: 29 },
  { level: 2, title: "本章复习题(一)", page: 32 },
  { level: 2, title: "本章复习题(二)", page: 35 },
  { level: 1, title: "第20章 二次根式", page: 38 },
  { level: 2, title: "20.1 二次根式及其性质", page: 38 },
  { level: 3, title: "20.1(一) 二次根式的概念", page: 38 },
  { level: 3, title: "20.1(二) 二次根式的性质及最简二次根式", page: 41 },
  { level: 2, title: "20.2 二次根式的运算", page: 47 },
  { level: 3, title: "20.2(一) 同类二次根式及二次根式的加减法", page: 47 },
  { level: 2, title: "阶段训练2", page: 53 },
  { level: 3, title: "20.2(二) 二次根式的乘法和除法", page: 56 },
  { level: 3, title: "20.2(三) 分母有理化", page: 59 },
  { level: 3, title: "20.2(四) 二次根式的混合运算", page: 63 },
  { level: 2, title: "阶段训练3", page: 68 },
  { level: 2, title: "本章复习题", page: 71 },
  { level: 1, title: "第21章 一元二次方程", page: 75 },
  { level: 2, title: "21.1 一元二次方程的概念", page: 75 },
  { level: 2, title: "21.2 一元二次方程的解法", page: 78 },
  { level: 3, title: "21.2(一) 特殊的一元二次方程的解法——因式分解法", page: 78 },
  { level: 3, title: "21.2(二) 用开平方的方法解特殊的一元二次方程", page: 82 },
  { level: 3, title: "21.2(三) 一般的一元二次方程的解法——配方法", page: 86 },
  { level: 3, title: "21.2(四) 一般的一元二次方程的解法——公式法", page: 90 },
  { level: 3, title: "21.2(五) 用合适的方法解一元二次方程", page: 94 },
  { level: 2, title: "阶段训练4", page: 98 },
  { level: 2, title: "21.3 一元二次方程的判别式", page: 101 },
  { level: 3, title: "21.3(一) 一元二次方程的根的判别式", page: 101 },
  { level: 3, title: "21.3(二) 一元二次方程的根的判别式的应用", page: 104 },
  { level: 2, title: "21.4 一元二次方程的根与系数的关系", page: 108 },
  { level: 3, title: "21.4(一) 一元二次方程的根与系数的关系(1)", page: 108 },
  { level: 3, title: "21.4(二) 一元二次方程的根与系数的关系(2)", page: 111 },
  { level: 2, title: "21.5 一元二次方程的应用", page: 116 },
  { level: 3, title: "21.5(一) 二次三项式的因式分解", page: 116 },
  { level: 2, title: "阶段训练5", page: 120 },
  { level: 3, title: "21.5(二) 列方程解实际问题", page: 123 },
  { level: 3, title: "21.5(三) 解分式方程", page: 126 },
  { level: 3, title: "21.5(四) 列分式方程解应用题", page: 130 },
  { level: 2, title: "阶段训练6", page: 133 },
  { level: 2, title: "本章复习题", page: 136 },
  { level: 1, title: "第22章 直角三角形", page: 140 },
  { level: 2, title: "22.1 直角三角形", page: 140 },
  { level: 3, title: "22.1(一) 直角三角形的性质", page: 140 },
  { level: 3, title: "22.1(二) 直角三角形全等的判定", page: 144 },
  { level: 2, title: "22.2 角平分线", page: 148 },
  { level: 3, title: "22.2(一) 角平分线性质定理", page: 148 },
  { level: 3, title: "22.2(二) 角平分线的综合运用", page: 153 },
  { level: 2, title: "阶段训练7", page: 156 },
  { level: 2, title: "22.3 勾股定理", page: 160 },
  { level: 3, title: "22.3(一) 勾股定理的证明", page: 160 },
  { level: 3, title: "22.3(二) 勾股定理的应用", page: 163 },
  { level: 2, title: "阶段训练8", page: 168 },
  { level: 3, title: "22.3(三) 勾股定理的逆定理及其证明", page: 171 },
  { level: 3, title: "22.3(四) 勾股定理及其逆定理的应用", page: 175 },
  { level: 2, title: "阶段训练9", page: 180 },
  { level: 2, title: "本章复习题", page: 184 },
  { level: 1, title: "期末测试卷A卷", page: 189 },
  { level: 1, title: "期末测试卷B卷", page: 195 },
];

function normalizeForMatch(text: string): string {
  let t = text.trim();
  t = t.replace(/\s+/g, '');
  // 全角括号 → 半角
  t = t.replace(/（/g, '(').replace(/）/g, ')');
  // 带圈数字 → 阿拉伯数字
  const circled: Record<string, string> = {'①':'1','②':'2','③':'3','④':'4','⑤':'5','⑥':'6','⑦':'7','⑧':'8','⑨':'9'};
  for (const [c, n] of Object.entries(circled)) {
    t = t.replace(c, n);
  }
  return t;
}

function compareWithStandard(flatMap: ChapterMapEntry[]): void {
  console.log('\n=== 与标准目录对比 ===');
  
  let matched = 0;
  let levelCorrect = 0;
  const missing: string[] = [];
  const wrongLevel: string[] = [];

  for (const std of STANDARD_TOC) {
    const normStd = normalizeForMatch(std.title);
    const found = flatMap.find(e => {
      const normE = normalizeForMatch(e.text);
      return normStd === normE || normStd.includes(normE) || normE.includes(normStd);
    });

    if (found) {
      matched++;
      if (found.level === std.level) {
        levelCorrect++;
      } else {
        wrongLevel.push(`  ⚠️ [${std.title}] 标准level=${std.level}, 实际level=${found.level}`);
      }
    } else {
      missing.push(`  ❌ [${std.title}] (page ${std.page}, level ${std.level})`);
    }
  }

  console.log(`  标准目录条目: ${STANDARD_TOC.length}`);
  console.log(`  匹配成功: ${matched}/${STANDARD_TOC.length} (${(matched/STANDARD_TOC.length*100).toFixed(1)}%)`);
  console.log(`  层级正确: ${levelCorrect}/${matched} (${matched > 0 ? (levelCorrect/matched*100).toFixed(1) : 0}%)`);
  
  if (missing.length > 0) {
    console.log(`\n  --- 缺失条目 (${missing.length}) ---`);
    for (const m of missing) console.log(m);
  }
  
  if (wrongLevel.length > 0) {
    console.log(`\n  --- 层级错误 (${wrongLevel.length}) ---`);
    for (const w of wrongLevel) console.log(w);
  }

  // 检查多出的条目
  const extra: string[] = [];
  for (const e of flatMap) {
    const normE = normalizeForMatch(e.text);
    const found = STANDARD_TOC.find(std => {
      const normStd = normalizeForMatch(std.title);
      return normStd === normE || normStd.includes(normE) || normE.includes(normStd);
    });
    if (!found) {
      extra.push(`  ➕ ID=${e.id} level=${e.level} "${e.text}"`);
    }
  }
  
  if (extra.length > 0) {
    console.log(`\n  --- 多出条目 (${extra.length}) ---`);
    for (const e of extra) console.log(e);
  }
}

// ============= 主入口 =============

async function main() {
  const testDataDir = path.resolve(__dirname, '../../uploads/tasks/202602121048-1770864524079');
  const contentListPath = path.join(testDataDir, 'content_list.json');
  const outputDir = path.resolve(__dirname, 'output');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const llmConfig: LLMConfig = {
    apiUrl: process.env.OPENAI_BASE_URL || process.env.LLM_API_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
    modelName: process.env.LLM_MODEL || 'gpt-4.1-mini',
    timeout: 180000,
  };

  if (!llmConfig.apiKey) {
    console.error('❌ 未设置 OPENAI_API_KEY 或 LLM_API_KEY 环境变量');
    process.exit(1);
  }

  console.log(`🔧 LLM 配置: model=${llmConfig.modelName}, url=${llmConfig.apiUrl}`);

  // Step 1: 加载并索引
  console.log('\n=== Step 1: 加载并索引 content_list.json ===');
  const blocks = loadAndIndex(contentListPath);
  console.log(`  总 block 数: ${blocks.length}`);

  // Step 2: 构建候选集
  console.log('\n=== Step 2: 构建标题候选集 ===');
  const candidates = buildTitleCandidates(blocks);
  console.log(`  候选标题数: ${candidates.length}`);
  
  // 保存候选集
  fs.writeFileSync(path.join(outputDir, 'title_candidates_v2.json'), JSON.stringify(candidates, null, 2), 'utf-8');

  // Step 3: 构建 Prompt
  console.log('\n=== Step 3: 构建 LLM Prompt ===');
  const prompt = buildRevisionPrompt(candidates);
  const promptPath = path.join(outputDir, 'revision_prompt_v2.txt');
  fs.writeFileSync(promptPath, prompt, 'utf-8');
  console.log(`  Prompt 长度: ${prompt.length} 字符`);

  // Step 4: 调用 LLM
  console.log('\n=== Step 4: 调用 LLM 进行目录修订 ===');
  const startTime = Date.now();
  const rawResponse = await callLLM(prompt, llmConfig);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  LLM 响应时间: ${elapsed}s`);
  console.log(`  响应长度: ${rawResponse.length} 字符`);

  const rawPath = path.join(outputDir, 'llm_raw_response_v2.txt');
  fs.writeFileSync(rawPath, rawResponse, 'utf-8');

  // Step 5: 解析响应
  console.log('\n=== Step 5: 解析 LLM 响应 ===');
  let parsed: any;
  try {
    parsed = parseLLMResponse(rawResponse);
    const parsedPath = path.join(outputDir, 'chapter_tree_v2.json');
    fs.writeFileSync(parsedPath, JSON.stringify(parsed, null, 2), 'utf-8');
    console.log(`  ✅ 解析成功`);
  } catch (e: any) {
    console.error(`  ❌ 解析失败: ${e.message}`);
    process.exit(1);
  }

  // Step 6: 扁平化
  console.log('\n=== Step 6: 扁平化目录树 ===');
  let flatMap = flattenTree(parsed.chapters || []);
  console.log(`  目录条目数 (补漏前): ${flatMap.length}`);

  // Step 6.5: 后处理补漏
  console.log('\n=== Step 6.5: 后处理补漏强信号条目 ===');
  const backfillResult = backfillMissedEntries(flatMap, candidates, parsed.chapters || []);
  flatMap = backfillResult.flatMap;
  parsed.chapters = backfillResult.chapters;
  console.log(`  目录条目数 (补漏后): ${flatMap.length}`);

  // 保存补漏后的结果
  fs.writeFileSync(path.join(outputDir, 'chapter_flat_map_v2.json'), JSON.stringify(flatMap, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'chapter_tree_v2_final.json'), JSON.stringify(parsed, null, 2), 'utf-8');

  // Step 7: 输出目录树
  console.log('\n=== 最终目录树 ===');
  function printTree(nodes: any[], indent: string = '') {
    for (const n of nodes) {
      const levelTag = n.level === 1 ? '📖' : n.level === 2 ? '  📄' : '    📝';
      console.log(`${levelTag} [ID=${n.id}] L${n.level} (p.${n.page ?? n.page_idx}) ${n.text}`);
      if (n.children && n.children.length > 0) {
        printTree(n.children, indent + '  ');
      }
    }
  }
  printTree(parsed.chapters || []);

  // Step 8: 统计
  console.log('\n=== 统计 ===');
  const level1Count = flatMap.filter(e => e.level === 1).length;
  const level2Count = flatMap.filter(e => e.level === 2).length;
  const level3Count = flatMap.filter(e => e.level === 3).length;
  console.log(`  Level 1 (章/顶级): ${level1Count}`);
  console.log(`  Level 2 (节/功能性): ${level2Count}`);
  console.log(`  Level 3 (子节): ${level3Count}`);
  console.log(`  总计: ${flatMap.length}`);

  // Step 9: 与标准目录对比
  compareWithStandard(flatMap);

  if (parsed.notes) {
    console.log(`\n📝 LLM 备注: ${parsed.notes}`);
  }

  console.log('\n✅ 测试完成！');
}

main().catch(console.error);
