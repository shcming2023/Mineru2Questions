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
import { storageGet } from './storage';
import {
  extractQuestions,
  exportToJSON,
  exportToMarkdown,
  LLMConfig
} from './extraction';

/**
 * 处理单个提取任务
 */
export async function processExtractionTask(taskId: number): Promise<void> {
  console.log(`[Task ${taskId}] Starting task processing...`);
  
  try {
    // 1. 获取任务信息
    const task = await getExtractionTaskById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    
    await updateExtractionTask(taskId, { status: 'processing' });
    await logTaskProgress(taskId, 'info', 'starting', 'Task processing started');
    
    // 2. 获取 LLM 配置
    const llmConfig = await getLLMConfigById(task.llm_config_id);
    if (!llmConfig) {
      throw new Error(`LLM config ${task.llm_config_id} not found`);
    }
    
    const config: LLMConfig = {
      apiUrl: llmConfig.api_url,
      apiKey: llmConfig.api_key,
      modelName: llmConfig.model_name,
      timeout: llmConfig.timeout || 60000,
      maxRetries: llmConfig.max_retries || 3
    };
    
    // 3. 获取 content_list.json 路径
    const contentListPath = await resolveFilePath(task.content_list_path);
    await logTaskProgress(taskId, 'info', 'loading', `Loading content_list.json from: ${contentListPath}`);
    
    // 4. 确定图片文件夹路径
    const imagesFolder = path.dirname(contentListPath);
    const taskDir = path.dirname(path.dirname(contentListPath)); // 上两级目录
    
    // 5. 调用核心提取函数
    await logTaskProgress(taskId, 'info', 'extracting', 'Starting question extraction...');
    const questions = await extractQuestions(contentListPath, imagesFolder, taskDir, config);
    
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
      result_json_path: jsonPath,
      result_md_path: mdPath,
      completed_at: new Date()
    });
    
    console.log(`[Task ${taskId}] Task completed successfully`);
    
  } catch (error: any) {
    console.error(`[Task ${taskId}] Task failed:`, error);
    
    await updateExtractionTask(taskId, {
      status: 'failed',
      error_message: error.message
    });
    
    await logTaskProgress(taskId, 'error', 'failed', `Task failed: ${error.message}`);
    
    throw error;
  }
}

/**
 * 解析文件路径（支持本地路径和 S3 URL）
 */
async function resolveFilePath(filePath: string): Promise<string> {
  if (filePath.startsWith('/uploads/')) {
    // 本地文件路径
    return path.resolve(process.cwd(), 'server', filePath.substring(1));
  } else if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    // 远程 URL（暂不支持，需要先下载）
    throw new Error('Remote URLs are not supported yet. Please upload the file locally.');
  } else {
    // 假设是相对路径
    return path.resolve(process.cwd(), 'server', filePath);
  }
}
