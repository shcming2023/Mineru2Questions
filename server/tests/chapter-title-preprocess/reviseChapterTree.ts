/**
 * LLM 目录修订模块
 * 
 * 功能：将标题候选集提交给 LLM，输出结构化的目录树。
 * 
 * 设计原则：
 *   - LLM 只做"分类和组织"，不做"创造"
 *   - 所有输出必须引用原始 block ID
 *   - 输出格式为结构化 JSON，便于后续代码消费
 *   - 支持多级目录（一级=章，二级=节，三级=小节/练习）
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

/** LLM 返回的目录节点 */
export interface ChapterNode {
  id: number;           // 原始 block ID
  text: string;         // 标题文本
  level: number;        // 层级：1=章, 2=节, 3=小节/练习
  page_idx: number;     // 页码
  children?: ChapterNode[];  // 子节点
}

/** LLM 返回的完整目录树 */
export interface ChapterTree {
  title: string;        // 文档标题
  chapters: ChapterNode[];
}

/** 扁平化的章节映射条目 */
export interface ChapterMapEntry {
  id: number;
  text: string;
  level: number;
  page_idx: number;
  full_path: string;    // 完整路径，如 "第19章 平方根 > 19.1(一) 算术平方根"
  parent_id?: number;   // 父节点 ID
}

// ============= Prompt 设计 =============

/**
 * 目录修订 Prompt
 * 
 * 核心约束：
 * 1. 只能从候选集中选择，不能创造新标题
 * 2. 必须引用原始 block ID
 * 3. 输出严格 JSON 格式
 * 4. 识别并排除非标题的噪声
 */
function buildRevisionPrompt(candidates: TitleCandidate[]): string {
  // 构建候选列表的紧凑表示
  const candidateLines = candidates.map(c => {
    const signals = c.signals.join(', ');
    return `  {"id": ${c.id}, "page": ${c.page_idx}, "type": "${c.type}", "text_level": ${c.text_level ?? 'null'}, "signals": "${signals}", "text": ${JSON.stringify(c.text)}}`;
  }).join(',\n');

  return `你是一个专业的教育文本目录编辑。你的任务是从下面的"标题候选列表"中，识别出真正的章节标题，并构建一个准确的、多层级的目录树。

## 输入说明

下面是从一本教育教材（PDF 经 OCR 解析后）中提取的"标题候选列表"。每个候选者包含：
- **id**: 原始文本块的全局唯一 ID（不可修改）
- **page**: 所在页码
- **type**: OCR 工具标注的类型（header 或 text）
- **text_level**: OCR 工具根据字体大小推断的层级（1 表示大字体，可能是标题；null 表示未标注）
- **signals**: 代码预筛选命中的信号（如 type:header, text_level:1, pattern:chapter_cn 等）
- **text**: 文本内容

## 你的任务

1. **筛选**：从候选列表中识别出真正的章节标题。标题分为两大类：

   **A. 应保留的章节结构标题**（它们定义了文档的组织结构）：
   - 章标题：如“第X章 ...”
   - 节标题：如“X.Y ...”、“X.Y(一) ...”
   - 功能性章节标题：如“阶段训练①”、“阶段训练②”、“本章复习题”、“本章复习题（一）”、“本章复习题（二）”、“期末测试卷”等
   - 关键判断标准：这些标题在整本书中是**唯一的**或**带有唯一编号的**（如“阶段训练①”和“阶段训练②”是不同的），它们标志着内容的结构性分割点

   **B. 应排除的噪声**：
   - 封面、版权页、出版信息（如“出版说明”、“图书在版编目”、“责任编辑”等）
   - 目录页中的条目（如“22.2角平分线 148”这种带页码的）
   - 题型分类小标题（如“一、填空题”、“二、选择题”、“三、解答题”）
   - **在每个节内重复出现的教学环节标签**（如“要点归纳”、“疑难分析”、“基础训练”、“拓展训练”）—— 这些是每个节都会重复出现的固定模式，不是结构性分割点

2. **分级**：为每个保留的标题确定层级：
   - **level 1（章）**：如“第19章 实数”、“第20章 二次根式”
   - **level 2（节）**：如“19.1 平方根与立方根”、“19.1(一) 算术平方根”
   - **level 3（功能性章节）**：如“阶段训练①”、“本章复习题”、“本章复习题（一）”、“期末测试卷”等

3. **合并**：如果同一标题被拆分成多个 block（破碎），合并为一个条目，使用第一个 block 的 ID。

4. **补全**：如果从上下文逻辑上明显缺失某个标题（例如有 19.1(二) 但没有 19.1(一)），请在输出中标注 "inferred": true，并说明推断依据。但**绝不要凭空创造原文中不存在的标题**。

## 输出格式

请严格输出以下 JSON 格式。**重要：不要列出排除项的详细列表，只需输出排除项的数量。** 不要输出任何其他内容：

\`\`\`json
{
  "document_title": "文档标题",
  "chapters": [
    {
      "id": 123,
      "text": "第19章 平方根",
      "level": 1,
      "page": 9,
      "children": [
        {
          "id": 456,
          "text": "19.1(一) 算术平方根",
          "level": 2,
          "page": 9,
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
    timeout: config.timeout || 120000,
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
  // 尝试直接解析
  try {
    return JSON.parse(raw);
  } catch {}

  // 尝试提取 JSON 块
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {}
  }

  // 尝试找到第一个 { 到最后一个 }
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

// ============= 主入口 =============

async function main() {
  const testDataDir = path.resolve(__dirname, '../../uploads/tasks/202602121048-1770864524079');
  const contentListPath = path.join(testDataDir, 'content_list.json');
  const outputDir = path.resolve(__dirname, 'output');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // 读取 LLM 配置（从环境变量或 .env）
  const llmConfig: LLMConfig = {
    apiUrl: process.env.OPENAI_BASE_URL || process.env.LLM_API_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
    modelName: process.env.LLM_MODEL || 'gpt-4.1-mini',
    timeout: 120000,
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

  // Step 3: 构建 Prompt
  console.log('\n=== Step 3: 构建 LLM Prompt ===');
  const prompt = buildRevisionPrompt(candidates);
  const promptPath = path.join(outputDir, 'revision_prompt.txt');
  fs.writeFileSync(promptPath, prompt, 'utf-8');
  console.log(`  Prompt 长度: ${prompt.length} 字符`);
  console.log(`  Prompt 已保存到: ${promptPath}`);

  // Step 4: 调用 LLM
  console.log('\n=== Step 4: 调用 LLM 进行目录修订 ===');
  const startTime = Date.now();
  const rawResponse = await callLLM(prompt, llmConfig);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  LLM 响应时间: ${elapsed}s`);
  console.log(`  响应长度: ${rawResponse.length} 字符`);

  // 保存原始响应
  const rawPath = path.join(outputDir, 'llm_raw_response.txt');
  fs.writeFileSync(rawPath, rawResponse, 'utf-8');
  console.log(`  原始响应已保存到: ${rawPath}`);

  // Step 5: 解析响应
  console.log('\n=== Step 5: 解析 LLM 响应 ===');
  let parsed: any;
  try {
    parsed = parseLLMResponse(rawResponse);
    const parsedPath = path.join(outputDir, 'chapter_tree.json');
    fs.writeFileSync(parsedPath, JSON.stringify(parsed, null, 2), 'utf-8');
    console.log(`  ✅ 解析成功，目录树已保存到: ${parsedPath}`);
  } catch (e: any) {
    console.error(`  ❌ 解析失败: ${e.message}`);
    process.exit(1);
  }

  // Step 6: 扁平化并生成映射表
  console.log('\n=== Step 6: 扁平化目录树 ===');
  const flatMap = flattenTree(parsed.chapters || []);
  const flatPath = path.join(outputDir, 'chapter_flat_map.json');
  fs.writeFileSync(flatPath, JSON.stringify(flatMap, null, 2), 'utf-8');
  console.log(`  目录条目数: ${flatMap.length}`);
  console.log(`  扁平映射已保存到: ${flatPath}`);

  // Step 7: 输出人类可读的目录树
  console.log('\n=== 最终目录树 ===');
  function printTree(nodes: any[], indent: string = '') {
    for (const n of nodes) {
      const levelTag = n.level === 1 ? '📖' : n.level === 2 ? '  📄' : '    📝';
      console.log(`${levelTag} [ID=${n.id}] (p.${n.page ?? n.page_idx}) ${n.text}`);
      if (n.children && n.children.length > 0) {
        printTree(n.children, indent + '  ');
      }
    }
  }
  printTree(parsed.chapters || []);

  // Step 8: 统计排除项
  if (parsed.excluded_count) {
    console.log(`\n=== 排除项数量: ${parsed.excluded_count} ===`);
  }

  // Step 9: 质量检查
  console.log('\n=== 质量检查 ===');
  const level1Count = flatMap.filter(e => e.level === 1).length;
  const level2Count = flatMap.filter(e => e.level === 2).length;
  const level3Count = flatMap.filter(e => e.level === 3).length;
  console.log(`  一级标题（章）: ${level1Count}`);
  console.log(`  二级标题（节）: ${level2Count}`);
  console.log(`  三级标题（功能节）: ${level3Count}`);
  console.log(`  总计: ${flatMap.length}`);

  // 检查是否覆盖了关键标题
  const expectedChapters = ['第19章', '第20章', '第21章', '第22章'];
  const expectedSections = ['19.1', '19.2', '20.1', '20.2', '21.1', '21.2', '22.1', '22.2', '22.3'];
  const expectedExercises = ['阶段训练①', '阶段训练②', '阶段训练③', '阶段训练④', '阶段训练⑤', '阶段训练⑥', '阶段训练⑦', '阶段训练⑧', '阶段训练⑨'];

  console.log('\n  --- 关键标题覆盖检查 ---');
  for (const expected of expectedChapters) {
    const found = flatMap.find(e => e.text.includes(expected));
    console.log(`  ${found ? '✅' : '❌'} ${expected}: ${found ? `ID=${found.id}, "${found.text}"` : '未找到'}`);
  }
  for (const expected of expectedSections) {
    const found = flatMap.find(e => e.text.includes(expected));
    console.log(`  ${found ? '✅' : '❌'} ${expected}: ${found ? `ID=${found.id}, "${found.text}"` : '未找到'}`);
  }
  for (const expected of expectedExercises) {
    const found = flatMap.find(e => e.text.includes(expected));
    console.log(`  ${found ? '✅' : '❌'} ${expected}: ${found ? `ID=${found.id}, "${found.text}"` : '未找到'}`);
  }

  if (parsed.notes) {
    console.log(`\n📝 LLM 备注: ${parsed.notes}`);
  }

  console.log('\n✅ 测试完成！');
}

main().catch(console.error);
