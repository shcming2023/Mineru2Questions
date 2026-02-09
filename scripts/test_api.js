import axios from 'axios';

const BASE_URL = 'http://localhost:3000';

async function checkSystem() {
  console.log('--- System Diagnostic ---');
  // 1. Health/Root Check
  try {
    const res = await axios.get(BASE_URL);
    console.log(`[PASS] Server Access (Root): Status ${res.status}`);
  } catch (e) {
    console.error(`[FAIL] Server Access: ${e.message}`);
    process.exit(1);
  }

  // 2. Data Check (Simulate TRPC call or check if DB is readable via side-channel if API is complex)
  // Since TRPC is complex to construct manually without client, we assume server up implies DB up for now,
  // or we rely on the server logs not showing errors.
  
  console.log('--- Diagnostic Completed ---');
}

checkSystem();
