/**
 * 任务处理器 - 负责实际执行题目提取任务
 * 基于DataFlow FlipVQA-Miner的ID-based提取方式
 * 支持并发处理以提高吞吐量
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

interface ChunkResult {
  index: number;
  questions: ExtractedQAPair[];
  answers: ExtractedQAPair[];
  success: boolean;
  error?: string;
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
 * 获取chunk的页码范围信息
 */
function getChunkPageRange(chunk: ConvertedBlock[]): { minPage: number; maxPage: number; pageCount: number } {
  const pages = new Set<number>();
  for (const block of chunk) {
    // ConvertedBlock可能没有page_idx,需要从原始数据中获取
    // 这里用ID估算页码(假设每页约20个块)
    const estimatedPage = Math.floor(block.id / 20) + 1;
    pages.add(estimatedPage);
  }
  const pageArray = Array.from(pages).sort((a, b) => a - b);
  return {
    minPage: pageArray[0] || 0,
    maxPage: pageArray[pageArray.length - 1] || 0,
    pageCount: pageArray.length
  };
}

/**
 * 处理单个内容块chunk (返回Promise)
 */
async function processChunk(
  ctx: ProcessingContext,
  chunk: ConvertedBlock[],
  chunkIndex: number,
  mode: 'question' | 'answer' = 'question'
): Promise<ExtractedQAPair[]> {
  const chunkJson = JSON.stringify(chunk, null, 2);
  const startTime = Date.now();
  
  // 获取页码范围信息
  const pageRange = getChunkPageRange(chunk);
  const idRange = chunk.length > 0 ? `ID ${chunk[0].id}-${chunk[chunk.length - 1].id}` : 'N/A';
  
  await logTaskProgress(
    ctx.taskId, 
    "info", 
    "extracting", 
    `开始处理Chunk ${chunkIndex + 1}/${ctx.totalChunks}: ${chunk.length}个内容块, ${idRange}, 估计页码 ${pageRange.minPage}-${pageRange.maxPage}`,
    { 
      chunkSize: chunk.length, 
      jsonLength: chunkJson.length,
      idStart: chunk[0]?.id,
      idEnd: chunk[chunk.length - 1]?.id,
      estimatedPageRange: `${pageRange.minPage}-${pageRange.maxPage}`
    },
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
    
    // 保存LLM原始响应到日志文件(便于调试)
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const logDir = path.resolve(process.cwd(), 'server', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `llm_raw_task_${ctx.taskId}_chunk_${chunkIndex}.txt`);
      fs.writeFileSync(logFile, `=== Chunk ${chunkIndex + 1} LLM Response ===\nTime: ${new Date().toISOString()}\nLength: ${llmOutput.length} chars\n\n${llmOutput}`);
    } catch (logErr) {
      console.error('Failed to save LLM raw log:', logErr);
    }
    
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
    
    let qaPairs = parseLLMOutput(
      llmOutput,
      ctx.convertedBlocks,
      `${ctx.imagesFolder}`,
      mode
    );
    
    // Fallback: 如果LLM解析结果为空,尝试使用简易拆分器
    if (qaPairs.length === 0) {
      const { splitMultiQuestionFallback } = await import('./extraction');
      qaPairs = splitMultiQuestionFallback(chunk, chunkIndex);
      if (qaPairs.length > 0) {
        await logTaskProgress(
          ctx.taskId,
          "warn",
          "extracting",
          `Chunk ${chunkIndex + 1} LLM解析为空,使用Fallback拆分器提取了 ${qaPairs.length} 个题目`,
          { fallbackCount: qaPairs.length },
          chunkIndex,
          ctx.totalChunks
        );
      }
    }
    
    // 统计结果
    const withQuestion = qaPairs.filter(q => q.question).length;
    const withAnswer = qaPairs.filter(q => q.answer || q.solution).length;
    const withImages = qaPairs.filter(q => q.images && q.images.length > 0).length;
    const totalImages = qaPairs.reduce((sum, q) => sum + (q.images?.length || 0), 0);
    
    // 提取题号列表用于日志
    const labels = qaPairs.map(q => q.label).filter(Boolean).slice(0, 10);
    const labelSummary = labels.length > 0 
      ? `题号: ${labels.join(', ')}${qaPairs.length > 10 ? '...' : ''}`
      : '无题号';
    
    await logTaskProgress(
      ctx.taskId,
      "info",
      "extracting",
      `Chunk ${chunkIndex + 1} 解析完成: ${qaPairs.length}个QA对 (题目:${withQuestion}, 答案:${withAnswer}, 带图:${withImages}, 图片数:${totalImages}) | ${labelSummary}`,
      { 
        totalPairs: qaPairs.length, 
        questions: withQuestion, 
        answers: withAnswer,
        withImages,
        totalImages,
        labels: labels,
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
      `Chunk ${chunkIndex + 1} LLM调用失败: ${error.message}`,
      { error: error.message, stack: error.stack },
      chunkIndex,
      ctx.totalChunks
    );
    
    // LLM调用失败时也尝试使用Fallback拆分器
    try {
      const { splitMultiQuestionFallback } = await import('./extraction');
      const fallbackPairs = splitMultiQuestionFallback(chunk, chunkIndex);
      if (fallbackPairs.length > 0) {
        await logTaskProgress(
          ctx.taskId,
          "warn",
          "extracting",
          `Chunk ${chunkIndex + 1} LLM失败后使用Fallback拆分器提取了 ${fallbackPairs.length} 个题目`,
          { fallbackCount: fallbackPairs.length, originalError: error.message },
          chunkIndex,
          ctx.totalChunks
        );
        return fallbackPairs;
      }
    } catch (fallbackErr: any) {
      await logTaskProgress(
        ctx.taskId,
        "error",
        "extracting",
        `Chunk ${chunkIndex + 1} Fallback拆分器也失败: ${fallbackErr.message}`,
        { fallbackError: fallbackErr.message },
        chunkIndex,
        ctx.totalChunks
      );
    }
    
    throw error;
  }
}

/**
 * 处理单个chunk并返回结果(包装器,用于并发)
 */
async function processChunkWithResult(
  ctx: ProcessingContext,
  chunk: ConvertedBlock[],
  chunkIndex: number
): Promise<ChunkResult> {
  try {
    const qaPairs = await processChunk(ctx, chunk, chunkIndex, 'question');
    
    const questions: ExtractedQAPair[] = [];
    const answers: ExtractedQAPair[] = [];
    
    for (const qa of qaPairs) {
      // 标记来源chunk索引,用于后续排序
      qa.chunkIndex = chunkIndex;
      if (qa.question) {
        questions.push(qa);
      }
      if (qa.answer || qa.solution) {
        answers.push(qa);
      }
    }
    
    return {
      index: chunkIndex,
      questions,
      answers,
      success: true
    };
  } catch (error: any) {
    return {
      index: chunkIndex,
      questions: [],
      answers: [],
      success: false,
      error: error.message
    };
  }
}

/**
 * 执行完整的提取流程 (支持并发)
 */
async function executeExtraction(ctx: ProcessingContext): Promise<MergedQAPair[]> {
  // 将内容块分组
  const chunks = chunkContentBlocks(ctx.convertedBlocks);
  ctx.totalChunks = chunks.length;
  
  // 获取并发数配置
  const maxConcurrency = ctx.config.maxWorkers || 5;
  
  await logTaskProgress(
    ctx.taskId,
    "info",
    "chunking",
    `内容分块完成: 共 ${chunks.length} 个Chunk, 总计 ${ctx.convertedBlocks.length} 个内容块, 最大并发数: ${maxConcurrency}`,
    { 
      totalChunks: chunks.length, 
      totalBlocks: ctx.convertedBlocks.length,
      avgBlocksPerChunk: Math.round(ctx.convertedBlocks.length / chunks.length),
      maxConcurrency
    }
  );
  
  const allQuestions: ExtractedQAPair[] = [];
  const allAnswers: ExtractedQAPair[] = [];
  let failedChunks = 0;
  let completedChunks = 0;
  
  // ============= 并发控制核心逻辑 =============
  const activePromises: Set<Promise<ChunkResult>> = new Set();
  const results: ChunkResult[] = [];
  
  await logTaskProgress(ctx.taskId, "info", "extracting", `启动并发处理: 最大并发数 ${maxConcurrency}`);
  
  for (let i = 0; i < chunks.length; i++) {
    // 1. 检查任务是否停止
    if (shouldStopTask(ctx.taskId)) {
      const reason = isTaskPaused(ctx.taskId) ? "用户暂停" : "用户取消";
      await logTaskProgress(ctx.taskId, "warn", "extracting", `任务被${reason}, 已启动 ${i}/${chunks.length} 个Chunk`);
      // 等待已发出的请求完成
      if (activePromises.size > 0) {
        await logTaskProgress(ctx.taskId, "info", "extracting", `等待 ${activePromises.size} 个进行中的请求完成...`);
        const remainingResults = await Promise.all(activePromises);
        results.push(...remainingResults);
      }
      throw new Error(isTaskPaused(ctx.taskId) ? "Task paused" : "Task cancelled");
    }
    
    const chunk = chunks[i];
    
    // 2. 创建异步任务 (不立即await)
    const taskPromise = processChunkWithResult(ctx, chunk, i);
    activePromises.add(taskPromise);
    
    // 任务完成后的处理
    taskPromise.then(result => {
      activePromises.delete(taskPromise);
      results.push(result);
      completedChunks++;
      
      if (result.success) {
        allQuestions.push(...result.questions);
        allAnswers.push(...result.answers);
      } else {
        failedChunks++;
      }
      
      // 更新进度 (异步,不阻塞)
      updateExtractionTask(ctx.taskId, {
        processedPages: completedChunks,
        currentPage: result.index,
        extractedCount: allQuestions.length
      }).catch(err => console.error('Failed to update progress:', err));
    });
    
    // 3. 拥塞控制: 如果并发池满了,等待任意一个任务完成
    if (activePromises.size >= maxConcurrency) {
      await Promise.race(activePromises);
    }
  }
  
  // 4. 等待所有剩余任务完成
  if (activePromises.size > 0) {
    await logTaskProgress(ctx.taskId, "info", "extracting", `等待剩余 ${activePromises.size} 个任务完成...`);
    await Promise.all(activePromises);
  }
  
  // 5. 再次检查停止状态
  if (shouldStopTask(ctx.taskId)) {
    const reason = isTaskPaused(ctx.taskId) ? "用户暂停" : "用户取消";
    throw new Error(isTaskPaused(ctx.taskId) ? "Task paused" : "Task cancelled");
  }
  
  // 统计提取阶段的图片关联情况
  const questionsWithImages = allQuestions.filter(q => q.images && q.images.length > 0).length;
  const totalQuestionImages = allQuestions.reduce((sum, q) => sum + (q.images?.length || 0), 0);
  
  // 汇总日志
  await logTaskProgress(
    ctx.taskId,
    "info",
    "merging",
    `所有Chunk处理完成: 成功 ${chunks.length - failedChunks}/${chunks.length}, 提取 ${allQuestions.length} 题目, ${allAnswers.length} 答案, ${questionsWithImages} 题带图片(${totalQuestionImages}张)`,
    {
      totalChunks: chunks.length,
      successChunks: chunks.length - failedChunks,
      failedChunks,
      totalQuestions: allQuestions.length,
      totalAnswers: allAnswers.length,
      questionsWithImages,
      totalQuestionImages
    }
  );
  
  // 合并问题和答案
  // 重要: 并发处理可能导致结果乱序,必须按chunkIndex排序以确保章节跟踪正确
  allQuestions.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  allAnswers.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  
  await logTaskProgress(ctx.taskId, "info", "merging", `开始合并问题和答案...`);
  const merged = mergeQAPairs(allQuestions, allAnswers, false);
  
  // 统计合并结果
  const withBoth = merged.filter(m => m.question && (m.answer || m.solution)).length;
  const questionOnly = merged.filter(m => m.question && !m.answer && !m.solution).length;
  const answerOnly = merged.filter(m => !m.question && (m.answer || m.solution)).length;
  const mergedWithImages = merged.filter(m => m.images && m.images.length > 0).length;
  const totalMergedImages = merged.reduce((sum, m) => sum + (m.images?.length || 0), 0);
  
  // 计算匹配率
  const answerMatchRate = allQuestions.length > 0 ? (withBoth / allQuestions.length * 100).toFixed(1) : 'N/A';
  const imageAssocRate = merged.length > 0 ? (mergedWithImages / merged.length * 100).toFixed(1) : 'N/A';
  
  await logTaskProgress(
    ctx.taskId,
    "info",
    "merging",
    `问答合并完成: ${merged.length}个QA对 | 完整配对:${withBoth}(匹配率${answerMatchRate}%) | 仅题目:${questionOnly} | 仅答案:${answerOnly} | 带图片:${mergedWithImages}(关联率${imageAssocRate}%, ${totalMergedImages}张)`,
    {
      totalMerged: merged.length,
      completeQA: withBoth,
      questionOnly,
      answerOnly,
      answerMatchRate: answerMatchRate + '%',
      mergedWithImages,
      totalMergedImages,
      imageAssocRate: imageAssocRate + '%'
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
    
    await logTaskProgress(taskId, "info", "init", `使用LLM配置: ${config.name} (${config.modelName}), 并发数: ${config.maxWorkers || 5}`, {
      configName: config.name,
      modelName: config.modelName,
      maxWorkers: config.maxWorkers || 5,
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
        maxWorkers: config.maxWorkers || 5,
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
