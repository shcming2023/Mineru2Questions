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
  logTaskProgress,
  getDb
} from './db';
import { extractionTasks } from '../drizzle/schema';
import { eq, and, lt, ne } from 'drizzle-orm';
import { storageGet } from './storage';
import {
  extractQuestions,
  exportToJSON,
  exportToMarkdown,
  LLMConfig
} from './extraction';

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
 * 暂停任务处理
 */
export async function pauseTaskProcessing(taskId: number): Promise<void> {
  console.log(`[Task ${taskId}] Pause requested`);
  // 在 v1.1 中，我们通过数据库状态检查来实现暂停
  // 只需要确保数据库状态已更新为 paused，processExtractionTask 中的 shouldContinue 检查会捕获它
  await updateExtractionTask(taskId, { status: 'paused' });
}

/**
 * 取消任务处理
 */
export async function cancelTaskProcessing(taskId: number): Promise<void> {
  console.log(`[Task ${taskId}] Cancel requested`);
  // 通过数据库状态检查来实现取消
  await updateExtractionTask(taskId, { status: 'failed', errorMessage: 'Task cancelled by user' });
}

/**
 * 检查系统健康状态
 */
export async function checkSystemHealth(userId: number): Promise<{
  activeTasks: number;
  staleTasks: number;
  isHealthy: boolean;
}> {
  const db = await getDb();
  if (!db) return { activeTasks: 0, staleTasks: 0, isHealthy: false };

  // 查找活跃任务 (status = processing)
  const activeTasks = await db.select().from(extractionTasks).where(
    and(
      eq(extractionTasks.status, 'processing'),
      eq(extractionTasks.userId, userId)
    )
  );

  // 检查是否有陈旧任务 (更新时间超过 10 分钟)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const staleTasks = activeTasks.filter(t => t.updatedAt < tenMinutesAgo);

  return {
    activeTasks: activeTasks.length,
    staleTasks: staleTasks.length,
    isHealthy: staleTasks.length === 0
  };
}

/**
 * 清理陈旧任务
 */
export async function cleanupStaleTasks(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  
  // 查找所有陈旧任务
  const staleTasks = await db.select().from(extractionTasks).where(
    and(
      eq(extractionTasks.status, 'processing'),
      eq(extractionTasks.userId, userId),
      lt(extractionTasks.updatedAt, tenMinutesAgo)
    )
  );

  let count = 0;
  for (const task of staleTasks) {
    await updateExtractionTask(task.id, {
      status: 'failed',
      errorMessage: 'Task timed out (stale process cleanup)',
      completedAt: new Date()
    });
    count++;
    console.log(`[Cleanup] Reset stale task ${task.id}`);
  }

  return count;
}

/**
 * 强制重置任务
 */
export async function forceResetTask(taskId: number, userId: number): Promise<void> {
  const task = await getExtractionTaskById(taskId, userId);
  if (task && (task.status === 'processing' || task.status === 'pending')) {
    await updateExtractionTask(taskId, {
      status: 'failed',
      errorMessage: 'Task manually reset by user',
      completedAt: new Date()
    });
    console.log(`[Reset] Manually reset task ${taskId}`);
  }
}

/**
 * 处理单个提取任务
 */
export async function processExtractionTask(taskId: number, userId: number): Promise<void> {
  console.log(`[Task ${taskId}] Starting task processing...`);
  
  try {
    // 0. 环境健康检查
    const health = await checkSystemHealth(userId);
    if (health.activeTasks > 1) { // 允许当前任务为 1，如果有其他任务则警告
       console.warn(`[Task ${taskId}] Warning: ${health.activeTasks - 1} other tasks are running`);
    }

    // 1. 获取任务信息
    const task = await getExtractionTaskById(taskId, userId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    
    // 更新状态和心跳
    await updateExtractionTask(taskId, { 
      status: 'processing',
      startedAt: new Date(),
      updatedAt: new Date()
    });
    await logTaskProgress(taskId, 'info', 'starting', 'Task processing started');
    
    // 2. 获取 LLM 配置
    if (!task.configId) {
      throw new Error(`Task ${taskId} has no LLM config assigned`);
    }
    const llmConfig = await getLLMConfigById(task.configId, userId);
    if (!llmConfig) {
      throw new Error(`LLM config ${task.configId} not found`);
    }
    
    const config: LLMConfig = {
      apiUrl: llmConfig.apiUrl,
      apiKey: llmConfig.apiKey,
      modelName: llmConfig.modelName,
      timeout: llmConfig.timeout ? llmConfig.timeout * 1000 : 60000, // 转换为毫秒
      maxRetries: 3
    };
    
    // 3. 获取 content_list.json 路径
    if (!task.contentListPath) {
      throw new Error(`Task ${taskId} has no content list path`);
    }
    const contentListPath = await resolveFilePath(task.contentListPath);
    
    // 检查文件是否存在
    if (!fs.existsSync(contentListPath)) {
       throw new Error(`Content list file not found: ${contentListPath}`);
    }

    await logTaskProgress(taskId, 'info', 'loading', `Loading content_list.json from: ${contentListPath}`);
    
    // 4. 确定图片文件夹路径
    const imagesFolder = path.dirname(contentListPath);
    const taskDir = path.dirname(contentListPath);
    
    // 5. 调用核心提取函数
    await logTaskProgress(taskId, 'info', 'extracting', 'Starting question extraction...');
    
    const onProgress = async (msg: string) => {
      // 避免写入过多日志，仅记录关键信息
      if (msg.startsWith('Step') || msg.includes('Processing chunk')) {
         await logTaskProgress(taskId, 'info', 'extracting', msg);
         // 同时更新心跳
         await updateExtractionTask(taskId, { updatedAt: new Date() });
      }
    };

    // 状态检查回调
    const shouldContinue = async () => {
      const currentTask = await getExtractionTaskById(taskId, userId);
      // 如果任务不存在，或状态不再是 processing，则停止
      if (!currentTask || currentTask.status !== 'processing') {
        return false;
      }
      return true;
    };

    const questions = await extractQuestions(contentListPath, imagesFolder, taskDir, config, onProgress, shouldContinue);
    
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
    await updateExtractionTask(taskId, {
      status: 'completed',
      resultJsonPath: jsonPath,
      resultMarkdownPath: mdPath,
      extractedCount: questions.length,
      completedAt: new Date()
    });
    
    console.log(`[Task ${taskId}] Task completed successfully`);
    
  } catch (error: any) {
    console.error(`[Task ${taskId}] Task failed:`, error);
    
    await updateExtractionTask(taskId, {
      status: 'failed',
      errorMessage: error.message
    });
    
    await logTaskProgress(taskId, 'error', 'failed', `Task failed: ${error.message}`);
    
    // 不再抛出错误，因为我们在 catch 中处理了它，且是异步调用
  }
}

/**
 * 解析文件路径（支持本地路径和 S3 URL）
 */
async function resolveFilePath(filePath: string): Promise<string> {
  // 1. 如果是绝对路径，直接返回
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // 2. 如果是 /uploads/ 开头的路径
  if (filePath.startsWith('/uploads/')) {
    return path.resolve(process.cwd(), 'server', filePath.substring(1));
  } 
  
  // 3. 如果是 http/https URL
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    throw new Error('Remote URLs are not supported yet. Please upload the file locally.');
  }

  // 4. 尝试多种可能的路径解析
  const candidates = [
    path.resolve(process.cwd(), 'server', filePath), // 默认：server/tasks/...
    path.resolve(process.cwd(), 'server/uploads', filePath), // server/uploads/tasks/...
    path.resolve(process.cwd(), filePath) // 根目录
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 5. 如果都找不到，返回默认路径（server/ 下）
  // 这样后续逻辑会发现文件不存在并报错（或创建测试文件）
  return path.resolve(process.cwd(), 'server', filePath);
}
