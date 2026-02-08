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
  if (!solution || !solution.trim()) return false;
  // DataFlow官方的过滤规则
  if (solution.includes('Law:')) return false;
  // 扩展: 过滤其他明显无效的标记
  if (solution.includes('Error:')) return false;
  if (solution.includes('Invalid:')) return false;
  return true;
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
  
  // 单层索引：chapterId:chapter:label -> ExtractedQAPair
  // 使用这个Map来存储所有的题目，并在后续进行字段合并
  const qaMap = new Map<string, ExtractedQAPair>();
  
  // 章节边界检测
  let currentQuestionChapter = '';
  let lastQuestionLabel = Infinity;
  let questionChapterId = 0;
  
  // 处理问题列表
  for (const q of questions) {
    const labelNum = normalizeLabel(q.label);
    if (labelNum === null || labelNum <= 0) continue;
    
    // 章节边界检测
    if (q.chapter_title && q.chapter_title !== '' && q.chapter_title !== currentQuestionChapter) {
      if (labelNum < lastQuestionLabel) {
        questionChapterId++;
        currentQuestionChapter = q.chapter_title;
      } else {
        q.chapter_title = currentQuestionChapter;
      }
    }
    lastQuestionLabel = labelNum;
    
    // 规范化章节标题
    const normalizedChapter = normalizeTitle(q.chapter_title || currentQuestionChapter, strictTitleMatch);
    const labelKey = getLabelKey(q.label);
    const key = `${questionChapterId}:${normalizedChapter}:${labelKey}`;
    
    // 已完整的题目直接输出 (Interleaved模式)
    if (q.question && (q.answer || q.solution)) {
      merged.push({
        label: labelNum,
        question_chapter_title: normalizedChapter,
        answer_chapter_title: normalizedChapter,
        question: q.question,
        answer: q.answer,
        solution: q.solution,
        images: q.images
      });
    } else {
      // 未完整的题目缓存
      // 如果key已存在，说明有重复提取，保留先前的还是覆盖？
      // DataFlow逻辑中，如果是同一个位置的提取，通常不会有冲突。
      // 这里我们简单覆盖，因为我们假设输入是顺序的。
      qaMap.set(key, { ...q, chapter_title: normalizedChapter });
    }
  }
  
  // 处理答案列表
  let currentAnswerChapter = '';
  let lastAnswerLabel = Infinity;
  let answerChapterId = 0;
  
  // 临时存储答案，以便后续合并
  const answerMap = new Map<string, ExtractedQAPair>();
  
  for (const a of answers) {
    const labelNum = normalizeLabel(a.label);
    if (labelNum === null || labelNum <= 0) continue;
    
    if (a.chapter_title && a.chapter_title !== '' && a.chapter_title !== currentAnswerChapter) {
      if (labelNum < lastAnswerLabel) {
        answerChapterId++;
        currentAnswerChapter = a.chapter_title;
      } else {
        a.chapter_title = currentAnswerChapter;
      }
    }
    lastAnswerLabel = labelNum;
    
    const normalizedChapter = normalizeTitle(a.chapter_title || currentAnswerChapter, strictTitleMatch);
    const labelKey = getLabelKey(a.label);
    const key = `${answerChapterId}:${normalizedChapter}:${labelKey}`;
    
    // 字段级别的增量更新
    if (!answerMap.has(key)) {
      answerMap.set(key, { ...a, chapter_title: normalizedChapter });
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
    // 这里可以添加模糊匹配逻辑，但为了严格对齐DataFlow，主要依赖精确匹配。
    // DataFlow其实主要依赖 (chapter, label) 唯一键。
    
    const finalSolution = (answerPair && answerPair.solution && isValidSolution(answerPair.solution)) ? answerPair.solution : (q.solution && isValidSolution(q.solution) ? q.solution : '');
    const finalAnswer = (answerPair && answerPair.answer) ? answerPair.answer : q.answer;
    
    const combinedImages = Array.from(new Set([...q.images, ...(answerPair ? answerPair.images : [])]));

    merged.push({
      label: labelNum,
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
              label: labelNum,
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