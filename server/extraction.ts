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

// ============= 类型定义 =============

export interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  maxWorkers: number;
  timeout: number;
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
}

// 合并后的完整QA对
export interface MergedQAPair {
  label: number;
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
2. Segment the content into multiple <qa_pair>...</qa_pair> blocks, each containing a question and its corresponding answer/solution.
3. If a problem or answer/solution is incomplete (e.g., continues to next chunk), omit it. An answer/solution is complete if either the answer or solution exists.
4. Put image IDs into proper positions based on context or captions.
5. Extract chapter titles and each problem's label/number from the text.
6. Only output "id" fields for chapter titles, questions, and solutions. DO NOT OUTPUT ORIGINAL TEXT. Use ',' to separate different IDs.
7. However, use original labels/numbers for labels, and extract original text for short answers.

## CRITICAL: Consecutive ID Handling
- When a question or solution spans multiple consecutive blocks, you MUST include ALL consecutive IDs.
- For example, if a math problem consists of blocks 10, 11, 12, 13, output "10,11,12,13" - DO NOT skip any IDs.
- Pay special attention to equation blocks (type='equation') - they are often part of the surrounding text.
- If blocks 10, 11(equation), 12 form a complete sentence, output "10,11,12" not "10,12".

## Strict Extraction Rules:

### About Questions and Answers/Solutions:
- Preserve each problem's original label/number (e.g., "例1", "Example 3", "习题1", "11"). Do not include periods after numbers.
- Use Arabic numerals only. Convert "例一" to "例1", "IV" to "4".
- If the full label is "三、16", keep only "16". If "5.4", keep only "4".
- If there are multiple sub-questions (like "(1)", "(a)") under one main question, put them together in the same <qa_pair> block.
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

## Example:
<chapter><title>7</title>
<qa_pair><label>1</label><question>2,3,4,5</question>
<answer>Yes</answer><solution>8,9,10,11,12</solution></qa_pair>
<qa_pair><label>2</label><question>13,14,15,16</question>
<answer>3.14</answer><solution></solution></qa_pair>
</chapter>
<chapter><title>20</title>
<qa_pair><label>1</label><question></question>
<answer>2^6</answer><solution>25,26,27</solution></qa_pair>
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
 * 解析MinerU的content_list.json并转换为带ID的格式
 * 参考DataFlow的MinerU2LLMInputOperator实现
 */
export function convertMinerUContentList(contentList: any[]): ConvertedBlock[] {
  const convertedBlocks: ConvertedBlock[] = [];
  let currentId = 0;

  for (const item of contentList) {
    // 处理列表类型 - 展平为多个文本块 (关键: 对选项A,B,C,D很重要)
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
 */
export function idsToText(
  idString: string, 
  blocks: ConvertedBlock[], 
  imagePrefix: string = "images"
): string {
  if (!idString || idString.trim() === '') return '';
  
  const texts: string[] = [];
  const idList = idString.replace(/\s/g, '').split(',');

  for (const idStr of idList) {
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 0 || id >= blocks.length) continue;

    const block = blocks[id];
    if (!block) continue;

    if (block.text) {
      texts.push(block.text);
    } else if (block.img_path) {
      const imgName = block.img_path.split('/').pop() || block.img_path;
      const caption = block.image_caption || 'image';
      texts.push(`![${caption}](${imagePrefix}/${imgName})`);
    }
  }

  return texts.join('\n');
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
 * 解析LLM的XML格式输出
 * 参考DataFlow的LLMOutputParser实现
 */
export function parseLLMOutput(
  output: string, 
  blocks: ConvertedBlock[],
  imagePrefix: string = "images",
  mode: 'question' | 'answer' = 'question'
): ExtractedQAPair[] {
  const qaPairs: ExtractedQAPair[] = [];

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
    }

    // 提取所有qa_pair块
    const pairMatches = chapterBlock.match(/<qa_pair>([\s\S]*?)<\/qa_pair>/g) || [];

    for (const pairBlock of pairMatches) {
      // 提取label
      const labelMatch = pairBlock.match(/<label>(.*?)<\/label>/);
      if (!labelMatch) continue;
      const label = labelMatch[1].trim();

      // 提取question (ID列表)
      const questionMatch = pairBlock.match(/<question>(.*?)<\/question>/);
      const questionIds = questionMatch ? questionMatch[1].trim() : '';
      const questionText = idsToText(questionIds, blocks, imagePrefix);
      const questionImages = extractImagesFromIds(questionIds, blocks);

      // 提取answer (直接文本,不是ID)
      const answerMatch = pairBlock.match(/<answer>(.*?)<\/answer>/);
      const answer = answerMatch ? answerMatch[1].trim() : '';

      // 提取solution (ID列表)
      const solutionMatch = pairBlock.match(/<solution>(.*?)<\/solution>/);
      const solutionIds = solutionMatch ? solutionMatch[1].trim() : '';
      const solutionText = idsToText(solutionIds, blocks, imagePrefix);
      const solutionImages = extractImagesFromIds(solutionIds, blocks);

      // 合并图片
      const allImages = Array.from(new Set([...questionImages, ...solutionImages]));

      qaPairs.push({
        label,
        question: questionText,
        answer,
        solution: solutionText,
        chapter_title: chapterTitle,
        images: allImages,
        // 保存原始ID用于去重
        questionIds,
        solutionIds
      });
    }
  }

  return qaPairs;
}

// ============= 章节标题规范化 =============

/**
 * 规范化章节标题用于匹配
 * 参考DataFlow的refine_title实现
 */
export function normalizeTitle(title: string, strictMatch: boolean = false): string {
  // 删除空格和换行
  let normalized = title.replace(/\s+/g, '');

  if (!strictMatch) {
    // 优先提取阿拉伯数字章节编号 (如 1.1, 2)
    const arabicMatch = normalized.match(/\d+\.\d+|\d+/);
    if (arabicMatch) {
      return arabicMatch[0];
    }

    // 其次提取中文数字章节编号 (如 六、二十四)
    const chineseMatch = normalized.match(/[一二三四五六七八九零十百]+/);
    if (chineseMatch) {
      return chineseMatch[0];
    }
  }

  return normalized;
}

/**
 * 规范化题号
 */
export function normalizeLabel(label: string): number | null {
  // 提取数字部分
  const match = label.match(/\d+/);
  if (match) {
    return parseInt(match[0], 10);
  }
  return null;
}

// ============= 问答合并 =============

/**
 * 合并问题和答案列表
 * 参考DataFlow的merge_qa_pair实现
 * 
 * 关键特性:
 * 1. 支持跨Chunk的问答匹配(题目在第1页,答案在第50页)
 * 2. 基于chapter_title+label的Map去重,天然支持Overlap后的去重
 * 3. 已完整的题目(有question和answer/solution)直接输出
 */
export function mergeQAPairs(
  questions: ExtractedQAPair[],
  answers: ExtractedQAPair[],
  strictTitleMatch: boolean = false
): MergedQAPair[] {
  const merged: MergedQAPair[] = [];
  const questionMap = new Map<string, ExtractedQAPair>();
  const answerMap = new Map<string, ExtractedQAPair>();

  let currentQuestionChapter = '';
  let currentAnswerChapter = '';
  let lastQuestionLabel = Infinity;
  let lastAnswerLabel = Infinity;

  // 处理问题列表
  for (const q of questions) {
    const labelNum = normalizeLabel(q.label);
    if (labelNum === null || labelNum <= 0) continue;

    // 更新章节标题 - 如果题号变小,说明进入新章节
    if (q.chapter_title && q.chapter_title !== currentQuestionChapter) {
      if (labelNum < lastQuestionLabel) {
        currentQuestionChapter = q.chapter_title;
      }
      // 如果题号增加但章节标题变化,可能是错误提取了子标题,继续使用之前的章节
    }
    lastQuestionLabel = labelNum;

    const normalizedTitle = normalizeTitle(q.chapter_title || currentQuestionChapter, strictTitleMatch);
    const key = `${normalizedTitle}:${labelNum}`;

    // 如果问题已经有答案,直接输出(已完整的题目)
    if (q.answer || q.solution) {
      merged.push({
        label: labelNum,
        question_chapter_title: normalizedTitle,
        answer_chapter_title: normalizedTitle,
        question: q.question,
        answer: q.answer,
        solution: q.solution,
        images: q.images
      });
    } else {
      // 未完整的题目,加入待匹配Map
      // 如果已存在,不覆盖(保留第一个,因为Overlap可能导致重复)
      if (!questionMap.has(key)) {
        questionMap.set(key, { ...q, chapter_title: normalizedTitle });
      }
    }
  }

  // 处理答案列表
  for (const a of answers) {
    const labelNum = normalizeLabel(a.label);
    if (labelNum === null || labelNum <= 0) continue;

    // 更新章节标题
    if (a.chapter_title && a.chapter_title !== currentAnswerChapter) {
      if (labelNum < lastAnswerLabel) {
        currentAnswerChapter = a.chapter_title;
      }
    }
    lastAnswerLabel = labelNum;

    const normalizedTitle = normalizeTitle(a.chapter_title || currentAnswerChapter, strictTitleMatch);
    const key = `${normalizedTitle}:${labelNum}`;

    // 动态更新,防止错误的重复label覆盖掉之前的solution或answer
    const existing = answerMap.get(key);
    if (!existing) {
      answerMap.set(key, { ...a, chapter_title: normalizedTitle });
    } else {
      // 补充缺失的字段
      if (!existing.solution && a.solution) {
        existing.solution = a.solution;
      }
      if (!existing.answer && a.answer) {
        existing.answer = a.answer;
      }
    }
  }

  // 匹配问题和答案
  for (const [key, question] of Array.from(questionMap.entries())) {
    const answer = answerMap.get(key);
    if (answer) {
      const labelNum = normalizeLabel(question.label);
      if (labelNum === null) continue;

      merged.push({
        label: labelNum,
        question_chapter_title: question.chapter_title,
        answer_chapter_title: answer.chapter_title,
        question: question.question,
        answer: answer.answer,
        solution: answer.solution,
        images: Array.from(new Set([...question.images, ...answer.images]))
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

// ============= LLM API调用 =============

/**
 * 调用LLM API进行文本分析
 */
export async function callLLMForTextExtraction(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string = QA_EXTRACT_PROMPT
): Promise<string> {
  const baseUrl = config.apiUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: config.modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentJson }
      ],
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
export function generateResults(
  qaPairs: MergedQAPair[],
  imageBaseUrl: string = "images"
): { json: any[]; markdown: string } {
  const jsonOutput: any[] = [];
  let markdownOutput = `# 提取的数学题目\n\n`;
  markdownOutput += `共提取 ${qaPairs.length} 道题目\n\n---\n\n`;

  // 按章节和题号排序
  const sortedPairs = [...qaPairs].sort((a, b) => {
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
