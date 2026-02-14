
import 'dotenv/config';
import { getDb } from '../server/db';
import { extractionTasks } from '../drizzle/schema';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("Failed to connect to database");
    process.exit(1);
  }
  
  console.log("Checking for stuck tasks...");

  try {
    // 查找所有处于 processing 或 pending 状态的任务
    const stuckTasks = await db.select()
      .from(extractionTasks)
      .where(inArray(extractionTasks.status, ['processing', 'pending']));

    if (stuckTasks.length === 0) {
      console.log("No stuck tasks found.");
      return;
    }

    console.log(`Found ${stuckTasks.length} stuck tasks:`);
    stuckTasks.forEach(task => {
      console.log(`- Task ID: ${task.id}, Name: ${task.name}, Status: ${task.status}, Started: ${task.startedAt}`);
    });

    // 将这些任务状态重置为 failed
    const taskIds = stuckTasks.map(t => t.id);
    await db.update(extractionTasks)
      .set({ 
        status: 'failed',
        errorMessage: 'Task terminated by manual reset script',
        completedAt: new Date()
      })
      .where(inArray(extractionTasks.id, taskIds));

    console.log(`Successfully reset ${stuckTasks.length} tasks to 'failed' status.`);
  } catch (error) {
    console.error("Error resetting tasks:", error);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
