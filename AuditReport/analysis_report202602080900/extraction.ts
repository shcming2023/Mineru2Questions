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
 * 带重试的LLM API调用(对齐DataFlow APILLMServing_request._api_chat_id_retry)
 * @param config LLM配置
 * @param contentJson 要分析的JSON内容
 * @param systemPrompt 系统提示词
 * @param maxTokens 最大token数
 * @returns LLM输出的文本
 */
export async function callLLMForTextExtraction(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string = QA_EXTRACT_PROMPT,
  maxTokens: number = 16384  // 提高默认值,避免大量题目时输出被截断
): Promise<string> {
  const baseUrl = config.apiUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  
  // 对齐DataFlow: max_retries=5, 指数退避 1s, 2s, 4s, 8s, 16s
  const maxRetries = 5;
  let lastError: Error | null = null;
  
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
        throw new Error(`LLM API调用失败(已重试${maxRetries}次): ${axiosError.message} (status: ${errorDetails.status || 'N/A'})`);
      }
      
      // 指数退避: 2^attempt 秒 (1s, 2s, 4s, 8s, 16s)
      const backoffDelay = Math.pow(2, attempt) * 1000;
      console.log(`[LLM API Retry] Waiting ${backoffDelay}ms before retry ${attempt + 2}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
  
  // 理论上不会走到这里,但为了TypeScript类型安全
  throw lastError || new Error('LLM API调用失败(未知错误)');
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
function isNoiseEntry(qa: MergedQAPair): boolean {
  const q = qa.question.trim();
  
  // 出版信息特征
  if (/ISBN\s*\d/.test(q)) return true;
  if (/CIP数据/.test(q)) return true;
  if (/出版说明/.test(q)) return true;
  if (/责任编辑/.test(q)) return true;
  
  // 目录特征
  if (q.startsWith('目录')) return true;
  if (/^第\d+章/.test(q) && q.length < 50) return true; // 简短的章节标题
  
  // chapter_title为空且题目很短(可能是碎片)
  if (!qa.question_chapter_title && q.length < 20) return true;
  
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
