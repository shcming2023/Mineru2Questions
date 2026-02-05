
import Database from 'better-sqlite3';

console.log('Start checking DB');
try {
  const db = new Database('sqlite.db', { verbose: console.log });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', JSON.stringify(tables, null, 2));
} catch (e) {
  console.error('Error:', e);
}
console.log('End checking DB');
