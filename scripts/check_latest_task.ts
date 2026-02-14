
import 'dotenv/config';
import { getDb } from '../server/db';
import { extractionTasks } from '../drizzle/schema';
import { desc } from 'drizzle-orm';

async function checkStatus() {
  const db = await getDb();
  if (!db) {
    console.error("Failed to connect to database");
    process.exit(1);
  }
  const result = await db.select().from(extractionTasks).orderBy(desc(extractionTasks.id)).limit(1);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

checkStatus();
