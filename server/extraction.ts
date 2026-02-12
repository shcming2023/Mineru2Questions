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
import axiosRetry from 'axios-retry';
import { QuestionParser, ExtractedQuestion } from './parser';
import { QUESTION_EXTRACT_PROMPT } from './prompts';
import { ChapterFlatEntry, findChapterForBlock } from './chapterPreprocess';

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
const OVERLAP_SIZE = 30;           // 重叠窗口大小，避免题目被切断 (Increased to 30 as per Test 3 report)
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
  llmConfig: LLMConfig,
  chapterFlatMap: ChapterFlatEntry[] | null,
  onProgress?: (progress: number, message: string, stats?: { currentChunk?: number, totalChunks?: number, completedChunks?: number }) => Promise<void>
): Promise<ExtractedQuestion[]> {
  
  // 1. 加载并格式化输入
  if (onProgress) await onProgress(5, 'Loading and formatting content...');
  const blocks = loadAndFormatBlocks(contentListPath);
  
  // Debug: 保存格式化后的 blocks
  const debugDir = path.join(taskDir, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  fs.writeFileSync(path.join(debugDir, 'formatted_blocks.json'), JSON.stringify(blocks, null, 2));

  // 2. 分块处理
  if (onProgress) await onProgress(10, 'Splitting content into chunks...');
  const chunks = splitIntoChunks(blocks, MAX_CHUNK_SIZE, OVERLAP_SIZE);
  
  // 3. 调用 LLM 提取题目 (并发处理)
   const maxConcurrency = llmConfig.maxWorkers || 5;

  // 初始化结果数组，保证顺序
  const chunkResults = new Array<ExtractedQuestion[]>(chunks.length);
  let completedCount = 0; // 追踪已完成的 Chunk 数量
  
  // 创建任务队列
  const queue = chunks.map((chunk, i) => ({ chunk, index: i }));
  
  // 定义工作函数
  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      
      const { chunk, index } = item;
      const progressPercent = 10 + Math.floor(((index + 1) / chunks.length) * 80);
      const progressMsg = `开始处理Chunk ${index + 1}/${chunks.length}`;
      if (onProgress) await onProgress(progressPercent, progressMsg, { currentChunk: index + 1, totalChunks: chunks.length });

      let retries = 0;
      const maxRetries = 3;
      let success = false;

      while (retries <= maxRetries && !success) {
        try {
          // 调用 LLM
          const llmOutput = await callLLM(chunk.blocks, llmConfig, { taskDir, chunkIndex: chunk.index });
          
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
          
          if (onProgress) {
            await onProgress(progressPercent, `LLM响应接收 Chunk ${index + 1}/${chunks.length}`, { currentChunk: index + 1, totalChunks: chunks.length });
          }

          const parser = new QuestionParser(chunk.blocks, imagesFolder, logDir);
          const questions = parser.parseWithFallback(llmOutput, chunk.index);

          // Sanity Check: 检测 LLM 注意力衰减
          // 修复：使用比例检测而非固定阈值，避免误报
          // 建议阈值：题目数量 / block 数量 < 0.02 (即每 50 个 block 至少应有一个题目)
          if (chunk.blocks.length > 40 && (questions.length / chunk.blocks.length < 0.02)) {
             // 进一步检查：是不是真的只有文本很少？
             // 简单策略：只要 blocks 多但产出少，就怀疑有问题。
             // 除非这是最后一次重试，否则我们应该重试。
             if (retries < maxRetries) {
                throw new Error(`Sanity Check Failed: Input has ${chunk.blocks.length} blocks but only ${questions.length} questions extracted (Ratio: ${(questions.length / chunk.blocks.length).toFixed(3)}). Suspected LLM attention decay.`);
             } else {
                console.warn(`Chunk ${chunk.index}: Sanity check failed but reached max retries. Accepting result.`);
             }
          }
          
          chunkResults[index] = questions;
          completedCount++;
          if (onProgress) {
            await onProgress(progressPercent, `Chunk ${index + 1}/${chunks.length} 处理完毕`, { 
              currentChunk: index + 1, 
              totalChunks: chunks.length,
              completedChunks: completedCount
            });
          }
          success = true;
          
        } catch (error: any) {
          retries++;
          console.error(`Chunk ${chunk.index}: Failed to process (Attempt ${retries}/${maxRetries + 1}): ${error.message}`);
          
          if (retries > maxRetries) {
            // 最终失败处理
            const logDir = path.join(taskDir, 'logs');
            try {
              if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
              }
              const errorLogPath = path.join(logDir, `chunk_${chunk.index}_error.json`);
              const errorPayload = {
                chunkIndex: chunk.index,
                message: error?.message ?? 'Unknown error',
                stack: error?.stack ?? null,
                apiUrl: llmConfig.apiUrl,
                modelName: llmConfig.modelName,
                timestamp: new Date().toISOString()
              };
              fs.writeFileSync(errorLogPath, JSON.stringify(errorPayload, null, 2));
            } catch (logError) {
              console.error(`Chunk ${chunk.index}: Failed to write error log:`, logError);
            }
            // 出错时返回空数组，不影响其他 chunk
            chunkResults[index] = [];
          } else {
             // 等待后重试 (指数退避)
             const delay = 1000 * Math.pow(2, retries);
             await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }
  };

  // 启动 Worker
  const workers = Array(Math.min(maxConcurrency, chunks.length)).fill(null).map(() => worker());
  await Promise.all(workers);

  // 合并结果
  const allQuestions = chunkResults.flat();
  
  if (onProgress) await onProgress(90, 'Deduplicating and filtering questions...');
  
  // 4. 去重（基于 questionIds）
  const uniqueQuestions = deduplicateQuestions(allQuestions);
  
  // 5. 题目类型识别（如果 LLM 未提供）
  for (const q of uniqueQuestions) {
    if (!q.type || (q.type !== 'example' && q.type !== 'exercise')) {
      q.type = identifyQuestionType(q.label);
    }
  }

  // 5.5. 章节标题处理
  let cleanedQuestions: ExtractedQuestion[];
  if (chapterFlatMap && chapterFlatMap.length > 0) {
    // 使用预处理的章节目录树覆盖 LLM 自行判断的章节标题
    console.log(`[Extraction] 使用章节预处理结果覆盖章节标题 (${chapterFlatMap.length} 个章节条目)`);
    for (const q of uniqueQuestions) {
      // 通过 questionIds 的第一个 ID 查找所属章节
      if (q.questionIds) {
        const firstId = parseInt(q.questionIds.split(',')[0].trim(), 10);
        if (!isNaN(firstId)) {
          const chapterPath = findChapterForBlock(firstId, chapterFlatMap);
          if (chapterPath) {
            q.chapter_title = chapterPath;
          }
        }
      }
    }
    cleanedQuestions = uniqueQuestions;
  } else {
    // 回退：使用原有的章节标题清洗逻辑
    cleanedQuestions = cleanChapterTitles(uniqueQuestions);
  }
  
  // 6. 质量过滤
  const filteredQuestions = filterLowQuality(cleanedQuestions);
  
  if (onProgress) await onProgress(100, 'Extraction completed');
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
    // 1. 过滤噪声块
    if (['page_number', 'footer', 'header'].includes(block.type)) {
      continue;
    }
    
    // 1.1 TOC Filtering (Added as per Test 3 report)
    // Filter blocks that look like Table of Contents entries (e.g. "Chapter 1 ...... 10")
    if (block.text && (block.text.trim() === '目录' || block.text.match(/\.{4,}\s*\d+$/))) {
       continue;
    }

    // 2. 展平 list 块
    if (block.type === 'list' && block.list_items) {
      for (const itemText of block.list_items) {
        convertedBlocks.push({
          id: currentId++,
          type: 'text', // 将 list_item 转换为 text 类型
          text: itemText.trim(),
          page_idx: block.page_idx,
        });
      }
      continue; // 继续下一个原始 block
    }

    // 3. 拆分 table 块
    const tableContent = block.text || (block as any).table_body;
    if (block.type === 'table' && typeof tableContent === 'string' && tableContent.includes('<tr')) {
      const rows = tableContent.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      for (const rowHtml of rows) {
        convertedBlocks.push({
          id: currentId++,
          type: 'text',
          text: `[Table Row] ${rowHtml}`,
          page_idx: block.page_idx,
        });
      }
      continue;
    }

    // 4. 处理其他类型 (text, equation, image)
    // 分配 ID (如果 block.id 存在则使用，否则使用 currentId)
    // 注意：为了保证 ID 连续性，建议统一使用 currentId 重排
    const newBlock: ConvertedBlock = {
      id: currentId, 
      type: block.type,
      page_idx: block.page_idx
    };

    if (block.text) {
      newBlock.text = block.text.trim(); // 保留 text, 无论 type 是 text 还是 equation
    }

    if (block.type === 'image' && block.img_path) {
      newBlock.img_path = block.img_path;
      if (block.image_caption && block.image_caption.length > 0) {
        newBlock.image_caption = block.image_caption.join(' ');
      }
    }

    convertedBlocks.push(newBlock);
    currentId++;
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
    
    // 如果已经处理到末尾，结束循环
    if (end === blocks.length) break;
    
    start = end - overlapSize; // 重叠窗口
    
    // 避免死循环（如果 overlapSize >= maxSize）
    if (start >= end) break;
  }
  
  return chunks;
}

/**
 * 调用 LLM 提取题目
 */
async function callLLM(
  blocks: ConvertedBlock[], 
  config: LLMConfig, 
  debugInfo?: { taskDir: string, chunkIndex: number }
): Promise<string> {
  // 构建输入
  const inputJson = JSON.stringify(blocks, null, 2);
  const prompt = `${QUESTION_EXTRACT_PROMPT}\n\n## Input JSON:\n\`\`\`json\n${inputJson}\n\`\`\``;
  
  // Debug: 保存 Prompt
  if (debugInfo) {
    const debugDir = path.join(debugInfo.taskDir, 'debug');
    try {
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, `chunk_${debugInfo.chunkIndex}_prompt.txt`), prompt);
    } catch (e) {
      console.warn('Failed to save debug prompt:', e);
    }
  }

  const base = config.apiUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;

  // 创建 axios 实例并配置重试
  const client = axios.create({
    timeout: config.timeout || 60000,
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  axiosRetry(client, {
    retries: config.maxRetries || 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
      // 在网络错误或 5xx 状态码时重试
      return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
             (error.response?.status ? error.response.status >= 500 : false);
    }
  });

  const response = await client.post(
    endpoint,
    {
      model: config.modelName,
      messages: [
        { role: 'system', content: 'You are an expert in extracting questions from educational materials.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000
    }
  );
  
  return response.data.choices[0].message.content;
}

/**
 * 去重：优先使用 (chapter_title, label) 组合键，兼容 questionIds
 */
function deduplicateQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const seen = new Set<string>();
  const unique: ExtractedQuestion[] = [];
  
  for (const q of questions) {
    // 修复：使用 questionIds 作为唯一键，对齐官方策略
    const key = q.questionIds;

    // 必须有 questionIds 才能参与去重
    if (key && key.trim().length > 0) {
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(q);
      }
    } else {
      // 对于没有 questionIds 的（理论上不应发生），直接放入
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
  const outputDir = path.dirname(outputPath);

  const output = {
    total: questions.length,
    questions: questions.map(q => ({
      label: q.label,
      type: q.type,
      chapter_title: q.chapter_title,
      question: q.question,
      solution: q.solution,
      // 修复：将绝对路径转换为相对路径，提升可移植性
      images: q.images?.map(img => {
        if (path.isAbsolute(img)) {
          return path.relative(outputDir, img);
        }
        return img;
      }),
      page_idx: q.page_idx,
      has_answer: q.has_answer,
      // 新增以下字段
      questionIds: q.questionIds,
      solutionIds: q.solutionIds,
      chapterTitleIds: q.chapterTitleIds
    }))
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
}

/**
 * 导出为 Markdown 格式
 */
export function exportToMarkdown(questions: ExtractedQuestion[], outputPath: string): void {
  const outputDir = path.dirname(outputPath);

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
        // 修复：转为相对路径
        const relPath = path.isAbsolute(img) ? path.relative(outputDir, img) : img;
        markdown += `![图片](${relPath})\n\n`;
      }
    }
    
    // 解答（仅对例题）
    if (q.type === 'example' && q.solution) {
      markdown += `**解答**: ${q.solution}\n\n`;
    }
    
    markdown += `---\n\n`;
  }
  
  fs.writeFileSync(outputPath, markdown, 'utf-8');
}

/**
 * 清洗章节标题 (增强版 v1.2)
 * 1. 题号连续性检测：防止误将子标题识别为新章节
 * 2. 章节标题规范化：提取章节编号，去除冗余文本
 * 3. 黑名单过滤：过滤无效标题
 */
export function cleanChapterTitles(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const titleBlacklist = ["选择题", "填空题", "判断题", "应用题", "计算题", "递等式", "竖式", "基础训练", "拓展训练"];
  
  // 1. 第一遍：题号连续性检测 (P1 #3)
  // 如果题号连续 (如 10->11) 但章节标题变化，且新标题可能是噪声（在黑名单中），则回退到上一个有效标题
  let lastValidTitle = "";
  let lastLabelNum = -1;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const currentLabelNum = parseLabelToNumber(q.label);
    
    // 检查题号是否连续
    const isConsecutive = (lastLabelNum !== -1 && currentLabelNum === lastLabelNum + 1);
    
    // 检查新标题是否在黑名单中
    const isNoiseTitle = q.chapter_title && titleBlacklist.some(keyword => q.chapter_title!.includes(keyword));

    // 如果题号连续但章节标题变化，且新标题是噪声，则回退
    if (isConsecutive && lastValidTitle && q.chapter_title && q.chapter_title !== lastValidTitle) {
      if (isNoiseTitle) {
        console.warn(`[Chapter Continuity] Reverting noise title for Q${q.label}: "${q.chapter_title}" -> "${lastValidTitle}"`);
        q.chapter_title = lastValidTitle;
      }
    }

    // 更新最后有效标题 (如果不是噪声)
    // 注意：如果当前标题被回退了，q.chapter_title 已经是 lastValidTitle，所以这里 logic 没问题
    // 但如果当前标题是新的有效标题 (如 20.1)，我们更新 lastValidTitle
    if (q.chapter_title && !titleBlacklist.some(keyword => q.chapter_title!.includes(keyword))) {
      lastValidTitle = q.chapter_title;
    }
    
    // 更新最后有效题号 (只在解析成功时更新)
    if (currentLabelNum !== -1) {
      lastLabelNum = currentLabelNum;
    } else {
      // 如果解析失败，重置连续性检查，避免错误关联
      lastLabelNum = -1; 
    }
  }

  // 2. 第二遍：标题规范化与黑名单过滤 (P0 #2)
  lastValidTitle = "";
  
  return questions.map(q => {
    let title = q.chapter_title || "";
    
    // 规范化：提取章节编号 (对齐官方 refine_title)
    title = refineTitle(title);
    
    // 黑名单检查
    const isNoiseTitle = titleBlacklist.some(keyword => title.includes(keyword));
    
    if (isNoiseTitle || !title) {
       // 如果是噪声或空，尝试使用上一个有效标题
       if (lastValidTitle) {
         title = lastValidTitle;
       }
    } else {
       // 如果是有效标题，更新
       lastValidTitle = title;
    }
    
    q.chapter_title = title;
    return q;
  });
}

/**
 * 解析题号为数字
 * 支持 "1", "1.", "(1)", "Example 1" 等格式
 */
function parseLabelToNumber(label: string): number {
  if (!label) return -1;
  // 提取第一个连续数字序列
  const match = label.match(/\d+/);
  return match ? parseInt(match[0], 10) : -1;
}

/**
 * 规范化章节标题
 * 对齐官方 refine_title 实现
 */
function refineTitle(title: string): string {
  if (!title) return "";
  
  // 1. 去除空白字符
  let newTitle = title.replace(/\s+/g, '');
  
  // 2. 优先提取阿拉伯数字编号 (如 "19.2", "1")
  const arabicMatch = newTitle.match(/(\d+(\.\d+)*)/);
  if (arabicMatch) {
    return arabicMatch[0];
  }
  
  // 3. 其次提取中文数字编号 (如 "第一章", "二")
  // 注意：官方正则 r'[一二...]+' 会提取 "第一章" 中的 "一"，这里保持一致但稍微放宽以包含常见单位
  const chineseMatch = newTitle.match(/[一二三四五六七八九十百零]+/);
  if (chineseMatch) {
    return chineseMatch[0];
  }
  
  // 4. 如果都无法提取，返回去空后的标题
  return newTitle;
}

// ============= 任务控制存根 (兼容 routers.ts) =============

export function pauseTask(taskId: number): void {
  console.warn(`[Task ${taskId}] pauseTask called (deprecated in v1.1)`);
}

export function resumeTask(taskId: number): void {
  console.warn(`[Task ${taskId}] resumeTask called (deprecated in v1.1)`);
}

export function cancelTask(taskId: number): void {
  console.warn(`[Task ${taskId}] cancelTask called (deprecated in v1.1)`);
}

export function isTaskPaused(taskId: number): boolean {
  return false;
}
