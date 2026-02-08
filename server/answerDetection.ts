/**
 * 答案区域检测模块
 * 对齐DataFlow官方实践: 分离question和answer处理流程
 */

import { ConvertedBlock } from './extraction';
import { StrategyChain, DEFAULT_ANSWER_DETECTION } from './strategies';

const answerDetector = new StrategyChain(DEFAULT_ANSWER_DETECTION);

/**
 * 检测答案区域的起始位置
 * 通过识别"附录"、"参考答案"、"习题答案"等关键词来分离题目和答案区域
 * @param blocks 转换后的内容块
 * @returns 答案区域的起始索引,如果未找到则返回blocks.length
 */
export function findAnswerSection(blocks: ConvertedBlock[]): number {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    
    // Check Title Blocks (Explicit Header)
    if (block.type === 'title' && block.text) {
      const result = answerDetector.execute("explicit_header_match", { text: block.text, block });
      if (result.action === 'found') {
        console.log(`[Answer Detection] Found answer section at block ${i}: "${block.text}"`);
        return i;
      }
    }
    
    // Check Text Blocks (Short Header)
    if (block.type === 'text' && block.text) {
      const result = answerDetector.execute("short_header_match", { text: block.text, block });
      if (result.action === 'found') {
        console.log(`[Answer Detection] Found answer section at block ${i}: "${block.text}"`);
        return i;
      }
    }
  }
  
  console.log('[Answer Detection] No answer section found, treating all blocks as questions');
  return blocks.length; // 未找到答案区域,全部视为题目
}

/**
 * 分离题目和答案区域
 * @param blocks 转换后的内容块
 * @returns { questionBlocks, answerBlocks }
 */
export function separateQuestionAndAnswer(blocks: ConvertedBlock[]): {
  questionBlocks: ConvertedBlock[];
  answerBlocks: ConvertedBlock[];
} {
  const answerStartIndex = findAnswerSection(blocks);
  
  return {
    questionBlocks: blocks.slice(0, answerStartIndex),
    answerBlocks: blocks.slice(answerStartIndex)
  };
}
