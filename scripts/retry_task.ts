
import { processExtractionTask } from '../server/taskProcessor';
import { updateExtractionTask } from '../server/db';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { extractionTasks } from '../drizzle/schema';
import { eq, desc } from 'drizzle-orm';
import * as dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || 'sqlite.db';

// 获取最近的失败任务 ID
async function retryLastFailedTask() {
  const sqlite = new Database(dbUrl);
  const db = drizzle(sqlite);
  
  const tasks = await db.select()
    .from(extractionTasks)
    .orderBy(desc(extractionTasks.createdAt))
    .limit(1);

  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  const task = tasks[0];
  console.log(`Retrying task ${task.id} (${task.name})...`);
  console.log(`Original status: ${task.status}`);
  console.log(`Original error: ${task.errorMessage}`);

  // 重置状态
  await updateExtractionTask(task.id, {
    status: 'pending',
    errorMessage: null,
    retryCount: task.retryCount + 1
  });

  // 启动处理并等待完成
  try {
    await processExtractionTask(task.id, task.userId);
    console.log('Task processing completed successfully.');
  } catch (error) {
    console.error('Task processing failed:', error);
  }
}

retryLastFailedTask().catch(console.error);
