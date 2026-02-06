
import 'dotenv/config';
import { startTaskProcessing } from '../server/taskProcessor';
import { getDb } from '../server/db';
import { extractionTasks } from '../drizzle/schema';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  console.log('Starting test tasks...');

  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const taskIds = [1, 2];
  const userId = 1;

  // Start tasks
  for (const taskId of taskIds) {
    console.log(`Triggering task ${taskId}...`);
    startTaskProcessing(taskId, userId);
  }

  // Poll for status
  console.log('Polling for status...');
  
  const startTime = Date.now();
  const timeout = 600000; // 10 minutes timeout

  while (Date.now() - startTime < timeout) {
    const tasks = await db.select().from(extractionTasks).where(inArray(extractionTasks.id, taskIds));
    
    let allDone = true;
    for (const task of tasks) {
      console.log(`Task ${task.id}: ${task.status} (Pages: ${task.processedPages}/${task.totalPages})`);
      if (task.status === 'processing' || task.status === 'pending') {
        allDone = false;
      } else if (task.status === 'failed') {
          console.error(`Task ${task.id} failed: ${task.errorMessage}`);
      }
    }

    if (allDone) {
      console.log('All tasks finished.');
      break;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  if (Date.now() - startTime >= timeout) {
      console.error('Timed out waiting for tasks.');
  }
}

main().catch(console.error);
