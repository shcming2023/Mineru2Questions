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
  getPendingPageLogs,
  logTaskProgress,
  deleteTaskLogs
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
  totalChunks: number;
}

// ============= 核心处理逻辑 =============

/**
 * 加载并转换MinerU的content_list.json
 */
async function loadAndConvertContentList(
  contentListPath: string,
  taskId: number
): Promise<ConvertedBlock[]> {
  await logTaskProgress(taskId, "info", "loading", `开始加载content_list.json: ${contentListPath}`);
  
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
       const response = await axios.get(url, { timeout: 60000 });
       contentList = response.data;
    }
    
    if (!Array.isArray(contentList)) {
      throw new Error("content_list.json should be an array");
    }
    
    await logTaskProgress(taskId, "info", "loading", `成功加载content_list.json, 包含 ${contentList.length} 个原始内容块`);
    
    const convertedBlocks = convertMinerUContentList(contentList);
    
    await logTaskProgress(taskId, "info", "loading", `内容转换完成, 生成 ${convertedBlocks.length} 个处理块`, {
      originalCount: contentList.length,
      convertedCount: convertedBlocks.length
    });
    
    return convertedBlocks;
  } catch (error: any) {
    await logTaskProgress(taskId, "error", "loading", `加载content_list.json失败: ${error.message}`, {
      path: contentListPath,
      error: error.message
    });
    throw new Error(`无法加载content_list.json: ${error.message}`);
  }
}

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
  const startTime = Date.now();
  
  await logTaskProgress(
    ctx.taskId, 
    "info", 
    "extracting", 
    `开始处理Chunk ${chunkIndex + 1}/${ctx.totalChunks}, 包含 ${chunk.length} 个内容块`,
    { chunkSize: chunk.length, jsonLength: chunkJson.length },
    chunkIndex,
    ctx.totalChunks
  );
  
  try {
    const llmOutput = await callLLMForTextExtraction(
      ctx.config,
      chunkJson,
      QA_EXTRACT_PROMPT
    );
    
    const llmTime = Date.now() - startTime;
    
    // 检查是否为空输出
    const isEmpty = llmOutput.includes('<empty></empty>') || llmOutput.includes('<empty/>');
    
    await logTaskProgress(
      ctx.taskId,
      isEmpty ? "warn" : "debug",
      "extracting",
      `Chunk ${chunkIndex + 1} LLM响应完成, 耗时 ${(llmTime / 1000).toFixed(1)}s, 输出 ${llmOutput.length} 字符${isEmpty ? ' (空结果)' : ''}`,
      { llmTime, outputLength: llmOutput.length, isEmpty },
      chunkIndex,
      ctx.totalChunks
    );
    
    const qaPairs = parseLLMOutput(
      llmOutput,
      ctx.convertedBlocks,
      `${ctx.imagesFolder}`,
      mode
    );
    
    // 统计结果
    const withQuestion = qaPairs.filter(q => q.question).length;
    const withAnswer = qaPairs.filter(q => q.answer || q.solution).length;
    
    await logTaskProgress(
      ctx.taskId,
      "info",
      "extracting",
      `Chunk ${chunkIndex + 1} 解析完成: 提取 ${qaPairs.length} 个QA对 (${withQuestion} 题目, ${withAnswer} 答案)`,
      { 
        totalPairs: qaPairs.length, 
        questions: withQuestion, 
        answers: withAnswer,
        processingTime: Date.now() - startTime
      },
      chunkIndex,
      ctx.totalChunks
    );
    
    return qaPairs;
  } catch (error: any) {
    await logTaskProgress(
      ctx.taskId,
      "error",
      "extracting",
      `Chunk ${chunkIndex + 1} 处理失败: ${error.message}`,
      { error: error.message, stack: error.stack },
      chunkIndex,
      ctx.totalChunks
    );
    throw error;
  }
}

/**
 * 执行完整的提取流程
 */
async function executeExtraction(ctx: ProcessingContext): Promise<MergedQAPair[]> {
  // 将内容块分组
  const chunks = chunkContentBlocks(ctx.convertedBlocks);
  ctx.totalChunks = chunks.length;
  
  await logTaskProgress(
    ctx.taskId,
    "info",
    "chunking",
    `内容分块完成: 共 ${chunks.length} 个Chunk, 总计 ${ctx.convertedBlocks.length} 个内容块`,
    { 
      totalChunks: chunks.length, 
      totalBlocks: ctx.convertedBlocks.length,
      avgBlocksPerChunk: Math.round(ctx.convertedBlocks.length / chunks.length)
    }
  );
  
  const allQuestions: ExtractedQAPair[] = [];
  const allAnswers: ExtractedQAPair[] = [];
  let failedChunks = 0;
  
  // 处理每个chunk
  for (let i = 0; i < chunks.length; i++) {
    if (shouldStopTask(ctx.taskId)) {
      const reason = isTaskPaused(ctx.taskId) ? "用户暂停" : "用户取消";
      await logTaskProgress(ctx.taskId, "warn", "extracting", `任务被${reason}, 已处理 ${i}/${chunks.length} 个Chunk`);
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
      await updateExtractionTask(ctx.taskId, {
        processedPages: i + 1,
        currentPage: i,
        extractedCount: allQuestions.length
      });
      
    } catch (error: any) {
      failedChunks++;
      // 继续处理下一个chunk,但记录失败
      await logTaskProgress(
        ctx.taskId,
        "warn",
        "extracting",
        `Chunk ${i + 1} 处理失败,继续处理下一个: ${error.message}`,
        { chunkIndex: i, error: error.message },
        i,
        chunks.length
      );
    }
  }
  
  // 汇总日志
  await logTaskProgress(
    ctx.taskId,
    "info",
    "merging",
    `所有Chunk处理完成: 成功 ${chunks.length - failedChunks}/${chunks.length}, 提取 ${allQuestions.length} 题目, ${allAnswers.length} 答案`,
    {
      totalChunks: chunks.length,
      successChunks: chunks.length - failedChunks,
      failedChunks,
      totalQuestions: allQuestions.length,
      totalAnswers: allAnswers.length
    }
  );
  
  // 合并问题和答案
  const merged = mergeQAPairs(allQuestions, allAnswers, false);
  
  // 统计合并结果
  const withBoth = merged.filter(m => m.question && (m.answer || m.solution)).length;
  const questionOnly = merged.filter(m => m.question && !m.answer && !m.solution).length;
  const answerOnly = merged.filter(m => !m.question && (m.answer || m.solution)).length;
  
  await logTaskProgress(
    ctx.taskId,
    "info",
    "merging",
    `问答合并完成: 共 ${merged.length} 个QA对 (完整配对: ${withBoth}, 仅题目: ${questionOnly}, 仅答案: ${answerOnly})`,
    {
      totalMerged: merged.length,
      completeQA: withBoth,
      questionOnly,
      answerOnly,
      matchRate: allQuestions.length > 0 ? (withBoth / allQuestions.length * 100).toFixed(1) + '%' : 'N/A'
    }
  );
  
  return merged;
}

/**
 * 执行任务处理
 */
export async function executeTaskProcessing(taskId: number, userId: number): Promise<void> {
  // 注册任务状态
  registerTask(taskId);
  
  // 清除旧的日志
  await deleteTaskLogs(taskId);
  
  await logTaskProgress(taskId, "info", "init", "任务开始执行");
  
  try {
    // 获取任务信息
    const task = await getExtractionTaskById(taskId, userId);
    if (!task) {
      throw new Error("Task not found");
    }
    
    await logTaskProgress(taskId, "info", "init", `任务信息: ${task.name}`, {
      taskName: task.name,
      sourceFolder: task.sourceFolder
    });
    
    // 获取LLM配置
    if (!task.configId) {
      throw new Error("No LLM config associated with task");
    }
    
    const config = await getLLMConfigById(task.configId, userId);
    if (!config) {
      throw new Error("LLM config not found");
    }
    
    await logTaskProgress(taskId, "info", "init", `使用LLM配置: ${config.name} (${config.modelName})`, {
      configName: config.name,
      modelName: config.modelName,
      apiUrl: config.apiUrl.replace(/\/[^/]*$/, '/***') // 隐藏敏感部分
    });
    
    // 更新任务状态为处理中
    await updateExtractionTask(taskId, {
      status: "processing",
      startedAt: new Date()
    });
    
    // 构建处理上下文
    const contentListPath = task.contentListPath || `${task.sourceFolder}/content_list.json`;
    const imagesFolder = task.imagesFolder || `${task.sourceFolder}/images`;
    
    // 加载并转换content_list.json
    const convertedBlocks = await loadAndConvertContentList(contentListPath, taskId);
    
    // 预计算chunk数量
    const chunks = chunkContentBlocks(convertedBlocks);
    
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
      convertedBlocks,
      totalChunks: chunks.length
    };
    
    // 更新总页数(使用chunk数量)
    await updateExtractionTask(taskId, {
      totalPages: chunks.length
    });
    
    // 执行提取
    const mergedQAPairs = await executeExtraction(ctx);
    
    // 生成结果文件
    await logTaskProgress(taskId, "info", "saving", "开始生成结果文件...");
    
    const { json: jsonOutput, markdown: mdOutput } = generateResults(mergedQAPairs, imagesFolder);
    
    // 上传结果到S3
    const resultJsonKey = `${task.sourceFolder}/results/questions.json`;
    const resultMdKey = `${task.sourceFolder}/results/questions.md`;
    
    await storagePut(resultJsonKey, Buffer.from(JSON.stringify(jsonOutput, null, 2)), "application/json");
    await storagePut(resultMdKey, Buffer.from(mdOutput), "text/markdown");
    
    await logTaskProgress(taskId, "info", "saving", "结果文件已保存", {
      jsonPath: resultJsonKey,
      mdPath: resultMdKey,
      totalQAPairs: mergedQAPairs.length
    });
    
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
    
    await logTaskProgress(taskId, "info", "completed", `任务完成! 共提取 ${mergedQAPairs.length} 个QA对`);
    
  } catch (error: any) {
    const status = error.message === "Task paused" ? "paused" : "failed";
    
    await logTaskProgress(
      taskId,
      status === "failed" ? "error" : "warn",
      status,
      status === "failed" ? `任务失败: ${error.message}` : "任务已暂停",
      { error: error.message, stack: error.stack }
    );
    
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
