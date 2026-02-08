/**
 * 数学题目提取核心逻辑
 * 基于DataFlow FlipVQA-Miner论文的ID-based提取方式
 * 
 * 核心思路:
 * 1. 解析MinerU的content_list.json,为每个内容块分配ID
 * 2. 让LLM输出内容块ID而非原文,大幅减少token消耗
 * 3. 根据章节标题+题号进行问答匹配
 * 4. 支持问题和答案分离的教材
 * 
 * 优化改进 (基于独立评审):
 * - A. 切片边界: 增加Overlap重叠窗口避免题目被切断
 * - B. 提示词优化: 强调连续ID的重要性
 * - C. 多文件支持: 支持试卷和答案分离的场景
 */

import axios from "axios";
import { StrategyChain, DEFAULT_TITLE_FILTERS, DEFAULT_SOLUTION_VALIDATION, DEFAULT_NOISE_FILTERS } from "./strategies";

// Initialize Quality Gate
const titleQualityGate = new StrategyChain(DEFAULT_TITLE_FILTERS);
const solutionValidator = new StrategyChain(DEFAULT_SOLUTION_VALIDATION);
const noiseFilter = new StrategyChain(DEFAULT_NOISE_FILTERS);

export type AuditLogFn = (
  stage: string,
  inputLen: number,
  outputLen: number,
  rejectReason: string | null,
  fallbackUsed: boolean,
  timestamp: number
) => void;

// ============= 类型定义 =============

export interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  maxWorkers: number;
  timeout: number;
  // Fault Tolerance
  maxRetries?: number;
  onSoftFail?: 'skip' | 'loosen' | 'default';
}

// MinerU content_list.json中的内容块类型
export interface ContentBlock {
  id: number;           // 分配的ID
  type: string;         // text, image, table, equation等
  text?: string;        // 文本内容
  img_path?: string;    // 图片路径
  image_caption?: string[]; // 图片标题
  page_idx?: number;    // 页码
  bbox?: number[];      // 边界框
  list_items?: string[]; // 列表项(type=list时)
  sub_type?: string;    // 子类型
}

// 转换后的LLM输入格式
export interface ConvertedBlock {
  id: number;
  type: string;
  text?: string;
  img_path?: string;
  image_caption?: string;
}

// 提取的QA对
export interface ExtractedQAPair {
  label: string;           // 题号 (如 "1", "例1")
  question: string;        // 问题文本
  answer: string;          // 答案
  solution: string;        // 解答过程
  chapter_title: string;   // 章节标题
  images: string[];        // 关联图片路径
  sourcePageIndex?: number;
  // 用于去重的原始ID信息
  questionIds?: string;
  solutionIds?: string;
  // 用于区分不同chunk的题目
  chunkIndex?: number;
  // 用于记录原始章节标题(未规范化)
  rawChapterTitle?: string;
}

// 合并后的完整QA对
export interface MergedQAPair {
  label: string;
  question_chapter_title: string;
  answer_chapter_title: string;
  question: string;
  answer: string;
  solution: string;
  images: string[];
}

// ============= 提示词模板 =============

/**
 * QA提取提示词 - 参考DataFlow的QAExtractPrompt
 * 让LLM输出内容块ID而非原文
 * 
 * 优化: 增加了连续ID的强调说明
 */
export const QA_EXTRACT_PROMPT = `You are an expert in extracting questions and answers from educational materials. You are given a JSON file containing content blocks from a textbook page. Your task is to segment the content, insert image IDs, and extract labels.

## Your Tasks:
1. Every JSON item has an "id" field. Your main task is to output these IDs.
2. Extract ALL math problems (including examples marked as "例①", "例1", "Example 1", etc.) and their corresponding answers/solutions.
3. **CRITICAL: ONE QUESTION PER <qa_pair> ONLY. NEVER merge multiple questions into a single <qa_pair> block.**
4. **INTERLEAVED CONTENT HANDLING**: If a problem and its answer/solution appear contiguously (e.g., "例① ...题干..." followed by "解: ...解答..."), wrap them together as a single <qa_pair> block.
5. **DISTINGUISH DEFINITIONS FROM PROBLEMS**: Pure definition text (e.g., "如果一个数x的立方等于a...") without a problem number or question structure is NOT a problem - do not extract it.
6. If a problem or answer/solution is incomplete (e.g., continues to next chunk), omit it. An answer/solution is complete if either the answer or solution exists.
7. Put image IDs into proper positions based on context or captions.
8. Extract chapter titles and each problem's label/number from the text.
9. Only output "id" fields for chapter titles, questions, and solutions. DO NOT OUTPUT ORIGINAL TEXT. Use ',' to separate different IDs.
10. However, use original labels/numbers for labels, and extract original text for short answers.

## CRITICAL: Consecutive ID Handling
- When a question or solution spans multiple consecutive blocks, you MUST include ALL consecutive IDs.
- For example, if a math problem consists of blocks 10, 11, 12, 13, output "10,11,12,13" - DO NOT skip any IDs.
- Pay special attention to equation blocks (type='equation') - they are often part of the surrounding text.
- If blocks 10, 11(equation), 12 form a complete sentence, output "10,11,12" not "10,12".

## Strict Extraction Rules:

### CRITICAL: Question Numbering Recognition
- Circled numbers ①②③④⑤⑥⑦⑧⑨⑩ are INDEPENDENT questions, NOT sub-questions. Each ① or ② starts a NEW <qa_pair>.
- Arabic numbers like 1. 2. 3. or 1) 2) 3) are also INDEPENDENT questions.
- ONLY (1)(2)(3) or (a)(b)(c) or (i)(ii)(iii) WITHIN a question are sub-questions that belong together.
- Example: "① 如图..." and "② 某校..." are TWO separate questions, not sub-questions of one question.

### About Questions and Answers/Solutions:
- **EXAMPLES ARE PROBLEMS**: Problems marked as "例①", "例1", "Example 1" are valid problems and MUST be extracted.
- **INTERLEAVED EXAMPLES**: When an example (e.g., "例①") is immediately followed by its solution (e.g., "解:" or "分析:"), extract them together:
  <qa_pair><label>1</label><question>EXAMPLE_IDS</question><answer></answer><solution>SOLUTION_IDS</solution></qa_pair>
- **DEFINITION TEXT**: Pure definition or property statements (e.g., "如果一个数x的立方等于a...", "平方根与立方根的定义、性质对照表") without a problem number or question structure are NOT problems - do not extract them.
- **Preserve each problem’s original label/number**, such as "例1", "Example 3", "习题1", "11", "①".
- Use Arabic numerals for numbered lists, but preserve original prefixes. For example, if the label is "例一", convert it to "例1". If the label is "IV", convert it to "4".
- If the full label is "三、16", keep only "16". If "5.4", keep only "4".
- If there are multiple sub-questions (like "(1)", "(a)") under one main question, put them together in the same <qa_pair> block.
- But ①②③ are NOT sub-questions - they are separate questions!
- If a question and its answer/solution are contiguous, wrap them together as a single <qa_pair> block.
- If only questions or only answers/solutions appear, wrap each in its own <qa_pair> block with the missing part left empty.
- There are 7 possibilities: only question, only answer, only solution, question+answer, question+solution, answer+solution, full QA.
- If you don't see the full solution, only extract the short answer and leave solution empty. YOU MUST KEEP SHORT ANSWERS!

### About Chapter/Section Titles:
- Always enclose qa pairs in a <chapter>...</chapter> block, where <title>MAIN_TITLE_ID</title> is the ID of the chapter title.
- Normally, chapter/section titles appear before questions/answers in an independent JSON item.
- There could be multiple <chapter>...</chapter> blocks if multiple chapters/sections exist.
- Any title followed by a question/answer whose label is not 1, or title with a score like "一、选择题（每题1分，共10分）", should NOT be extracted.
- Do not use nested titles.
- Leave the title blank if there is no chapter title.

### About Figures/Diagrams:
- Whenever a question or answer/solution refers to a figure or diagram, record its "id" in question/answer/solution just like other text content.
- You MUST include all images referenced in the question/answer/solution.
- Image blocks have type "image" and contain "img_path" field.

## Output Format:
If no qualifying content is found, output:
<empty></empty>

Otherwise output (all tags run together, no extra whitespace):
<chapter><title>MAIN_TITLE_ID</title>
<qa_pair><label>LABEL</label><question>QUESTION_IDS</question>
<answer>ANSWER_TEXT</answer><solution>SOLUTION_IDS</solution></qa_pair>
</chapter>

## Example 1 (Standard numbered questions):
<chapter><title>7</title>
<qa_pair><label>1</label><question>2,3,4,5</question>
<answer>Yes</answer><solution>8,9,10,11,12</solution></qa_pair>
<qa_pair><label>2</label><question>13,14,15,16</question>
<answer>3.14</answer><solution></solution></qa_pair>
</chapter>

## Example 2 (Circled number questions - EACH ①②③ is a SEPARATE question):
Input blocks:
- id=10: "一、选择题"
- id=11: "① 如图, 直线 l 与正五边形..."
- id=12: image
- id=13: "② 某校“智慧数学教室”..."
- id=14: image
- id=15: "③ 一个多边形切去一个角后..."

Correct output (3 separate qa_pairs):
<chapter><title>10</title>
<qa_pair><label>1</label><question>11,12</question>
<answer></answer><solution></solution></qa_pair>
<qa_pair><label>2</label><question>13,14</question>
<answer></answer><solution></solution></qa_pair>
<qa_pair><label>3</label><question>15</question>
<answer></answer><solution></solution></qa_pair>
</chapter>

WRONG output (treating ①②③ as sub-questions of one question):
<chapter><title>10</title>
<qa_pair><label>1</label><question>11,12,13,14,15</question>
<answer></answer><solution></solution></qa_pair>
</chapter>

Please now process the provided JSON and output your result.`;

/**
 * VQA提取提示词 - 用于直接从页面图片提取(备用方案)
 */
export const VQA_EXTRACT_PROMPT = `You are an expert in math education. You are given an image of a textbook page annotated with detected bounding boxes and labels. Your task is to extract:

1. All math problems whose text begins on this page and their answers/solutions if present.
2. If a problem or answer is incomplete (continues to next page), omit it.
3. A box at the beginning of a page with no problem number is likely continuation from previous page - omit it.
4. The chapter information as it appears on the page. Include all titles even if no questions are present under them.

## Strict Rules:

### About Questions and Answers:
- If the page is not main text (cover, catalog, header/footer only), output <empty></empty>.
- Preserve original labels like "例1", "Example 3", "习题1". Use Arabic numerals only.
- If multiple sub-questions exist under one main question, put them in the same <qa_pair> block.
- If question and answer are contiguous, wrap them together.
- If only questions or only answers appear, wrap each with missing parts empty.

### About Chapter Titles:
- Enclose output in <chapter>...</chapter> blocks with <title>MAIN_TITLE</title>.
- Extract chapter titles only, no prefix numbers. Do not keep subtitles.
- If a title has no problems on the page, still extract it with label 0.

### About Figures:
- For figures/diagrams, record with <pic>tagA:boxB</pic> using the RED labeled tags in the image.
- Put <pic> tags at exact positions where figures are referenced.

## Output Format:
<chapter><title>MAIN_TITLE</title>
<qa_pair><label>...</label><question>QUESTION_TEXT<pic>...</pic></question>
<answer>ANSWER_TEXT</answer><solution>SOLUTION_TEXT</solution></qa_pair>
</chapter>

If no content found: <empty></empty>`;

// ============= MinerU输出解析 =============

/**
 * 检测是否为目录列表
 * 目录特征: 大部分条目以页码数字结尾 (如 "19.1 算术平方根(1) 2")
 * 
 * 改进: 避免误判选项列表 ("A. 选项1", "B. 选项2")
 */
function isTocList(items: string[]): boolean {
  if (!items || items.length === 0) return false;
  
  // 排除选项列表: 以"A."/"B."/"C."/"D."开头的列表
  const optionPattern = /^[A-D]\.\s/;
  const optionCount = items.filter(item => optionPattern.test(item)).length;
  if (optionCount >= items.length * 0.5) {
    return false; // 这是选项列表,不是目录
  }
  
  // 目录特征: 末尾是页码数字,且前面是中文或括号(不是选项字母)
  const pageNumPattern = /[)\uff09\u4e00-\u9fff]\s*\d{1,3}\s*$/;
  const matchCount = items.filter(item => pageNumPattern.test(item)).length;
  
  // 超过50%的条目符合页码格式,判定为目录
  return matchCount >= items.length * 0.5;
}

/**
 * 解析MinerU的content_list.json并转换为带ID的格式
 * 参考DataFlow的MinerU2LLMInputOperator实现
 * 
 * P0修复: 增加目录页检测,避免目录条目被误识别为题目
 */
export function convertMinerUContentList(contentList: any[]): ConvertedBlock[] {
  const convertedBlocks: ConvertedBlock[] = [];
  let currentId = 0;
  
  // 噪音类型过滤: 这些类型不包含题目内容
  const noisyTypes = new Set(['header', 'footer', 'page_number', 'aside_text']);

  for (const item of contentList) {
    // 跳过噪音类型
    if (noisyTypes.has(item.type)) {
      continue;
    }
    
    // 处理列表类型
    if (item.type === 'list' && item.sub_type === 'text' && item.list_items) {
      for (const listItem of item.list_items) {
        convertedBlocks.push({
          id: currentId,
          type: 'text',
          text: listItem
        });
        currentId++;
      }
      continue;
    }

    // 移除不需要的字段(bbox, page_idx)
    const block: ConvertedBlock = {
      id: currentId,
      type: item.type || 'text'
    };

    // 处理文本
    if (item.text) {
      block.text = item.text;
    }

    // 处理图片
    if (item.img_path) {
      block.img_path = item.img_path;
      if (item.image_caption) {
        block.image_caption = Array.isArray(item.image_caption) 
          ? item.image_caption.join(' ') 
          : item.image_caption;
      }
    }

    convertedBlocks.push(block);
    currentId++;
  }

  return convertedBlocks;
}

/**
 * 将ID列表转换回原始文本
 * 
 * 优化3: 智能文本拼接
 * - 行内公式(短内容)使用空格连接而非换行
 * - 避免句子被打断的问题
 */
export function idsToText(
  idString: string, 
  blocks: ConvertedBlock[], 
  imagePrefix: string = "images"
): string {
  if (!idString || idString.trim() === '') return '';
  
  // 检测LLM是否输出了文本而非ID列表
  const cleanedString = idString.replace(/\s/g, '');
  if (!/^[\d,，]+$/.test(cleanedString) && cleanedString.length > 10) {
    console.warn(`[Warning] LLM可能输出了文本而非ID: "${idString.substring(0, 50)}..."`);
  }
  
  // 支持中文逗号分隔
  const idList = idString.replace(/\s/g, '').replace(/，/g, ',').split(',');
  
  let resultText = '';
  let prevBlock: ConvertedBlock | null = null;

  for (const idStr of idList) {
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 0 || id >= blocks.length) continue;

    const block = blocks[id];
    if (!block) continue;

    let content = '';
    if (block.text) {
      content = block.text;
    } else if (block.img_path) {
      const imgName = block.img_path.split('/').pop() || block.img_path;
      const caption = block.image_caption || 'image';
      content = `![${caption}](${imagePrefix}/${imgName})`;
    }
    
    if (!content) continue;

    // 智能拼接逻辑
    if (resultText.length > 0) {
      // 判断是否为行内公式或短内容
      // 启发式规则: 公式类型、以$开头、或内容很短且不含换行
      const isInlineContent = 
        block.type === 'equation' || 
        block.text?.startsWith('$') ||
        (content.length < 50 && !content.includes('\n'));
      
      const prevIsInlineContent = prevBlock && (
        prevBlock.type === 'equation' || 
        prevBlock.text?.startsWith('$') ||
        (prevBlock.text && prevBlock.text.length < 50 && !prevBlock.text.includes('\n'))
      );
      
      // 如果当前或前一个是行内内容,用空格连接
      if (isInlineContent || prevIsInlineContent) {
        resultText += ' ' + content;
      } else {
        resultText += '\n' + content;
      }
    } else {
      resultText = content;
    }
    
    prevBlock = block;
  }

  return resultText;
}

/**
 * 从ID字符串中提取图片路径
 */
export function extractImagesFromIds(
  idString: string, 
  blocks: ConvertedBlock[]
): string[] {
  if (!idString || idString.trim() === '') return [];
  
  const images: string[] = [];
  const idList = idString.replace(/\s/g, '').split(',');

  for (const idStr of idList) {
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 0 || id >= blocks.length) continue;

    const block = blocks[id];
    if (block?.img_path) {
      images.push(block.img_path);
    }
  }

  return images;
}

// ============= LLM输出解析 =============

/**
 * 清洗chapter_title,过滤节标记和目录类内容
 * 
 * 需要过滤的内容:
 * - 节标记: "名校考题精选", "各区考题精选", "挑战压轴题", "思维与拓展"
 * - 目录类: "本期导读", "本学期将学习"
 * - 题型标记: "一、选择题", "二、填空题", "三、解答题"
 */
export function cleanChapterTitle(title: string): string {
  if (!title) return '';
  
  const result = titleQualityGate.execute("section_marker_filter", { text: title });
  return result.action === 'drop' ? '' : title.trim();
}

/**
 * 检测并拆分合并的多题
 * 
 * 检测question中是否包含多个题号标记:
 * - 数字题号: "1.", "2.", "3." 等
 * - 圆圈题号: "①", "②", "③" 等
 * - 括号题号: "(1)", "(2)", "(3)" 等
 * 
 * 如果检测到多个题号,按题号边界拆分成多个独立的QA对
 */
export function splitMergedQuestion(
  qa: ExtractedQAPair,
  blocks: ConvertedBlock[],
  imagePrefix: string
): ExtractedQAPair[] {
  const questionText = qa.question.trim();
  
  // 题号模式(匹配行首或换行后的题号)
  const labelPatterns = [
    /(?:^|\n)(\d+)[\.\.、]\s/g,  // 数字+点/顿号: "1. ", "2. "
    /(?:^|\n)([①-⑳])\s/g,      // 圆圈数字: "① ", "② "
    /(?:^|\n)\((\d+)\)\s/g,    // 括号数字: "(1) ", "(2) "
    /(?:^|\n)([一二三四五六七八九十]+)[\.\.、]\s/g,  // 中文数字: "一. ", "二. "
  ];
  
  // 查找所有题号位置
  const labelPositions: Array<{ index: number; label: string }> = [];
  
  for (const pattern of labelPatterns) {
    let match;
    while ((match = pattern.exec(questionText)) !== null) {
      const label = match[1];
      const index = match.index + (match[0].startsWith('\n') ? 1 : 0);
      labelPositions.push({ index, label });
    }
  }
  
  // 如果只有0-1个题号,不需要拆分
  if (labelPositions.length <= 1) {
    return [qa];
  }
  
  // 按位置排序
  labelPositions.sort((a, b) => a.index - b.index);
  
  // 检查是否是选择题选项(A/B/C/D)而非真正的题号
  // 如果题号都是连续的单个字母且只有4个以内,可能是选项
  const allSingleDigit = labelPositions.every(p => /^\d$/.test(p.label) && parseInt(p.label) <= 4);
  if (allSingleDigit && labelPositions.length <= 4) {
    // 检查是否紧跟选项内容(A/B/C/D模式)
    const hasOptions = /[\(\uff08][A-D][\)\uff09]/.test(questionText);
    if (hasOptions) {
      return [qa]; // 这是选择题选项,不拆分
    }
  }
  
  // 按题号边界拆分
  const splitResults: ExtractedQAPair[] = [];
  
  for (let i = 0; i < labelPositions.length; i++) {
    const start = labelPositions[i].index;
    const end = i < labelPositions.length - 1 ? labelPositions[i + 1].index : questionText.length;
    const segmentText = questionText.substring(start, end).trim();
    
    // 移除题号前缀
    const cleanedText = segmentText.replace(/^\d+[\.、]\s*/, '')
                                   .replace(/^[①-⑳]\s*/, '')
                                   .replace(/^\(\d+\)\s*/, '')
                                   .replace(/^[一二三四五六七八九十]+[\.、]\s*/, '');
    
    if (cleanedText.length > 10) {  // 过滤太短的片段
      splitResults.push({
        label: labelPositions[i].label,
        question: cleanedText,
        answer: i === 0 ? qa.answer : '',  // 只有第一题保留原answer
        solution: i === 0 ? qa.solution : '',  // 只有第一题保留原solution
        chapter_title: qa.chapter_title,
        images: i === 0 ? qa.images : [],  // 只有第一题保留图片
        questionIds: qa.questionIds,
        solutionIds: qa.solutionIds,
        chunkIndex: qa.chunkIndex
      });
    }
  }
  
  // 如果拆分失败(结果为空),返回原QA对
  return splitResults.length > 0 ? splitResults : [qa];
}

/**
 * 解析LLM的XML格式输出
 * 参考DataFlow的LLMOutputParser实现
 */
export function parseLLMOutput(
  output: string, 
  blocks: ConvertedBlock[],
  imagePrefix: string = "images",
  mode: 'question' | 'answer' = 'question'
): ExtractedQAPair[] {
  let qaPairs: ExtractedQAPair[] = [];

  // 检查是否为空
  if (output.includes('<empty></empty>') || output.includes('<empty/>')) {
    return [];
  }

  // 提取所有chapter块
  const chapterMatches = output.match(/<chapter>([\s\S]*?)<\/chapter>/g) || [];

  for (const chapterBlock of chapterMatches) {
    // 提取章节标题
    const titleMatch = chapterBlock.match(/<title>(.*?)<\/title>/);
    let chapterTitle = '';
    if (titleMatch) {
      const titleIds = titleMatch[1].trim();
      chapterTitle = idsToText(titleIds, blocks, imagePrefix);
      
      // P1修复: 清洗chapter_title,过滤节标记和目录类内容
      chapterTitle = cleanChapterTitle(chapterTitle);
    }

    // 提取所有qa_pair块
    const pairMatches = chapterBlock.match(/<qa_pair>([\s\S]*?)<\/qa_pair>/g) || [];

    for (const pairBlock of pairMatches) {
      // 提取label
      const labelMatch = pairBlock.match(/<label>([\s\S]*?)<\/label>/);
      if (!labelMatch) continue;
      const label = labelMatch[1].trim();

      // 提取question (ID列表)
      const questionMatch = pairBlock.match(/<question>([\s\S]*?)<\/question>/);
      const questionIds = questionMatch ? questionMatch[1].trim() : '';
      const questionText = idsToText(questionIds, blocks, imagePrefix);
      const questionImages = extractImagesFromIds(questionIds, blocks);

      // 提取answer (直接文本,不是ID)
      const answerMatch = pairBlock.match(/<answer>([\s\S]*?)<\/answer>/);
      const answer = answerMatch ? answerMatch[1].trim() : '';

      // 提取solution (ID列表)
      const solutionMatch = pairBlock.match(/<solution>([\s\S]*?)<\/solution>/);
      const solutionIds = solutionMatch ? solutionMatch[1].trim() : '';
      const solutionText = idsToText(solutionIds, blocks, imagePrefix);
      const solutionImages = extractImagesFromIds(solutionIds, blocks);

      // 合并图片
      const allImages = Array.from(new Set([...questionImages, ...solutionImages]));

      // P0修复: 对齐DataFlow官方 - 至少有 label + (question 或 answer 或 solution)
      // DataFlow的 LLMOutputParser._convert_response:
      // if not ((q_match and label_match) or (a_match and label_match) or (s_match and label_match)): continue
      const hasContent = questionText.trim() || answer.trim() || solutionText.trim();
      if (!hasContent) {
        continue; // 跳过完全空的 qa_pair
      }

      qaPairs.push({
        label,
        question: questionText,
        answer,
        solution: solutionText,
        chapter_title: chapterTitle,
        images: allImages,
        // 保存原姛ID用于去重
        questionIds,
        solutionIds
      });
    }
  }

  // P0修复: 第二层过滤 - 移除目录条目格式的question
  // 目录格式: "数字.数字 + 中文 + (数字) + 页码"
  // 例: "1 算术平方根(1) 2" 或 "19.1 算术平方根(1) 2"
  qaPairs = qaPairs.filter(qa => {
    const q = qa.question.trim();
    // 目录条目特征: 以页码数字结尾且很短(<100字符)
    if (q.length < 100 && /[)）\u4e00-\u9fff]\s*\d{1,3}\s*$/.test(q)) {
      return false; // 这是目录条目,不是真题目
    }
    return true;
  });

  // P0修复: 第三层处理 - 检测并拆分合并的多题
  // 如果一个question中包含多个题号标记,说明LLM错误地合并了多题
  const splitPairs: ExtractedQAPair[] = [];
  for (const qa of qaPairs) {
    const splitResults = splitMergedQuestion(qa, blocks, imagePrefix);
    splitPairs.push(...splitResults);
  }

  // 修复: 过滤chapter_title为空的条目(消除出版信息等噪声)
  // 评审报告问题2: 出版信息被混入为label=7的"题目",chapter_title为空
  const filteredPairs = splitPairs.filter(qa => {
    if (!qa.chapter_title || qa.chapter_title.trim() === '') {
      return false; // 过滤掉chapter_title为空的条目
    }
    return true;
  });

  return filteredPairs;
}

// ============= 章节标题规范化 =============

/**
 * 规范化章节标题 - 用于匹配问题和答案
 * 回归DataFlow官方refine_title逻辑:
 * - 删除所有空格和换行
 * - strictMatch=false时,只提取数字编号(如"19.1"或"19"),丢弃中文描述
 * - 这确保同一章节的不同表述(如"19.1平方根与立方根"和"19.1(一)算术平方根")都匹配为"19.1"
 * 
 * 参考: OpenDCAI/DataFlow/dataflow/utils/pdf2vqa/format_utils.py::refine_title
 */
export function normalizeTitle(title: string, strictMatch: boolean = false): string {
  // 删除空格和换行
  let normalized = title.replace(/\s+/g, '');

  if (!strictMatch) {
    try {
      // 优先提取阿拉伯数字章节编号(如"19.1"、"23"等)
      const arabicMatch = normalized.match(/\d+\.\d+|\d+/);
      if (arabicMatch) {
        return arabicMatch[0];
      }
    } catch (e) {
      // 忽略错误,继续尝试中文数字
    }
    
    try {
      // 其次提取中文数字章节编号(如"六"、"二十四"等)
      const chineseMatch = normalized.match(/[一二三四五六七八九零十百]+/);
      if (chineseMatch) {
        return chineseMatch[0];
      }
    } catch (e) {
      // 如果也失败,返回原始规范化后的标题
    }
  }

  return normalized;
}

/**
 * 规范化题号 - 用于排序
 * 提取第一个数字用于排序比较
 * 
 * 优化: 支持圆圈数字①②③的转换
 * 参考官方DataFlow的label处理逻辑
 */
export function normalizeLabel(label: string): number | null {
  // 首先尝试将圆圈数字转换为阿拉伯数字
  const convertedLabel = convertCircledNumbers(label);
  
  // 提取数字部分用于排序
  const match = convertedLabel.match(/\d+/);
  if (match) {
    return parseInt(match[0], 10);
  }
  return null;
}

/**
 * 将圆圈数字转换为阿拉伯数字
 * ① -> 1, ② -> 2, ..., ⑳ -> 20
 * 
 * 这是对官方DataFlow的补充,官方没有处理这种情况
 */
export function convertCircledNumbers(text: string): string {
  // 圆圈数字字符集 (Unicode: U+2460 - U+2473)
  const circledNumbers = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  
  let result = text;
  for (let i = 0; i < circledNumbers.length; i++) {
    result = result.replace(new RegExp(circledNumbers[i], 'g'), String(i + 1));
  }
  return result;
}

/**
 * 获取题号的唯一标识Key
 * 
 * 优化1: 支持复合题号(1.1, 1.2, 1-2等)避免Hash冲突
 * - "1.1" -> "1.1", "1.2" -> "1.2" (不会冲突)
 * - "例1" -> "1", "习题1" -> "1"
 * - 保留数字、点、横杠等用于区分
 * 
 * 优化2: 支持圆圈数字①②③的转换
 */
export function getLabelKey(label: string): string {
  // 首先将圆圈数字转换为阿拉伯数字
  let normalized = convertCircledNumbers(label);
  // 移除空格
  normalized = normalized.replace(/\s/g, '');
  // 去除前缀非数字字符 (如 "例", "习题", "Exercise")
  normalized = normalized.replace(/^[^\d]+/, '');
  // 如果结果为空,返回原始label作为兆底
  return normalized || label;
}

// ============= 问答合并 =============

/**
 * 优化2: 择优保留策略
 * 判断是否应该用新数据替换旧数据
 * 
 * 规则:
 * 1. 新数据有更完整的内容(更长的question/solution)
 * 2. 新数据有更多的字段填充
 */
function shouldReplaceQAPair(existing: ExtractedQAPair, newData: ExtractedQAPair): boolean {
  // 计算内容完整度分数
  const existingScore = 
    (existing.question?.length || 0) + 
    (existing.answer?.length || 0) + 
    (existing.solution?.length || 0);
  
  const newScore = 
    (newData.question?.length || 0) + 
    (newData.answer?.length || 0) + 
    (newData.solution?.length || 0);
  
  // 新数据更完整时替换
  return newScore > existingScore;
}

/**
 * 检查solution是否有效
 * 对齐DataFlow官方: 过滤包含"Law:"等无效标记的solution
 */
function isValidSolution(solution: string): boolean {
  // Use Strategy Pattern
  const result = solutionValidator.execute("keyword_block_filter", { text: solution });
  return result.action === 'keep';
}

/**
 * 合并问题和答案列表
 * 参考DataFlow的merge_qa_pair实现
 * 
 * 关键特性:
 * 1. 支持跨Chunk的问答匹配(题目在第1页,答案在第50页)
 * 2. 基于questionIds的精确去重,避免不同章节的相同题号被覆盖
 * 3. 已完整的题目(有question和answer/solution)直接输出
 * 
 * 优化: 使用questionIds作为主键,chapter_title:label作为辅助键
 * 这样可以避免不同章节的相同题号被覆盖
 */
export function mergeQAPairs(
  questions: ExtractedQAPair[],
  answers: ExtractedQAPair[],
  strictTitleMatch: boolean = false
): MergedQAPair[] {
  const merged: MergedQAPair[] = [];
  
  // 单层索引：normalizedChapter:labelKey -> ExtractedQAPair
  const qaMap = new Map<string, ExtractedQAPair>();
  
  // 章节上下文维护
  let currentQuestionChapter = '';
  
  // 处理问题列表
  for (const q of questions) {
    const labelNum = normalizeLabel(q.label);
    if (labelNum === null || labelNum <= 0) continue;
    
    // 章节上下文维护: 
    // 1. 如果当前题目有章节标题，更新上下文
    // 2. 如果当前题目没有章节标题，沿用上下文 (Context Inheritance)
    if (q.chapter_title && q.chapter_title.trim() !== '') {
      currentQuestionChapter = q.chapter_title;
    }
    
    // 规范化章节标题
    const normalizedChapter = normalizeTitle(currentQuestionChapter, strictTitleMatch);
    const labelKey = getLabelKey(q.label);
    // P0修复: 移除questionChapterId, 使用 (章节+题号) 作为唯一键
    const key = `${normalizedChapter}:${labelKey}`;
    
    // 已完整的题目直接输出 (Interleaved模式)
    if (q.question && (q.answer || q.solution)) {
      merged.push({
        label: q.label,
        question_chapter_title: currentQuestionChapter, // Use context
        answer_chapter_title: currentQuestionChapter, // Use context
        question: q.question,
        answer: q.answer,
        solution: q.solution,
        images: q.images
      });
    } else {
      // 未完整的题目缓存
      // 如果key已存在(例如同一章节有两个"1"), 这是一个数据质量问题
      // 策略: 覆盖旧的 (假设后面的提取更准确或是在修正)
      qaMap.set(key, { ...q, chapter_title: currentQuestionChapter }); // Use context (original title)
    }
  }
  
  // 处理答案列表
  let currentAnswerChapter = '';
  
  // 临时存储答案，以便后续合并
  const answerMap = new Map<string, ExtractedQAPair>();
  
  for (const a of answers) {
    const labelNum = normalizeLabel(a.label);
    if (labelNum === null || labelNum <= 0) continue;
    
    // 章节上下文维护
    if (a.chapter_title && a.chapter_title.trim() !== '') {
      currentAnswerChapter = a.chapter_title;
    }
    
    const normalizedChapter = normalizeTitle(currentAnswerChapter, strictTitleMatch);
    const labelKey = getLabelKey(a.label);
    // P0修复: 移除answerChapterId
    const key = `${normalizedChapter}:${labelKey}`;
    
    // 字段级别的增量更新
    if (!answerMap.has(key)) {
      answerMap.set(key, { ...a, chapter_title: currentAnswerChapter }); // Use context (original title)
    } else {
      const existing = answerMap.get(key)!;
      if (!existing.solution && a.solution) {
        existing.solution = a.solution;
      }
      if (!existing.answer && a.answer) {
        existing.answer = a.answer;
      }
      // 合并图片
      existing.images = Array.from(new Set([...existing.images, ...a.images]));
      // Update chapter title if needed? No, keep the first one or updated one?
      // Actually if we are inheriting, the first one set in map should be correct for that key.
    }
  }
  
  // 合并问题和答案
  // 遍历所有的问题
  for (const [key, q] of qaMap.entries()) {
    const labelNum = normalizeLabel(q.label)!;
    
    let answerPair: ExtractedQAPair | undefined;
    
    // 尝试精确匹配
    if (answerMap.has(key)) {
      answerPair = answerMap.get(key);
    } 
    
    const finalSolution = (answerPair && answerPair.solution && isValidSolution(answerPair.solution)) ? answerPair.solution : (q.solution && isValidSolution(q.solution) ? q.solution : '');
    const finalAnswer = (answerPair && answerPair.answer) ? answerPair.answer : q.answer;
    
    const combinedImages = Array.from(new Set([...q.images, ...(answerPair ? answerPair.images : [])]));

    merged.push({
      label: q.label,
      question_chapter_title: q.chapter_title,
      answer_chapter_title: answerPair ? answerPair.chapter_title : q.chapter_title,
      question: q.question,
      answer: finalAnswer,
      solution: finalSolution,
      images: combinedImages
    });
    
    // 标记该答案已被使用
    if (answerPair) {
        answerMap.delete(key);
    }
  }
  
  // 处理剩余的答案 (只有答案没有题目)
  for (const [key, a] of answerMap.entries()) {
      const labelNum = normalizeLabel(a.label)!;
      if (a.answer || a.solution) {
          merged.push({
              label: a.label,
              question_chapter_title: a.chapter_title,
              answer_chapter_title: a.chapter_title,
              question: '', // 问题为空
              answer: a.answer,
              solution: a.solution,
              images: a.images
          });
      }
  }
  
  return merged;
}

// ============= 内容分块 (带Overlap) =============

/**
 * 将内容块分组为适合LLM处理的chunk
 * 
 * 优化: 增加Overlap重叠窗口,避免题目在边界处被切断
 * 
 * @param blocks 内容块数组
 * @param maxChunkLen 单个chunk的最大字符长度(JSON序列化后)
 * @param overlapBlocks 重叠的块数量(用于边界保护)
 */
export function chunkContentBlocks(
  blocks: ConvertedBlock[], 
  maxChunkLen: number = 100000,
  overlapBlocks: number = 15
): ConvertedBlock[][] {
  const chunks: ConvertedBlock[][] = [];
  let currentChunk: ConvertedBlock[] = [];
  let currentLen = 0;
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockJson = JSON.stringify(block);
    const blockLen = blockJson.length;
    
    // 如果当前chunk超过限制,保存并开始新chunk
    if (currentLen + blockLen > maxChunkLen && currentChunk.length > 0) {
      chunks.push(currentChunk);
      
      // 新chunk从当前chunk的最后overlapBlocks个block开始(Overlap)
      // 这样可以保护边界处的题目不被切断
      const overlapStart = Math.max(0, currentChunk.length - overlapBlocks);
      currentChunk = currentChunk.slice(overlapStart);
      currentLen = currentChunk.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
    }
    
    currentChunk.push(block);
    currentLen += blockLen;
  }
  
  // 保存最后一个chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * 内部函数: 执行LLM API调用，包含网络错误重试逻辑
 * (原 callLLMForTextExtraction 的核心逻辑)
 */
async function callLLMWithApiRetries(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string,
  maxTokens: number,
  auditLog?: AuditLogFn
): Promise<string> {
  const baseUrl = config.apiUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  
  // 对齐DataFlow: max_retries=5 (default), 指数退避 1s, 2s, 4s, 8s, 16s
  const maxRetries = config.maxRetries ?? 5;
  let lastError: Error | null = null;
  const start = Date.now();
  
  auditLog?.('LLMExtract', contentJson.length, 0, null, false, start);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 强制最低timeout 120s(对齐DataFlow read_timeout)
      const effectiveTimeout = Math.max(config.timeout || 120, 120) * 1000;
      
      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: config.modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: contentJson }
          ],
          temperature: 0,
          max_tokens: maxTokens
        },
        {
          headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: effectiveTimeout
        }
      );
      
      // 验证响应格式
      if (!response.data) {
        throw new Error('LLM API返回空响应');
      }
      
      if (!response.data.choices || response.data.choices.length === 0) {
        console.error('[LLM API Error] No choices in response:', JSON.stringify(response.data, null, 2));
        throw new Error('LLM API返回的choices为空');
      }
      
      const content = response.data.choices[0].message?.content;
      if (!content) {
        throw new Error('LLM API返回的content为空');
      }
      
      // 成功返回
      auditLog?.('LLMExtract', contentJson.length, content.length, null, attempt > 0, Date.now());
      return content;
      
    } catch (axiosError: any) {
      lastError = axiosError;
      
      // 详细记录API调用失败的原因
      const errorDetails = {
        attempt: attempt + 1,
        maxRetries,
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        data: axiosError.response?.data,
        message: axiosError.message,
        code: axiosError.code
      };
      console.error(`[LLM API Error] Attempt ${attempt + 1}/${maxRetries}:`, JSON.stringify(errorDetails, null, 2));
      
      // 如果是最后一次尝试,直接抛出错误
      if (attempt === maxRetries - 1) {
        // Observability Exit (Failure)
        auditLog?.('LLMExtract', contentJson.length, 0, axiosError.message, true, Date.now());
        
        if (config.onSoftFail === 'skip') return '';
        
        throw new Error(`LLM API调用失败(已重试${maxRetries}次): ${axiosError.message} (status: ${errorDetails.status || 'N/A'})`);
      }
      
      // 指数退避: 2^attempt 秒 (1s, 2s, 4s, 8s, 16s)
      const backoffDelay = Math.pow(2, attempt) * 1000;
      console.log(`[LLM API Retry] Waiting ${backoffDelay}ms before retry ${attempt + 2}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
  
  // Observability Exit (Failure - Unreachable)
  auditLog?.('LLMExtract', contentJson.length, 0, lastError?.message || 'Unknown', true, Date.now());
  
  // 理论上不会走到这里,但为了TypeScript类型安全
  throw lastError || new Error('LLM API调用失败(未知错误)');
}

/**
 * 动态计算max_tokens
 * 根据输入内容长度估算所需的输出token数
 */
function calculateMaxTokens(contentJson: string): number {
  const inputLen = contentJson.length;
  // 估算输入token (1 char ~ 0.3 tokens)
  const inputTokens = Math.ceil(inputLen * 0.3);
  
  // 目标输出token: 输入的80% + 基础buffer
  let targetOutputTokens = Math.max(4096, Math.ceil(inputTokens * 0.8));
  
  // 限制最大值 (假设模型支持32k context, 这里保守设置)
  // 如果是128k模型可以更高
  return Math.min(32768, targetOutputTokens);
}

/**
 * 带重试的LLM API调用(对齐DataFlow APILLMServing_request._api_chat_id_retry)
 * @param config LLM配置
 * @param contentJson 要分析的JSON内容
 * @param systemPrompt 系统提示词
 * @param maxTokens 最大token数 (如果未提供，将自动计算)
 * @returns LLM输出的文本
 */
export async function callLLMForTextExtraction(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string = QA_EXTRACT_PROMPT,
  maxTokens: number = 0,  // 0表示自动计算
  auditLog?: AuditLogFn
): Promise<string> {
  // P1修复: 动态计算max_tokens
  const effectiveMaxTokens = maxTokens > 0 ? maxTokens : calculateMaxTokens(contentJson);
  
  // 第一次尝试
  let output = await callLLMWithApiRetries(config, contentJson, systemPrompt, effectiveMaxTokens, auditLog);
  
  // P0修复: 二次提示机制
  // 如果返回空结果，进行二次提示
  if (output.includes('<empty></empty>') || output.includes('<empty/>')) {
    console.log('[LLM Retry] First attempt returned empty, retrying with enhanced prompt...');
    
    // 使用更详细的提示词
    const enhancedPrompt = systemPrompt + `\n\n## IMPORTANT: This is a retry attempt. The previous attempt returned empty. Please carefully check if there are any math problems, examples (marked as "例①", "例1"), or exercises in the content. Even if the problems are incomplete or unclear, please try to extract them.`;
    
    output = await callLLMWithApiRetries(config, contentJson, enhancedPrompt, effectiveMaxTokens, auditLog);
  }
  
  return output;
}

/**
 * 调用VLM API进行图片分析(备用方案)
 */
export async function callVLMForImageExtraction(
  config: LLMConfig,
  images: { url: string; label: string }[],
  systemPrompt: string = VQA_EXTRACT_PROMPT
): Promise<string> {
  const content: any[] = [
    { type: "text", text: systemPrompt }
  ];

  for (const img of images) {
    content.push({ type: "text", text: `${img.label}:` });
    
    try {
      // 获取图片并转为base64
      const response = await axios.get(img.url, { 
        responseType: 'arraybuffer',
        timeout: 30000
      });
      const buffer = Buffer.from(response.data);
      const base64 = buffer.toString('base64');
      const contentType = response.headers['content-type'] || 'image/jpeg';
      const mimeType = contentType.split(';')[0].trim();

      content.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${base64}`
        }
      });
    } catch (error) {
      console.error(`Failed to process image ${img.label}:`, error);
      content.push({ type: "text", text: `[Image ${img.label} unavailable]` });
    }
  }

  const baseUrl = config.apiUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: config.modelName,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 8192
    },
    {
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: config.timeout * 1000
    }
  );

  return response.data.choices[0].message.content;
}

// ============= 结果生成 =============

/**
 * 生成JSON和Markdown格式的结果
 */
/**
 * P0修复: 判断是否为噪声条目(出版信息、目录、定义等)
 */
export function isNoiseEntry(qa: MergedQAPair): boolean {
  const q = qa.question.trim();
  
  // Use Strategy Pattern
  // Check publication info
  let result = noiseFilter.execute("publication_info_filter", { text: q });
  if (result.action === 'drop') return true;
  
  // Check TOC
  result = noiseFilter.execute("toc_filter", { text: q });
  if (result.action === 'drop') return true;
  
  // Check fragments
  result = noiseFilter.execute("fragment_filter", { 
    text: q, 
    metadata: { chapter_title: qa.question_chapter_title } 
  });
  if (result.action === 'drop') return true;
  
  return false;
}

export function generateResults(
  qaPairs: MergedQAPair[],
  imageBaseUrl: string = "images"
): { json: any[]; markdown: string } {
  // P0修复: 在最终输出阶段统一过滤噪声
  const filteredPairs = qaPairs.filter(qa => !isNoiseEntry(qa));
  
  const jsonOutput: any[] = [];
  let markdownOutput = `# 提取的数学题目\n\n`;
  markdownOutput += `共提取 ${filteredPairs.length} 道题目\n\n---\n\n`;

  // 按章节和题号排序
  const sortedPairs = [...filteredPairs].sort((a, b) => {
    if (a.question_chapter_title !== b.question_chapter_title) {
      return a.question_chapter_title.localeCompare(b.question_chapter_title);
    }
    return a.label - b.label;
  });

  for (const qa of sortedPairs) {
    // JSON格式
    jsonOutput.push({
      label: qa.label,
      chapter_title: qa.question_chapter_title,
      question: qa.question,
      answer: qa.answer,
      solution: qa.solution,
      images: qa.images.map(img => {
        const imgName = img.split('/').pop() || img;
        return `${imageBaseUrl}/${imgName}`;
      })
    });

    // Markdown格式
    markdownOutput += `## ${qa.question_chapter_title ? `${qa.question_chapter_title} - ` : ''}题目 ${qa.label}\n\n`;
    markdownOutput += `${qa.question}\n\n`;
    
    if (qa.answer) {
      markdownOutput += `**答案:** ${qa.answer}\n\n`;
    }
    
    if (qa.solution) {
      markdownOutput += `**解答:**\n\n${qa.solution}\n\n`;
    }
    
    if (qa.images.length > 0) {
      markdownOutput += `**相关图片:**\n`;
      for (const img of qa.images) {
        const imgName = img.split('/').pop() || img;
        markdownOutput += `![](${imageBaseUrl}/${imgName})\n`;
      }
      markdownOutput += '\n';
    }
    
    markdownOutput += `---\n\n`;
  }

  return { json: jsonOutput, markdown: markdownOutput };
}

// ============= 任务状态管理 =============

const runningTasks = new Map<number, { paused: boolean; cancelled: boolean }>();

export function pauseTask(taskId: number): boolean {
  const task = runningTasks.get(taskId);
  if (task) {
    task.paused = true;
    return true;
  }
  return false;
}

export function isTaskPaused(taskId: number): boolean {
  return runningTasks.get(taskId)?.paused || false;
}

export function isTaskCancelled(taskId: number): boolean {
  return runningTasks.get(taskId)?.cancelled || false;
}

export function resumeTask(taskId: number): void {
  const task = runningTasks.get(taskId);
  if (task) {
    task.paused = false;
  }
}

export function cancelTask(taskId: number): void {
  const task = runningTasks.get(taskId);
  if (task) {
    task.cancelled = true;
  }
}

export function registerTask(taskId: number): void {
  runningTasks.set(taskId, { paused: false, cancelled: false });
}

export function unregisterTask(taskId: number): void {
  runningTasks.delete(taskId);
}

export function shouldStopTask(taskId: number): boolean {
  const task = runningTasks.get(taskId);
  return task?.paused || task?.cancelled || false;
}

// ============= Fallback拆分器 =============

/**
 * 简易后处理拆分器: 当LLM返回空结果时,尝试从文本中直接提取题目
 * 这是一个兆底方案,用于实现基本的题目提取
 */
export function splitMultiQuestionFallback(
  blocks: ConvertedBlock[],
  chunkIndex: number = 0
): ExtractedQAPair[] {
  const results: ExtractedQAPair[] = [];
  
  // 题号模式: 圆圈数字, 数字+点/顿号, 中文数字+点/顿号
  const questionPatterns = [
    /^([①-⑳])\s*([\s\S]+)/,  // 圆圈数字 ①-⑳
    /^(\d+)[\.\u3001]\s*([\s\S]+)/,   // 数字+点/顿号
    /^([一二三四五六七八九十]+)[\.\u3001、]\s*([\s\S]+)/,  // 中文数字+点/顿号/、
  ];
  
  // 章节标题模式
  const chapterPattern = /^第(\d+)章|^第(\d+)节|^(\d+\.\d+)\s/;
  
  // 目录/导读类内容特征(需要过滤)
  const tocPatterns = [
    /本期导读/,
    /本学期将学习/,
    /习题\d+\.\d+\s+\d+$/,  // "习题20.2 44" 这样的目录条目
    /复习\(\d+\)\s+\d+$/,    // "复习(1) 46" 这样的目录条目
    /名校考题精选/,
    /各区考题精选/,
    /挑战压轴题/,
  ];
  
  let currentChapter = '';
  let currentQuestion: { label: string; text: string; ids: number[]; chapter: string } | null = null;
  
  for (const block of blocks) {
    if (!block.text) continue;
    
    const text = block.text.trim();
    
    // 检查是否是章节标题
    const chapterMatch = text.match(chapterPattern);
    if (chapterMatch) {
      currentChapter = text.split('\n')[0].trim();  // 取第一行作为章节标题
      if (currentChapter.length > 30) {
        currentChapter = currentChapter.substring(0, 30);
      }
    }
    
    // 检查是否是目录/导读类内容(跳过)
    let isToc = false;
    for (const tocPattern of tocPatterns) {
      if (tocPattern.test(text)) {
        isToc = true;
        break;
      }
    }
    if (isToc) continue;
    
    // P0修复: 检查是否是选择题选项(A/B/C/D),避免误判为新题目
    // 选项模式: "(A) 内容" 或 "A. 内容" 或 "A) 内容"
    const isOption = /^[\(\uff08]?[A-D][\)\uff09\.]\s/.test(text);
    if (isOption && currentQuestion) {
      // 这是选项,追加到当前题目
      currentQuestion.text += '\n' + text;
      currentQuestion.ids.push(block.id);
      continue;
    }
    
    let matched = false;
    
    for (const pattern of questionPatterns) {
      const match = text.match(pattern);
      if (match) {
        // 保存上一个题目
        if (currentQuestion && currentQuestion.text.length > 10) {
          // 过滤掉目录类内容(包含多个页码的条目)
          const pageNumberCount = (currentQuestion.text.match(/\s\d{2,3}$/gm) || []).length;
          if (pageNumberCount < 3) {  // 如果包含3个以上页码,可能是目录
            results.push({
              label: currentQuestion.label,
              question: currentQuestion.text,
              answer: '',
              solution: '',
              chapter_title: currentQuestion.chapter || '',
              images: [],
              questionIds: currentQuestion.ids.join(','),
              chunkIndex
            });
          }
        }
        
        // 开始新题目
        const labelRaw = match[1];
        const labelNum = convertCircledNumbers(labelRaw);
        currentQuestion = {
          label: labelNum,
          text: match[2] || '',
          ids: [block.id],
          chapter: currentChapter
        };
        matched = true;
        break;
      }
    }
    
    // 如果没有匹配到新题号,追加到当前题目
    if (!matched && currentQuestion) {
      currentQuestion.text += '\n' + text;
      currentQuestion.ids.push(block.id);
    }
  }
  
  // 保存最后一个题目
  if (currentQuestion && currentQuestion.text.length > 10) {
    // 过滤掉目录类内容
    const pageNumberCount = (currentQuestion.text.match(/\s\d{2,3}$/gm) || []).length;
    if (pageNumberCount < 3) {
      results.push({
        label: currentQuestion.label,
        question: currentQuestion.text,
        answer: '',
        solution: '',
        chapter_title: currentQuestion.chapter || '',
        images: [],
        questionIds: currentQuestion.ids.join(','),
        chunkIndex
      });
    }
  }
  
  return results;
}
