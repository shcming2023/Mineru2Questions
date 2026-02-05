
import Database from 'better-sqlite3';

console.log('Seeding user...');
const db = new Database('sqlite.db');

try {
  const user = db.prepare('SELECT * FROM users WHERE id = 1').get();
  console.log('Existing user:', user);

  if (!user) {
    console.log('Inserting mock user...');
    // Use numeric timestamps for sqlite if using integer mode, or strings if text.
    // Drizzle usually handles this. Let's assume standard SQLite date functions or numbers.
    const stmt = db.prepare(`
      INSERT INTO users (id, openId, name, email, loginMethod, role, createdAt, updatedAt, lastSignedIn)
      VALUES (1, 'dev-user', 'Developer', 'dev@example.com', 'dev', 'admin', ?, ?, ?)
    `);
    stmt.run(Date.now(), Date.now(), Date.now());
    console.log('Mock user inserted.');
  }
} catch (e) {
  console.error('Error:', e);
}
