/**
 * 任务处理器 - 负责实际执行题目提取任务
 * 基于DataFlow FlipVQA-Miner的ID-based提取方式
 */

import axios from "axios";
import {
  getExtractionTaskById,
  updateExtractionTask,
  getPageProcessingLogsByTask,
  updatePageProcessingLog,
  getLLMConfigById,
  getPendingPageLogs
} from "./db";
import { storageGet, storagePut } from "./storage";
import {
  LLMConfig,
  ConvertedBlock,
  ExtractedQAPair,
  MergedQAPair,
  convertMinerUContentList,
  parseLLMOutput,
  mergeQAPairs,
  generateResults,
  callLLMForTextExtraction,
  QA_EXTRACT_PROMPT,
  chunkContentBlocks,
  registerTask,
  unregisterTask,
  shouldStopTask,
  isTaskPaused
} from "./extraction";

interface ProcessingContext {
  taskId: number;
  userId: number;
  config: LLMConfig;
  sourceFolder: string;
  imagesFolder: string;
  contentListPath: string;
  convertedBlocks: ConvertedBlock[];
}

// ============= 核心处理逻辑 =============

/**
 * 加载并转换MinerU的content_list.json
 */
async function loadAndConvertContentList(contentListPath: string): Promise<ConvertedBlock[]> {
  try {
    // 从S3获取content_list.json
    const { url } = await storageGet(contentListPath);
    let contentList;
    
    if (url.startsWith('/uploads/')) {
       // 本地文件，直接读取
       const fs = await import('node:fs');
       const path = await import('node:path');
       const filePath = path.resolve(process.cwd(), 'server', url.substring(1)); // Remove leading /
       const fileContent = fs.readFileSync(filePath, 'utf-8');
       contentList = JSON.parse(fileContent);
    } else {
       // 远程URL，使用axios获取
       const response = await axios.get(url, { timeout: 30000 });
       contentList = response.data;
    }
    
    if (!Array.isArray(contentList)) {
      throw new Error("content_list.json should be an array");
    }
    
    return convertMinerUContentList(contentList);
  } catch (error: any) {
    console.error(`Failed to load content_list.json: ${contentListPath}`, error);
    throw new Error(`无法加载content_list.json: ${error.message}`);
  }
}

// 使用extraction.ts中带Overlap的chunkContentBlocks函数

/**
 * 处理单个内容块chunk
 */
async function processChunk(
  ctx: ProcessingContext,
  chunk: ConvertedBlock[],
  chunkIndex: number,
  mode: 'question' | 'answer' = 'question'
): Promise<ExtractedQAPair[]> {
  const chunkJson = JSON.stringify(chunk, null, 2);
  
  try {
    const llmOutput = await callLLMForTextExtraction(
      ctx.config,
      chunkJson,
      QA_EXTRACT_PROMPT
    );
    
    // 调试日志: 记录LLM输出信息
    console.log(`[Chunk ${chunkIndex}] LLM输出长度: ${llmOutput.length} 字符`);
    if (chunkIndex === 0) {
      // 第一个chunk打印前500字符的预览，帮助调试
      console.log(`[Chunk 0 预览]: ${llmOutput.substring(0, 500)}`);
    }
    
    // 检查是否为空输出
    if (llmOutput.includes('<empty></empty>') || llmOutput.includes('<empty/>')) {
      console.log(`[Chunk ${chunkIndex}] LLM返回空结果`);
    }
    
    const qaPairs = parseLLMOutput(
      llmOutput,
      ctx.convertedBlocks,
      `${ctx.imagesFolder}`,
      mode
    );
    
    // 调试日志: 记录解析结果
    console.log(`[Chunk ${chunkIndex}] 解析出 ${qaPairs.length} 个QA对`);
    if (qaPairs.length > 0) {
      const withQuestion = qaPairs.filter(q => q.question).length;
      const withAnswer = qaPairs.filter(q => q.answer || q.solution).length;
      console.log(`[Chunk ${chunkIndex}] 其中: ${withQuestion} 个有题目, ${withAnswer} 个有答案/解答`);
    }
    
    return qaPairs;
  } catch (error: any) {
    console.error(`[Chunk ${chunkIndex}] 处理失败:`, error.message || error);
    throw error;
  }
}

/**
 * 执行完整的提取流程
 */
async function executeExtraction(ctx: ProcessingContext): Promise<MergedQAPair[]> {
  // 将内容块分组
  const chunks = chunkContentBlocks(ctx.convertedBlocks);
  console.log(`Split content into ${chunks.length} chunks`);
  
  const allQuestions: ExtractedQAPair[] = [];
  const allAnswers: ExtractedQAPair[] = [];
  
  // 处理每个chunk
  for (let i = 0; i < chunks.length; i++) {
    if (shouldStopTask(ctx.taskId)) {
      throw new Error(isTaskPaused(ctx.taskId) ? "Task paused" : "Task cancelled");
    }
    
    const chunk = chunks[i];
    
    try {
      // 提取问题和答案
      const qaPairs = await processChunk(ctx, chunk, i, 'question');
      
      // 根据内容分类
      for (const qa of qaPairs) {
        if (qa.question) {
          allQuestions.push(qa);
        }
        if (qa.answer || qa.solution) {
          allAnswers.push(qa);
        }
      }
      
      // 更新进度
      const progress = Math.round(((i + 1) / chunks.length) * 100);
      await updateExtractionTask(ctx.taskId, {
        processedPages: i + 1,
        currentPage: i,
        extractedCount: allQuestions.length
      });
      
    } catch (error: any) {
      console.error(`Chunk ${i} processing failed:`, error);
      // 继续处理下一个chunk
    }
  }
  
  // 汇总日志: 记录提取结果统计
  console.log(`[Summary] 共提取到:`);
  console.log(`  - 题目数量: ${allQuestions.length}`);
  console.log(`  - 答案/解答数量: ${allAnswers.length}`);
  
  // 合并问题和答案
  const merged = mergeQAPairs(allQuestions, allAnswers, false);
  
  console.log(`[Summary] 合并后得到 ${merged.length} 个QA对`);
  
  // 统计合并结果
  const withBoth = merged.filter(m => m.question && (m.answer || m.solution)).length;
  const questionOnly = merged.filter(m => m.question && !m.answer && !m.solution).length;
  const answerOnly = merged.filter(m => !m.question && (m.answer || m.solution)).length;
  console.log(`[Summary] 其中:`);
  console.log(`  - 完整QA对(题目+答案): ${withBoth}`);
  console.log(`  - 仅有题目: ${questionOnly}`);
  console.log(`  - 仅有答案: ${answerOnly}`);
  
  return merged;
}

/**
 * 执行任务处理
 */
export async function executeTaskProcessing(taskId: number, userId: number): Promise<void> {
  // 注册任务状态
  registerTask(taskId);
  
  try {
    // 获取任务信息
    const task = await getExtractionTaskById(taskId, userId);
    if (!task) {
      throw new Error("Task not found");
    }
    
    // 获取LLM配置
    if (!task.configId) {
      throw new Error("No LLM config associated with task");
    }
    
    const config = await getLLMConfigById(task.configId, userId);
    if (!config) {
      throw new Error("LLM config not found");
    }
    
    // 更新任务状态为处理中
    await updateExtractionTask(taskId, {
      status: "processing",
      startedAt: new Date()
    });
    
    // 构建处理上下文
    const contentListPath = task.contentListPath || `${task.sourceFolder}/content_list.json`;
    const imagesFolder = task.imagesFolder || `${task.sourceFolder}/images`;
    
    // 加载并转换content_list.json
    console.log(`Loading content list from: ${contentListPath}`);
    const convertedBlocks = await loadAndConvertContentList(contentListPath);
    console.log(`Loaded ${convertedBlocks.length} content blocks`);
    
    const ctx: ProcessingContext = {
      taskId,
      userId,
      config: {
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        modelName: config.modelName,
        maxWorkers: config.maxWorkers,
        timeout: config.timeout
      },
      sourceFolder: task.sourceFolder,
      imagesFolder,
      contentListPath,
      convertedBlocks
    };
    
    // 更新总页数(使用chunk数量)
    const chunks = chunkContentBlocks(convertedBlocks);
    await updateExtractionTask(taskId, {
      totalPages: chunks.length
    });
    
    // 执行提取
    const mergedQAPairs = await executeExtraction(ctx);
    console.log(`Extracted ${mergedQAPairs.length} QA pairs`);
    
    // 生成结果文件
    const { json: jsonOutput, markdown: mdOutput } = generateResults(mergedQAPairs, imagesFolder);
    
    // 上传结果到S3
    const resultJsonKey = `${task.sourceFolder}/results/questions.json`;
    const resultMdKey = `${task.sourceFolder}/results/questions.md`;
    
    await storagePut(resultJsonKey, Buffer.from(JSON.stringify(jsonOutput, null, 2)), "application/json");
    await storagePut(resultMdKey, Buffer.from(mdOutput), "text/markdown");
    
    // 更新任务为完成状态
    await updateExtractionTask(taskId, {
      status: "completed",
      completedAt: new Date(),
      resultJsonPath: resultJsonKey,
      resultMarkdownPath: resultMdKey,
      extractedCount: mergedQAPairs.length,
      processedPages: chunks.length,
      estimatedTimeRemaining: 0
    });
    
    console.log(`Task ${taskId} completed successfully`);
    
  } catch (error: any) {
    console.error(`Task ${taskId} failed:`, error);
    
    const status = error.message === "Task paused" ? "paused" : "failed";
    await updateExtractionTask(taskId, {
      status,
      errorMessage: status === "failed" ? (error.message || "Unknown error") : null
    });
  } finally {
    unregisterTask(taskId);
  }
}

/**
 * 启动任务处理(非阻塞)
 */
export function startTaskProcessing(taskId: number, userId: number): void {
  // 异步执行,不阻塞响应
  executeTaskProcessing(taskId, userId).catch(err => {
    console.error(`Task ${taskId} processing error:`, err);
  });
}

/**
 * 暂停任务处理
 */
export { pauseTask as pauseTaskProcessing } from "./extraction";

/**
 * 取消任务处理
 */
export { cancelTask as cancelTaskProcessing } from "./extraction";
