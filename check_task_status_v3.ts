
import { getDb } from "./server/db";
import { extractionTasks, taskLogs } from "./drizzle/schema";
import { desc, eq, and, or, like } from "drizzle-orm";

async function checkLatestTask() {
  const db = await getDb();
  if (!db) {
    console.error("Database not available");
    return;
  }

  // Get the latest task
  const tasks = await db.select().from(extractionTasks).orderBy(desc(extractionTasks.createdAt)).limit(1);
  const task = tasks[0];
  console.log(`Task ID: ${task.id}, Status: ${task.status}`);
  console.log(`Content List Path: ${task.contentListPath}`);

  // Search for latest logs (not just "章节预处理")
  const specificLogs = await db.select().from(taskLogs)
    .where(eq(taskLogs.taskId, task.id))
    .orderBy(desc(taskLogs.createdAt))
    .limit(20);

  console.log("\n=== Latest Events (Most Recent First) ===");
  specificLogs.forEach(log => {
    console.log(`[${log.createdAt?.toISOString()}] ${log.message}`);
  });
}

checkLatestTask().catch(console.error);
