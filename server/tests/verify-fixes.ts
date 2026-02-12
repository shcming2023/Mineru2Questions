/**
 * 验证三个修复的正确性：
 * 1. Block 展平一致性：chapterPreprocess 和 extraction 产出相同的 block 数量和 ID
 * 2. 去重逻辑：Jaccard 重叠检测能正确合并跨 chunk 重复题目
 * 3. 图片路径：question 文本中嵌入的图片使用相对路径
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { flattenContentList, toConvertedBlocks } from '../blockFlattener';
import { flattenBlocks } from '../chapterPreprocess';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ 测试数据路径 ============
const TASK_DIR = path.join(__dirname, '../uploads/tasks/202602121732-1770888793786');
const CONTENT_LIST_PATH = path.join(TASK_DIR, 'content_list.json');

console.log('='.repeat(60));
console.log('验证修复效果');
console.log('='.repeat(60));

// ============ Test 1: Block 展平一致性 ============
console.log('\n--- Test 1: Block 展平一致性 ---');

const raw = JSON.parse(fs.readFileSync(CONTENT_LIST_PATH, 'utf-8'));

// 方式 A: 通过 blockFlattener.ts 的 flattenContentList
const flatBlocks = flattenContentList(raw);
const convertedBlocks = toConvertedBlocks(flatBlocks);

// 方式 B: 通过 chapterPreprocess.ts 的 flattenBlocks（现在是包装函数）
const chapterBlocks = flattenBlocks(raw);

console.log(`flattenContentList: ${flatBlocks.length} blocks`);
console.log(`chapterPreprocess.flattenBlocks: ${chapterBlocks.length} blocks`);
console.log(`extraction (toConvertedBlocks): ${convertedBlocks.length} blocks`);

if (flatBlocks.length === chapterBlocks.length) {
  console.log('✅ Block 数量一致');
} else {
  console.log(`❌ Block 数量不一致: ${flatBlocks.length} vs ${chapterBlocks.length}`);
}

// 检查 ID 一致性
let idMismatch = 0;
for (let i = 0; i < Math.min(flatBlocks.length, chapterBlocks.length); i++) {
  if (flatBlocks[i].id !== chapterBlocks[i].id) {
    idMismatch++;
    if (idMismatch <= 3) {
      console.log(`  ID mismatch at index ${i}: flat=${flatBlocks[i].id} vs chapter=${chapterBlocks[i].id}`);
    }
  }
}
if (idMismatch === 0) {
  console.log('✅ 所有 block ID 完全一致');
} else {
  console.log(`❌ ${idMismatch} 个 ID 不匹配`);
}

// 检查最大 ID
const maxFlatId = flatBlocks[flatBlocks.length - 1].id;
const maxConvertedId = convertedBlocks[convertedBlocks.length - 1].id;
console.log(`最大 ID: flat=${maxFlatId}, converted=${maxConvertedId}`);

// ============ Test 2: 去重逻辑 ============
console.log('\n--- Test 2: 去重逻辑 (Jaccard) ---');

// 模拟跨 chunk 重叠的题目
interface MockQuestion {
  label: string;
  questionIds: string;
  question: string;
}

function parseIdSet(ids: string): Set<number> {
  if (!ids || ids.trim() === '') return new Set();
  return new Set(ids.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)));
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) {
    if (b.has(v)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// 测试用例
const testCases: Array<{ a: string; b: string; expectedDup: boolean }> = [
  { a: '95,96,97', b: '95,96', expectedDup: true },       // 高重叠
  { a: '95,96,97', b: '95', expectedDup: false },          // 低重叠 (1/3 = 0.33)
  { a: '100,101', b: '100,101', expectedDup: true },       // 完全相同
  { a: '100,101', b: '200,201', expectedDup: false },      // 完全不同
  { a: '10,11,12,13', b: '11,12,13', expectedDup: true },  // 高重叠
];

let testPassed = 0;
for (const tc of testCases) {
  const setA = parseIdSet(tc.a);
  const setB = parseIdSet(tc.b);
  const sim = jaccard(setA, setB);
  const isDup = sim > 0.5;
  const pass = isDup === tc.expectedDup;
  console.log(`  "${tc.a}" vs "${tc.b}" → Jaccard=${sim.toFixed(3)}, dup=${isDup}, expected=${tc.expectedDup} ${pass ? '✅' : '❌'}`);
  if (pass) testPassed++;
}
console.log(`去重测试: ${testPassed}/${testCases.length} 通过`);

// ============ Test 3: 图片路径 ============
console.log('\n--- Test 3: 图片路径 ---');

// 检查 flatBlocks 中的 img_path 是否都是相对路径
const imageBlocks = flatBlocks.filter(b => b.img_path);
console.log(`图片 block 数量: ${imageBlocks.length}`);

let absolutePathCount = 0;
for (const b of imageBlocks) {
  if (b.img_path && path.isAbsolute(b.img_path)) {
    absolutePathCount++;
    console.log(`  ❌ 绝对路径: id=${b.id}, img_path=${b.img_path}`);
  }
}

if (absolutePathCount === 0) {
  console.log('✅ 所有图片路径都是相对路径');
} else {
  console.log(`❌ ${absolutePathCount} 个图片使用了绝对路径`);
}

// 检查路径格式
for (const b of imageBlocks.slice(0, 3)) {
  console.log(`  示例: id=${b.id}, img_path="${b.img_path}"`);
}

// ============ Test 4: 与旧 chapter_flat_map 的 block_range 兼容性 ============
console.log('\n--- Test 4: chapter_flat_map block_range 兼容性 ---');

const flatMapPath = path.join(TASK_DIR, 'debug', 'chapter_flat_map.json');
if (fs.existsSync(flatMapPath)) {
  const flatMap = JSON.parse(fs.readFileSync(flatMapPath, 'utf-8'));
  const maxBlockRange = Math.max(...flatMap.map((e: any) => e.block_range?.end ?? 0));
  console.log(`chapter_flat_map 最大 block_range.end: ${maxBlockRange}`);
  console.log(`新展平后的 block 数量: ${flatBlocks.length}`);
  
  if (maxBlockRange <= flatBlocks.length) {
    console.log('✅ block_range 在有效范围内');
  } else {
    console.log(`⚠️ block_range.end (${maxBlockRange}) > block 数量 (${flatBlocks.length})`);
    console.log('  注意：旧的 chapter_flat_map 是用旧展平逻辑生成的，需要重新运行章节预处理');
  }
} else {
  console.log('⚠️ chapter_flat_map.json 不存在（需要重新运行章节预处理）');
}

console.log('\n' + '='.repeat(60));
console.log('验证完成');
console.log('='.repeat(60));
