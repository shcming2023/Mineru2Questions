
import Database from 'better-sqlite3';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const dbPath = path.join(rootDir, 'sqlite.db');

console.log(`Connecting to database at: ${dbPath}`);

const db = new Database(dbPath);

async function testLLMConnection() {
  try {
    console.log('\n--- Checking Users ---');
    const users = db.prepare('SELECT * FROM users').all() as any[];
    for (const user of users) {
      console.log(`User ID: ${user.id}, OpenID: ${user.openId}, Name: ${user.name}`);
    }

    const configs = db.prepare('SELECT * FROM llm_configs').all() as any[];
    console.log(`Found ${configs.length} LLM configs.`);

    for (const config of configs) {
      console.log(`\nTesting config: ${config.name} (ID: ${config.id}, UserID: ${config.userId}, Default: ${config.isDefault})`);
      console.log(`API URL: ${config.apiUrl}`);
      console.log(`Model: ${config.modelName}`);
      
      const apiKeyMasked = config.apiKey.substring(0, 8) + '...' + config.apiKey.substring(config.apiKey.length - 4);
      console.log(`API Key: ${apiKeyMasked}`);

      // Basic validation
      if (!config.apiKey || config.apiKey.trim() === '') {
        console.error('❌ API Key is empty!');
        continue;
      }

      const base = config.apiUrl.replace(/\/+$/, "");
      const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
      
      console.log(`Full Endpoint: ${endpoint}`);

      try {
        const response = await axios.post(
          endpoint,
          {
            model: config.modelName,
            messages: [
              { role: 'user', content: 'Hello, are you working?' }
            ],
            max_tokens: 10
          },
          {
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000 // 10s timeout for test
          }
        );

        if (response.status === 200) {
          console.log('✅ Connection Successful (Standard)!');
          console.log('Response:', response.data.choices[0].message.content);
        } else {
          console.error(`❌ Request failed with status: ${response.status}`);
        }

        // Test JSON Mode (Chapter Preprocess simulation)
        try {
          console.log('Testing JSON Mode (Chapter Preprocess)...');
          const jsonResponse = await axios.post(
            endpoint,
            {
              model: config.modelName,
              messages: [{ role: 'user', content: 'Return {"status": "ok"}' }],
              response_format: { type: 'json_object' },
              max_tokens: 10
            },
            {
              headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }
          );
          console.log('✅ JSON Mode Successful!');
        } catch (e: any) {
          console.warn('⚠️ JSON Mode Failed:', e.response?.data || e.message);
        }

      } catch (error: any) {
        console.error('❌ Connection Failed!');
        if (error.response) {
          console.error(`Status: ${error.response.status}`);
          console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
          console.error('Error:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Database error:', error);
  }

  try {
    console.log('\n--- Checking Recent Tasks ---');
    const tasks = db.prepare('SELECT * FROM extraction_tasks ORDER BY createdAt DESC LIMIT 5').all() as any[];
    if (tasks.length === 0) {
      console.log('No tasks found.');
    } else {
      for (const task of tasks) {
        console.log(`\nTask ID: ${task.id}`);
        console.log(`Name: ${task.name}`);
        console.log(`Status: ${task.status}`);
        console.log(`Config ID: ${task.configId}`);
        console.log(`Chapter Config ID: ${task.chapterConfigId}`);
        console.log(`Error Message: ${task.errorMessage || 'None'}`);
        console.log(`Created At: ${task.createdAt}`);
      }
    }
  } catch (error) {
    console.error('Task check error:', error);
  } finally {
    db.close();
  }
}

testLLMConnection();
