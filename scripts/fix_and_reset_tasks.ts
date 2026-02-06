
import 'dotenv/config';
import { getDb } from '../server/db';
import { extractionTasks } from '../drizzle/schema';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) return;

  console.log('Resetting tasks 1 and 2...');

  // Fix Task 1
  await db.update(extractionTasks)
    .set({
      sourceFolder: 'tasks/1',
      status: 'pending',
      processedPages: 0,
      extractedCount: 0,
      errorMessage: null,
      markdownPath: 'tasks/1/full.md',
      contentListPath: 'tasks/1/content_list.json',
      imagesFolder: 'tasks/1/images',
      resultJsonPath: 'tasks/1/results/questions.json',
      resultMarkdownPath: 'tasks/1/results/questions.md'
    })
    .where(eq(extractionTasks.id, 1));

  // Fix Task 2
  await db.update(extractionTasks)
    .set({
      sourceFolder: 'tasks/2',
      status: 'pending',
      processedPages: 0,
      extractedCount: 0,
      errorMessage: null,
      markdownPath: 'tasks/2/full.md',
      contentListPath: 'tasks/2/content_list.json',
      imagesFolder: 'tasks/2/images',
      resultJsonPath: 'tasks/2/results/questions.json',
      resultMarkdownPath: 'tasks/2/results/questions.md'
    })
    .where(eq(extractionTasks.id, 2));

  console.log('Tasks reset successfully.');
}

main().catch(console.error);
