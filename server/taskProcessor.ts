/**
 * 任务处理器 (v1.1 - 简化流水线)
 * 
 * 负责实际执行题目提取任务。
 * 
 * 核心改进：
 * 1. 移除双文件模式和答案合并逻辑
 * 2. 简化为单一流水线
 * 3. 直接调用 extraction.ts 的 extractQuestions 函数
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  getExtractionTaskById,
  updateExtractionTask,
  getLLMConfigById,
  logTaskProgress
} from './db';
import {
  extractQuestions,
  exportToJSON,
  exportToMarkdown,
  LLMConfig
} from './extraction';
import {
  ChapterLLMConfig,
  ChapterPreprocessResult
} from './chapterPreprocess';
import { preprocessChaptersV2 } from './chapterPreprocessV2';

/**
 * 启动任务处理
 */
export function startTaskProcessing(taskId: number, userId: number): void {
  // 异步执行，不等待结果
  processExtractionTask(taskId, userId).catch(error => {
    console.error(`[Task ${taskId}] Unhandled error in task processing:`, error);
  });
}

/**
 * 暂停任务处理 (v1.1 暂不支持)
 */
export function pauseTaskProcessing(taskId: number): void {
  console.warn(`[Task ${taskId}] Pause requested but not implemented in v1.1 pipeline`);
}

/**
 * 取消任务处理 (v1.1 暂不支持)
 */
export function cancelTaskProcessing(taskId: number): void {
  console.warn(`[Task ${taskId}] Cancel requested but not implemented in v1.1 pipeline`);
}

/**
 * 处理单个提取任务
 */
export async function processExtractionTask(taskId: number, userId: number): Promise<void> {
  try {
    // 1. 获取任务信息
    const task = await getExtractionTaskById(taskId, userId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    
    await updateExtractionTask(taskId, { status: 'processing' });
    await logTaskProgress(taskId, 'info', 'starting', 'Task processing started');
    
    // 2. 获取 LLM 配置
    if (!task.configId) {
      throw new Error(`Task ${taskId} is missing LLM config`);
    }
    const llmConfig = await getLLMConfigById(task.configId, userId);
    if (!llmConfig) {
      throw new Error(`LLM config ${task.configId} not found`);
    }
    
    const config: LLMConfig = {
      apiUrl: llmConfig.apiUrl,
      apiKey: llmConfig.apiKey,
      modelName: llmConfig.modelName,
      // 核心修复：将数据库中的秒转换为 axios 需要的毫秒
      timeout: (llmConfig.timeout || 60) * 1000,
      maxRetries: 3,
      maxWorkers: llmConfig.maxWorkers || 5
    };
    
    // 3. 获取 content_list.json 路径
    if (!task.contentListPath) {
      throw new Error(`Task ${taskId} is missing content_list.json path`);
    }
    const contentListPath = await resolveFilePath(task.contentListPath);
    await logTaskProgress(taskId, 'info', 'loading', `Loading content_list.json from: ${contentListPath}`);
    
    // 4. 确定图片文件夹路径
    const imagesFolder = path.dirname(contentListPath);
    const taskDir = imagesFolder;
    
    // 4.5. 章节预处理（如果配置了长文本 LLM）
    let chapterResult: ChapterPreprocessResult | null = null;
    if (task.chapterConfigId) {
      const chapterLlmConfig = await getLLMConfigById(task.chapterConfigId, userId);
      if (chapterLlmConfig) {
        await logTaskProgress(taskId, 'info', 'chapter_preprocess', '开始章节预处理 V2（自适应三轨混合架构）...');
        try {
          const chapterConfig: ChapterLLMConfig = {
            apiUrl: chapterLlmConfig.apiUrl,
            apiKey: chapterLlmConfig.apiKey,
            modelName: chapterLlmConfig.modelName,
            timeout: (chapterLlmConfig.timeout || 120) * 1000,
            contextWindow: chapterLlmConfig.contextWindow,
          };
          // 使用 V2 自适应三轨混合架构
          chapterResult = await preprocessChaptersV2(
            contentListPath,
            taskDir,
            chapterConfig,
            async (msg) => {
              await logTaskProgress(taskId, 'info', 'chapter_preprocess', msg);
            }
          );
          await logTaskProgress(taskId, 'info', 'chapter_preprocess',
            `章节预处理V2完成: ${chapterResult.totalEntries} 个章节条目, 覆盖率 ${(chapterResult.coverageRate * 100).toFixed(1)}%`);
        } catch (err: any) {
          console.error(`[Task ${taskId}] Chapter preprocess failed:`, err);
          await logTaskProgress(taskId, 'warn', 'chapter_preprocess',
            `章节预处理失败，将降级使用题目抽取阶段的章节信息: ${err.message}`);
          // 优雅降级（原则四）：章节预处理失败时继续执行题目抽取，回退到抽取侧章节标题
          chapterResult = null;
        }
      } else {
        await logTaskProgress(taskId, 'warn', 'chapter_preprocess',
          `章节预处理 LLM 配置 ${task.chapterConfigId} 未找到，跳过章节预处理`);
      }
    } else {
      await logTaskProgress(taskId, 'info', 'chapter_preprocess', '未配置章节预处理 LLM，跳过章节预处理');
    }
    
    const lastProgress = { currentChunk: 0, totalChunks: 0, completedChunks: 0 };

    // 5. 调用核心提取函数
    await logTaskProgress(taskId, 'info', 'extracting', 'Starting question extraction...');
    const questions = await extractQuestions(
      contentListPath, 
      imagesFolder, 
      taskDir, 
      config,
      chapterResult?.flatMap ?? null,
      async (_progress, message, stats) => {
        if (stats?.currentChunk && stats?.totalChunks) {
          lastProgress.currentChunk = stats.currentChunk;
          lastProgress.totalChunks = stats.totalChunks;
          if (stats.completedChunks !== undefined) {
            lastProgress.completedChunks = stats.completedChunks;
          }
        }

        await logTaskProgress(
          taskId,
          'info',
          'processing',
          message,
          undefined,
          stats?.currentChunk ? stats.currentChunk - 1 : undefined,
          stats?.totalChunks
        );

        if (stats?.totalChunks) {
          // 优先使用 completedChunks 以确保进度单调递增
          const processed = stats.completedChunks !== undefined ? stats.completedChunks : (stats.currentChunk || 0);
          
          await updateExtractionTask(taskId, {
            processedPages: processed,
            totalPages: stats.totalChunks,
            currentPage: stats.currentChunk // currentPage 保持为当前正在处理的 Chunk ID
          });
        }
      }
    );
    
    await logTaskProgress(taskId, 'info', 'extracting', `Extraction completed: ${questions.length} questions`);
    
    // 6. 导出结果
    await logTaskProgress(taskId, 'info', 'exporting', 'Exporting results...');
    
    const resultsDir = path.join(taskDir, 'results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    
    const jsonPath = path.join(resultsDir, 'questions.json');
    const mdPath = path.join(resultsDir, 'questions.md');
    
    exportToJSON(questions, jsonPath);
    exportToMarkdown(questions, mdPath);
    
    await logTaskProgress(taskId, 'info', 'exporting', `Results exported to ${resultsDir}`);
    
    // 7. 更新任务状态
    const finalTotalPages = lastProgress.totalChunks || task.totalPages;
    await updateExtractionTask(taskId, {
      status: 'completed',
      resultJsonPath: jsonPath,
      resultMarkdownPath: mdPath,
      extractedCount: questions.length,
      completedAt: new Date(),
      processedPages: finalTotalPages, // Force 100% progress
      totalPages: finalTotalPages,
      currentPage: finalTotalPages
    });
    
  } catch (error: any) {
    console.error(`[Task ${taskId}] Task failed:`, error);
    
    await updateExtractionTask(taskId, {
      status: 'failed',
      errorMessage: error.message
    });
    
    await logTaskProgress(taskId, 'error', 'failed', `Task failed: ${error.message}`);
    
    throw error;
  }
}

/**
 * 解析文件路径（支持本地路径和 S3 URL）
 */
async function resolveFilePath(filePath: string): Promise<string> {
  // 1. 如果包含 '/uploads/'，尝试定位到 server/uploads
  if (filePath.includes('/uploads/')) {
    // 提取 'uploads/' 及其之后的部分
    const relativePath = filePath.substring(filePath.indexOf('uploads/'));
    const resolvedPath = path.resolve(process.cwd(), 'server', relativePath);
    
    // 验证文件是否存在
    if (fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }
  
  // 2. 尝试作为相对于 server 的路径
  const serverPath = path.resolve(process.cwd(), 'server', filePath.startsWith('/') ? filePath.substring(1) : filePath);
  if (fs.existsSync(serverPath)) {
    return serverPath;
  }

  // 2.1 尝试作为相对于 server/uploads 的路径 (针对 tasks/xxx 情况)
  const uploadsPath = path.resolve(process.cwd(), 'server/uploads', filePath.startsWith('/') ? filePath.substring(1) : filePath);
  if (fs.existsSync(uploadsPath)) {
    return uploadsPath;
  }

  // 3. 尝试作为绝对路径 (如果传入的就是绝对路径)
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
    return filePath;
  }
  
  // 4. 处理原始逻辑（保留作为回退，虽然可能不准确）
  if (filePath.startsWith('/uploads/')) {
    return path.resolve(process.cwd(), 'server', filePath.substring(1));
  } else if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    throw new Error('Remote URLs are not supported yet. Please upload the file locally.');
  } else {
    // 假设是相对路径
    return path.resolve(process.cwd(), 'server', filePath);
  }
}
