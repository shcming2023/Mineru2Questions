import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../sqlite.db');

console.log(`Checking database at: ${dbPath}`);

try {
  const db = new Database(dbPath, { readonly: true });
  
  const taskCount = db.prepare('SELECT count(*) as count FROM extraction_tasks').get();
  console.log(`Extraction Tasks: ${taskCount.count}`);

  const configCount = db.prepare('SELECT count(*) as count FROM llm_configs').get();
  console.log(`LLM Configs: ${configCount.count}`);
  
  const userCount = db.prepare('SELECT count(*) as count FROM users').get();
  console.log(`Users: ${userCount.count}`);
  
  console.log("Database integrity check passed (tables readable).");
} catch (error) {
  console.error("Database integrity check failed:", error.message);
  process.exit(1);
}
