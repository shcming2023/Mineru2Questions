/**
 * 答案区域检测模块
 * 对齐DataFlow官方实践: 分离question和answer处理流程
 */

import { ConvertedBlock } from './extraction';

/**
 * 检测答案区域的起始位置
 * 通过识别"附录"、"参考答案"、"习题答案"等关键词来分离题目和答案区域
 * @param blocks 转换后的内容块
 * @returns 答案区域的起始索引,如果未找到则返回blocks.length
 */
export function findAnswerSection(blocks: ConvertedBlock[]): number {
  // 答案区域的常见标题模式
  const answerPatterns = [
    /^附\s*录/,
    /^参考答案/,
    /^习题答案/,
    /^答\s*案/,
    /^解\s*答/,
    /^Appendix/i,
    /^Answer\s*Key/i,
    /^Solutions?/i
  ];
  
  // 从后往前搜索,因为答案通常在教材末尾
  for (let i = Math.floor(blocks.length * 0.5); i < blocks.length; i++) {
    const block = blocks[i];
    
    // 检查title类型的块
    if (block.type === 'title' && block.text) {
      const text = block.text.trim();
      for (const pattern of answerPatterns) {
        if (pattern.test(text)) {
          console.log(`[Answer Detection] Found answer section at block ${i}: "${text}"`);
          return i;
        }
      }
    }
    
    // 检查text类型的块中是否有大标题特征
    if (block.type === 'text' && block.text) {
      const text = block.text.trim();
      // 如果文本很短(<20字符)且匹配答案标题模式,也认为是答案区域
      if (text.length < 20) {
        for (const pattern of answerPatterns) {
          if (pattern.test(text)) {
            console.log(`[Answer Detection] Found answer section at block ${i}: "${text}"`);
            return i;
          }
        }
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
