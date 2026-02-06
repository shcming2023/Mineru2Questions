
import 'dotenv/config';
import { getDb } from '../server/db';
import { extractionTasks } from '../drizzle/schema';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) return;
  const tasks = await db.select().from(extractionTasks).where(inArray(extractionTasks.id, [1, 2]));
  console.log(JSON.stringify(tasks, null, 2));
}
main();
