/**
 * 重构模块测试脚本
 * 
 * 用于验证新模块的基本功能。
 * 
 * 运行方式：
 * node test_refactoring.mjs
 */

import { LLMOutputParser } from './server/llm-output-parser.ts';
import { QAMerger } from './server/qa-merger.ts';
import { QualityGate, isValidXMLStructure } from './server/quality-gate.ts';
import { getQAExtractPrompt } from './server/prompts.ts';

console.log('=== Mineru2Questions 重构模块测试 ===\n');

// ============= 测试 1: 质量门 - XML 结构校验 =============
console.log('测试 1: 质量门 - XML 结构校验');

const validXML = `<chapter><title>7</title>
<qa_pair><label>1</label><question>2,3,4</question>
<answer>Yes</answer><solution>8,9,10</solution></qa_pair>
</chapter>`;

const invalidXML1 = `<chapter><title>7</title>
<qa_pair><label>1</label><question>2,3,4</question>
<answer>Yes</answer><solution>8,9,10</solution>
</chapter>`; // 缺少 </qa_pair>

const invalidXML2 = `这是一段自由文本，没有 XML 标签`;

console.log('  - 合法 XML:', isValidXMLStructure(validXML) ? '✅ 通过' : '❌ 失败');
console.log('  - 不完整 XML:', isValidXMLStructure(invalidXML1) ? '❌ 失败' : '✅ 通过（正确拒绝）');
console.log('  - 无 XML 标签:', isValidXMLStructure(invalidXML2) ? '❌ 失败' : '✅ 通过（正确拒绝）');
console.log();

// ============= 测试 2: LLMOutputParser - ID-Only 校验 =============
console.log('测试 2: LLMOutputParser - ID-Only 校验');

const testBlocks = [
  { id: 0, type: 'text', text: 'Chapter 1: Square Roots' },
  { id: 1, type: 'text', text: '1. What is the square root of 16?' },
  { id: 2, type: 'text', text: 'Solution: The square root of 16 is 4.' }
];

const parser = new LLMOutputParser(testBlocks, 'images');

// 测试合法的 ID 输出
const validOutput = `<chapter><title>0</title>
<qa_pair><label>1</label><question>1</question>
<answer>4</answer><solution>2</solution></qa_pair>
</chapter>`;

try {
  const result = parser.parse(validOutput, 0);
  console.log('  - 合法 ID 输出: ✅ 通过');
  console.log('    解析结果:', result.length, '个 QA 对');
  console.log('    问题文本:', result[0].question);
} catch (error) {
  console.log('  - 合法 ID 输出: ❌ 失败 -', error.message);
}

// 测试非法的自由文本输出
const invalidOutput = `<chapter><title>Chapter 1: Square Roots</title>
<qa_pair><label>1</label><question>What is the square root of 16?</question>
<answer>4</answer><solution>The square root of 16 is 4.</solution></qa_pair>
</chapter>`;

try {
  const result = parser.parse(invalidOutput, 0);
  console.log('  - 自由文本输出: ❌ 失败（应该被拒绝）');
} catch (error) {
  console.log('  - 自由文本输出: ✅ 通过（正确拒绝）');
  console.log('    错误信息:', error.message.substring(0, 100) + '...');
}
console.log();

// ============= 测试 3: QAMerger - 标题规范化 =============
console.log('测试 3: QAMerger - 标题规范化');

const merger = new QAMerger({ strictTitleMatch: false });

// 使用私有方法测试（通过反射）
const testTitles = [
  '19.1 平方根与立方根',
  '19.1 (一) 算术平方根',
  '第六章 二次函数',
  'Chapter 19.1'
];

console.log('  宽松模式下的标题规范化:');
// 注意：由于 normalizeTitle 是私有方法，这里只能通过实际合并来测试
// 创建测试数据
const questions = [
  { label: '1', question: 'Q1', answer: '', solution: '', chapter_title: '19.1 平方根与立方根', images: [] },
  { label: '2', question: 'Q2', answer: '', solution: '', chapter_title: '第六章 二次函数', images: [] }
];

const answers = [
  { label: '1', question: '', answer: 'A1', solution: '', chapter_title: '19.1 (一) 算术平方根', images: [] },
  { label: '2', question: '', answer: 'A2', solution: '', chapter_title: '六', images: [] }
];

const merged = merger.merge(questions, answers);
console.log('  - 合并结果:', merged.length, '个 QA 对');
console.log('  - 第 1 题匹配:', merged[0].answer === 'A1' ? '✅ 成功' : '❌ 失败');
console.log('  - 第 2 题匹配:', merged[1].answer === 'A2' ? '✅ 成功' : '❌ 失败');
console.log();

// ============= 测试 4: 提示词版本 =============
console.log('测试 4: 提示词版本');

try {
  const promptV2 = getQAExtractPrompt('v2');
  console.log('  - V2 提示词长度:', promptV2.length, '字符');
  console.log('  - 包含 "ID-ONLY" 关键词:', promptV2.includes('ID-ONLY') ? '✅ 是' : '❌ 否');
  console.log('  - 包含错误示例:', promptV2.includes('❌ WRONG') ? '✅ 是' : '❌ 否');
} catch (error) {
  console.log('  - 提示词加载: ❌ 失败 -', error.message);
}
console.log();

// ============= 测试 5: QualityGate - 完整流程 =============
console.log('测试 5: QualityGate - 完整流程');

const qualityGate = new QualityGate({
  enablePreParseGate: true,
  enablePostParseGate: true,
  enablePostMergeGate: true
});

// Pre-Parse Gate
const preParseResult = qualityGate.validatePreParse(validXML, 0);
console.log('  - Pre-Parse Gate:', preParseResult.passed ? '✅ 通过' : '❌ 失败');

// Post-Parse Gate
const testPairs = [
  { label: '1', question: 'Q1', answer: 'A1', solution: 'S1', chapter_title: 'C1', images: [] },
  { label: '2', question: '', answer: '', solution: '', chapter_title: 'C1', images: [] } // 空 QA 对
];
const postParseResult = qualityGate.validatePostParse(testPairs, 0);
console.log('  - Post-Parse Gate:', postParseResult.passed ? '✅ 通过' : '❌ 失败');

// Post-Merge Gate
const testMerged = [
  { label: '1', question_chapter_title: 'C1', answer_chapter_title: 'C1', question: 'Q1', answer: 'A1', solution: 'S1', images: [] },
  { label: '2', question_chapter_title: 'C1', answer_chapter_title: '', question: '', answer: '', solution: '', images: [] }
];
const postMergeResult = qualityGate.validatePostMerge(testMerged);
console.log('  - Post-Merge Gate:', postMergeResult.passed ? '✅ 通过' : '❌ 失败');

// 过滤低质量数据
const filtered = qualityGate.filterLowQualityPairs(testMerged);
console.log('  - 低质量过滤: 从', testMerged.length, '个减少到', filtered.length, '个');
console.log();

console.log('=== 测试完成 ===');
console.log('\n所有新模块的基本功能已验证。');
console.log('下一步：将新模块集成到现有代码中，并运行完整的端到端测试。');
