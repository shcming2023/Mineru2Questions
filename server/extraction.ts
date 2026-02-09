/**
 * 题目提取核心流水线 (v1.1 - 聚焦高质量题目提取)
 * 
 * 对齐 PRD v1.1 和 DataFlow 官方流水线。
 * 
 * 核心改进：
 * 1. 移除远距离答案检测和合并逻辑
 * 2. 简化为单一流水线（不再支持双文件模式）
 * 3. 聚焦题目提取 + 近距离例题答案
 * 4. 增强图片ID连续性
 * 5. 增加容错回退机制
 * 6. 增加中间日志记录
 * 
 * 核心思路：
 * 1. 解析 MinerU 的 content_list.json，为每个内容块分配 ID
 * 2. 让 LLM 输出内容块 ID 而非原文，大幅减少 token 消耗
 * 3. 根据 ID 回填原文，确保文本完整性
 * 4. 仅对例题提取近距离答案（在 50 个 block 内）
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { QuestionParser, ExtractedQuestion } from './parser';
import { QUESTION_EXTRACT_PROMPT } from './prompts';

// ============= 类型定义 =============

export interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  maxWorkers?: number;
  timeout?: number;
  maxRetries?: number;
}

/**
 * MinerU content_list.json 中的内容块类型
 */
export interface ContentBlock {
  id?: number;              // 可能没有 ID，需要自动分配
  type: string;             // text, image, table, equation 等
  text?: string;            // 文本内容
  img_path?: string;        // 图片路径
  image_caption?: string[]; // 图片标题
  page_idx?: number;        // 页码
  bbox?: number[];          // 边界框
  list_items?: string[];    // 列表项 (type=list 时)
  sub_type?: string;        // 子类型
}

/**
 * 转换后的 LLM 输入格式（简化版）
 */
export interface ConvertedBlock {
  id: number;
  type: string;
  text?: string;
  img_path?: string;
  image_caption?: string;
  page_idx?: number;
}

/**
 * 分块数据结构
 */
interface Chunk {
  index: number;
  blocks: ConvertedBlock[];
  startId: number;
  endId: number;
}

// ============= 常量配置 =============

const MAX_CHUNK_SIZE = 100;        // 每个 chunk 最多包含 100 个 block
const OVERLAP_SIZE = 10;           // 重叠窗口大小，避免题目被切断
const NEAR_DISTANCE_THRESHOLD = 50; // 近距离答案阈值（block 数量）

// ============= 核心流水线函数 =============

/**
 * 主提取函数：从 content_list.json 提取题目
 * 
 * @param contentListPath - content_list.json 文件路径
 * @param imagesFolder - 图片文件夹路径
 * @param taskDir - 任务目录（用于保存日志）
 * @param llmConfig - LLM 配置
 * @returns 提取的题目数组
 */
export async function extractQuestions(
  contentListPath: string,
  imagesFolder: string,
  taskDir: string,
  llmConfig: LLMConfig
): Promise<ExtractedQuestion[]> {
  console.log('=== Starting Question Extraction Pipeline ===');
  
  // 1. 加载并格式化输入
  console.log('Step 1: Loading and formatting content_list.json...');
  const blocks = loadAndFormatBlocks(contentListPath);
  console.log(`Loaded ${blocks.length} blocks`);
  
  // 2. 分块处理
  console.log('Step 2: Splitting into chunks with overlap...');
  const chunks = splitIntoChunks(blocks, MAX_CHUNK_SIZE, OVERLAP_SIZE);
  console.log(`Created ${chunks.length} chunks`);
  
  // 3. 调用 LLM 提取题目
  console.log('Step 3: Extracting questions via LLM...');
  const allQuestions: ExtractedQuestion[] = [];
  
  for (const chunk of chunks) {
    console.log(`Processing chunk ${chunk.index}/${chunks.length} (blocks ${chunk.startId}-${chunk.endId})...`);
    
    try {
      // 调用 LLM
      const llmOutput = await callLLM(chunk.blocks, llmConfig);
      
      // 保存 LLM 原始输出
      const logDir = path.join(taskDir, 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(logDir, `chunk_${chunk.index}_llm_output.txt`),
        llmOutput,
        'utf-8'
      );
      
      // 解析（带容错）
      const parser = new QuestionParser(chunk.blocks, imagesFolder, logDir);
      const questions = parser.parseWithFallback(llmOutput, chunk.index);
      
      console.log(`Chunk ${chunk.index}: Extracted ${questions.length} questions`);
      allQuestions.push(...questions);
      
    } catch (error: any) {
      console.error(`Chunk ${chunk.index}: Failed to process: ${error.message}`);
      // 继续处理下一个 chunk
    }
  }
  
  console.log(`Step 3 completed: Total ${allQuestions.length} questions extracted`);
  
  // 4. 去重（基于 questionIds）
  console.log('Step 4: Deduplicating questions...');
  const uniqueQuestions = deduplicateQuestions(allQuestions);
  console.log(`After deduplication: ${uniqueQuestions.length} questions`);
  
  // 5. 题目类型识别（如果 LLM 未提供）
  console.log('Step 5: Identifying question types...');
  for (const q of uniqueQuestions) {
    if (!q.type || (q.type !== 'example' && q.type !== 'exercise')) {
      q.type = identifyQuestionType(q.label);
    }
  }
  
  // 6. 质量过滤
  console.log('Step 6: Filtering low-quality questions...');
  const filteredQuestions = filterLowQuality(uniqueQuestions);
  console.log(`After quality filter: ${filteredQuestions.length} questions`);
  
  console.log('=== Question Extraction Pipeline Completed ===');
  return filteredQuestions;
}

/**
 * 加载并格式化 content_list.json
 */
function loadAndFormatBlocks(contentListPath: string): ConvertedBlock[] {
  const rawContent = fs.readFileSync(contentListPath, 'utf-8');
  const contentList: ContentBlock[] = JSON.parse(rawContent);
  
  const convertedBlocks: ConvertedBlock[] = [];
  let currentId = 0;
  
  for (const block of contentList) {
    // 分配 ID（如果没有）
    const id = block.id !== undefined ? block.id : currentId++;
    
    // 转换为简化格式
    const converted: ConvertedBlock = {
      id,
      type: block.type,
      page_idx: block.page_idx
    };
    
    // 处理文本内容
    if (block.type === 'text' && block.text) {
      converted.text = block.text.trim();
    } else if (block.type === 'list' && block.list_items) {
      converted.text = block.list_items.join(' ').trim();
    }
    
    // 处理图片
    if (block.type === 'image' && block.img_path) {
      converted.img_path = block.img_path;
      if (block.image_caption && block.image_caption.length > 0) {
        converted.image_caption = block.image_caption.join(' ');
      }
    }
    
    convertedBlocks.push(converted);
  }
  
  return convertedBlocks;
}

/**
 * 将 blocks 分块，带重叠窗口
 */
function splitIntoChunks(
  blocks: ConvertedBlock[],
  maxSize: number,
  overlapSize: number
): Chunk[] {
  const chunks: Chunk[] = [];
  let index = 0;
  let start = 0;
  
  while (start < blocks.length) {
    const end = Math.min(start + maxSize, blocks.length);
    const chunkBlocks = blocks.slice(start, end);
    
    chunks.push({
      index,
      blocks: chunkBlocks,
      startId: chunkBlocks[0].id,
      endId: chunkBlocks[chunkBlocks.length - 1].id
    });
    
    index++;
    start = end - overlapSize; // 重叠窗口
    
    // 避免无限循环
    if (start >= end) break;
  }
  
  return chunks;
}

/**
 * 调用 LLM 提取题目
 */
async function callLLM(blocks: ConvertedBlock[], config: LLMConfig): Promise<string> {
  // 构建输入
  const inputJson = JSON.stringify(blocks, null, 2);
  const prompt = `${QUESTION_EXTRACT_PROMPT}\n\n## Input JSON:\n\`\`\`json\n${inputJson}\n\`\`\``;
  
  // 调用 LLM API
  const response = await axios.post(
    config.apiUrl,
    {
      model: config.modelName,
      messages: [
        { role: 'system', content: 'You are an expert in extracting questions from educational materials.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000
    },
    {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: config.timeout || 60000
    }
  );
  
  return response.data.choices[0].message.content;
}

/**
 * 去重：基于 questionIds 去重
 */
function deduplicateQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const seen = new Set<string>();
  const unique: ExtractedQuestion[] = [];
  
  for (const q of questions) {
    const key = q.questionIds || `${q.label}_${q.question.substring(0, 50)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(q);
    }
  }
  
  return unique;
}

/**
 * 题目类型识别
 */
function identifyQuestionType(label: string): 'example' | 'exercise' {
  const examplePatterns = [
    /^例/,           // 例1, 例①
    /^Example/i,    // Example 1
    /^Ex\./i,       // Ex. 1
    /^示例/         // 示例1
  ];
  
  for (const pattern of examplePatterns) {
    if (pattern.test(label)) {
      return 'example';
    }
  }
  
  return 'exercise';
}

/**
 * 质量过滤
 */
function filterLowQuality(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  return questions.filter(q => {
    // 过滤条件 1: 题目文本不能为空
    if (!q.question || q.question.trim().length === 0) {
      console.warn(`Filtered: Empty question (label: ${q.label})`);
      return false;
    }
    
    // 过滤条件 2: 题目文本长度不能过短（至少 5 个字符）
    if (q.question.trim().length < 5) {
      console.warn(`Filtered: Question too short (label: ${q.label}, text: ${q.question})`);
      return false;
    }
    
    // 过滤条件 3: 题号不能为空
    if (!q.label || q.label.trim().length === 0) {
      console.warn(`Filtered: Empty label (question: ${q.question.substring(0, 30)}...)`);
      return false;
    }
    
    return true;
  });
}

/**
 * 导出为 JSON 格式
 */
export function exportToJSON(questions: ExtractedQuestion[], outputPath: string): void {
  const output = {
    total: questions.length,
    questions: questions.map(q => ({
      label: q.label,
      type: q.type,
      chapter_title: q.chapter_title,
      question: q.question,
      solution: q.solution,
      images: q.images,
      page_idx: q.page_idx,
      has_answer: q.has_answer
    }))
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Exported ${questions.length} questions to ${outputPath}`);
}

/**
 * 导出为 Markdown 格式
 */
export function exportToMarkdown(questions: ExtractedQuestion[], outputPath: string): void {
  let markdown = `# 提取的题目\n\n`;
  markdown += `**总数**: ${questions.length}\n\n`;
  markdown += `---\n\n`;
  
  let currentChapter = '';
  
  for (const q of questions) {
    // 章节标题
    if (q.chapter_title && q.chapter_title !== currentChapter) {
      currentChapter = q.chapter_title;
      markdown += `## ${currentChapter}\n\n`;
    }
    
    // 题目
    markdown += `### ${q.label} (${q.type === 'example' ? '例题' : '练习题'})\n\n`;
    markdown += `**题目**: ${q.question}\n\n`;
    
    // 图片
    if (q.images && q.images.length > 0) {
      for (const img of q.images) {
        markdown += `![图片](${img})\n\n`;
      }
    }
    
    // 解答（仅对例题）
    if (q.type === 'example' && q.solution) {
      markdown += `**解答**: ${q.solution}\n\n`;
    }
    
    markdown += `---\n\n`;
  }
  
  fs.writeFileSync(outputPath, markdown, 'utf-8');
  console.log(`Exported ${questions.length} questions to ${outputPath}`);
}
