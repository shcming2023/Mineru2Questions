/**
 * 离线测试脚本：验证 chapterPreprocessV2 的轨道一（TOC）和轨道二（Pattern）
 * 
 * 直接调用 preprocessChaptersV2（跳过 LLM 轨道），验证纯代码轨道的效果。
 * 
 * 用法: npx tsx server/testChapterV2.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { preprocessChaptersV2 } from './chapterPreprocessV2';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);
const tasksDir = path.join(__dirname_local, 'uploads/tasks');

async function runTest(taskDir: string, name: string) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${name}`);
  console.log(`${'='.repeat(80)}\n`);

  const contentListPath = path.join(taskDir, 'content_list.json');
  if (!fs.existsSync(contentListPath)) {
    console.error(`content_list.json not found`);
    return;
  }

  // 使用一个假的 LLM config（轨道三不会被触发，因为我们不传真实的 API key）
  const fakeLLMConfig = {
    apiUrl: 'http://localhost:9999/v1/chat/completions',
    apiKey: 'fake',
    modelName: 'fake',
    timeout: 5000,
    contextWindow: 128000,
    maxOutputTokens: 4096,
  };

  try {
    const result = await preprocessChaptersV2(
      contentListPath,
      taskDir,
      fakeLLMConfig,
      async (msg) => console.log(`  [Progress] ${msg}`)
    );

    console.log(`\n--- Results Summary ---`);
    console.log(`Total Entries: ${result.totalEntries}`);
    console.log(`Coverage Rate: ${((result.coverageRate ?? 0) * 100).toFixed(1)}%`);
    console.log(`Round 1 (raw anchors): ${result.round1Entries}`);
    console.log(`Round 2 (merged anchors): ${result.round2Entries}`);

    // 读取并分析 debug 输出
    const debugDir = path.join(taskDir, 'debug');
    
    // TOC 检测结果
    const tocDetection = JSON.parse(fs.readFileSync(path.join(debugDir, 'v2_toc_detection.json'), 'utf-8'));
    console.log(`\nTOC Detection: ${tocDetection.hasTOC ? `Pages [${tocDetection.tocPages.join(',')}]` : 'No TOC found'}`);

    // 调度决策
    const dispatch = JSON.parse(fs.readFileSync(path.join(debugDir, 'v2_dispatch_decision.json'), 'utf-8'));
    console.log(`Dispatch: ${dispatch.reason}`);

    // TOC 条目
    if (tocDetection.hasTOC) {
      const tocEntries = JSON.parse(fs.readFileSync(path.join(debugDir, 'v2_toc_entries.json'), 'utf-8'));
      console.log(`\nTOC Entries: ${tocEntries.length}`);
      console.log(`  Level 1: ${tocEntries.filter((e: any) => e.level === 1).length}`);
      console.log(`  Level 2: ${tocEntries.filter((e: any) => e.level === 2).length}`);
      console.log(`  Level 3: ${tocEntries.filter((e: any) => e.level === 3).length}`);
      console.log(`\nFirst 20 TOC Entries:`);
      for (const e of tocEntries.slice(0, 20)) {
        console.log(`  L${e.level} | "${e.title}" → page ${e.pageNumber}`);
      }

      // TOC 锚点
      const tocAnchors = JSON.parse(fs.readFileSync(path.join(debugDir, 'v2_toc_anchors.json'), 'utf-8'));
      const highConf = tocAnchors.filter((a: any) => a.confidence >= 0.8);
      const medConf = tocAnchors.filter((a: any) => a.confidence >= 0.5 && a.confidence < 0.8);
      const lowConf = tocAnchors.filter((a: any) => a.confidence < 0.5);
      console.log(`\nTOC Anchors: ${tocAnchors.length} (high: ${highConf.length}, med: ${medConf.length}, low: ${lowConf.length})`);
      
      console.log(`\nFirst 20 TOC Anchors:`);
      for (const a of tocAnchors.slice(0, 20)) {
        console.log(`  [Block ${a.blockId}] p.${a.page} conf=${a.confidence.toFixed(2)} L${a.level} | "${a.normalizedTitle}" → "${(a.text || '').substring(0, 50)}"`);
      }

      // 未匹配的
      const matchedTitles = new Set(tocAnchors.map((a: any) => a.normalizedTitle));
      const unmatched = tocEntries.filter((e: any) => !matchedTitles.has(e.title));
      if (unmatched.length > 0) {
        console.log(`\nUnmatched TOC Entries (${unmatched.length}):`);
        for (const e of unmatched.slice(0, 15)) {
          console.log(`  L${e.level} | "${e.title}" (expected page ${e.pageNumber})`);
        }
      }
    }

    // Pattern 锚点
    const patternAnchors = JSON.parse(fs.readFileSync(path.join(debugDir, 'v2_pattern_anchors.json'), 'utf-8'));
    console.log(`\nPattern Anchors: ${patternAnchors.length}`);
    console.log(`  Level 1: ${patternAnchors.filter((a: any) => a.level === 1).length}`);
    console.log(`  Level 2: ${patternAnchors.filter((a: any) => a.level === 2).length}`);
    console.log(`\nFirst 20 Pattern Anchors:`);
    for (const a of patternAnchors.slice(0, 20)) {
      console.log(`  [Block ${a.blockId}] p.${a.page} conf=${a.confidence.toFixed(2)} L${a.level} | "${(a.text || '').substring(0, 80)}"`);
    }

    // 最终 flat_map
    const flatMap = result.flatMap;
    console.log(`\n--- Final Chapter Tree (first 30) ---`);
    for (const entry of flatMap.slice(0, 30)) {
      const indent = '  '.repeat(entry.level - 1);
      console.log(`  ${indent}L${entry.level} [${entry.block_range.start}-${entry.block_range.end}) p.${entry.page} | "${entry.text.substring(0, 70)}"`);
    }

    if (flatMap.length > 30) {
      console.log(`  ... (${flatMap.length - 30} more entries)`);
    }

  } catch (err: any) {
    console.error(`Test failed: ${err.message}`);
    console.error(err.stack);
  }
}

(async () => {
  const taskDirs = fs.readdirSync(tasksDir).sort();
  for (const dir of taskDirs) {
    const fullPath = path.join(tasksDir, dir);
    if (fs.statSync(fullPath).isDirectory()) {
      await runTest(fullPath, dir);
    }
  }
  console.log('\n\nAll tests completed.');
})();
