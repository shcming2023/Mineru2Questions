# Mineru2Questions 项目技术审查报告

## 执行摘要

本报告基于 OpenDCAI/DataFlow 官方仓库的 PDF_VQA_extract_optimized_pipeline 作为唯一事实标准（Source of Truth），对 Mineru2Questions 项目的当前实现进行逐算子级别的对齐审查。审查发现该项目在整体架构上遵循了官方流水线的核心思想（基于 ID 的逻辑组装方案），但在多个关键环节存在偏离、容错缺失和过严约束，导致抽取覆盖率和稳定性不足。

**测试任务概况**：
- 测试文件：八上数学测试.pdf
- 提取结果：225 道题目
- 章节分布：11 个章节（19.1, 20.1, 20.2, 21.1-21.5, 22.1-22.3）
- label 重复情况：存在大量 label=1 的题目（21 个），说明跨章节题号重置正常

**核心发现**：
1. ✅ **已对齐**：基于 ID 的抽取方案、LLM 只输出 ID、ID 回填原文
2. ⚠️ **部分偏离**：章节边界检测逻辑、题号规范化、合并策略
3. ❌ **缺失容错**：无二次提示、无冲突解决策略、无质量评估回退
4. ❌ **过严规则**：目录过滤、章节标题清洗、题号拆分逻辑

---

## 一、算子阶段对齐分析

### 阶段 1: 输入格式化与标准化

**官方实现（DataFlow）**：
- **算子**：`MinerU2LLMInputOperator`
- **职责**：
  1. 读取 MinerU 的 `content_list.json`
  2. 展平 list 类型的 list_items（每个 item 独立成一个 block）
  3. 重新分配连续 ID（从 0 开始）
  4. 移除 bbox 和 page_idx（减少 token 消耗）
- **输入**：`{markdown_path}_content_list.json`
- **输出**：`{markdown_path}_content_list_converted.json`

**当前实现（Mineru2Questions）**：
- **文件**：`extraction.ts::convertContentList()`
- **实现对齐度**：✅ **高度对齐**
  ```typescript
  export function convertContentList(blocks: ContentBlock[]): ConvertedBlock[] {
    const converted: ConvertedBlock[] = [];
    let id = 0;
    
    for (const block of blocks) {
      // 跳过目录列表
      if (block.type === 'list' && isTocList(block.list_items || [])) {
        continue;
      }
      
      // 展平list类型
      if (block.type === 'list' && block.sub_type === 'text') {
        for (const item of block.list_items || []) {
          converted.push({ id: id++, type: 'text', text: item });
        }
      } else {
        // 保留其他类型
        converted.push({
          id: id++,
          type: block.type,
          text: block.text,
          img_path: block.img_path,
          image_caption: block.image_caption?.join(' ')
        });
      }
    }
    return converted;
  }
  ```

**偏离点与风险**：
1. ⚠️ **过严规则**：增加了 `isTocList()` 目录检测，直接跳过目录列表
   - **风险**：误判选项列表（A. B. C. D.）为目录，导致选择题选项丢失
   - **官方做法**：不在输入阶段过滤，而是在 LLM 输出解析阶段通过提示词和后处理过滤
   - **建议**：移除此过滤逻辑，或改为更保守的启发式规则（如检查是否所有 item 都以页码数字结尾）

2. ⚠️ **缺失字段**：移除了 `page_idx` 和 `bbox`
   - **对齐官方**：✅ 官方也移除了这些字段
   - **潜在问题**：无法用于跨页题目的边界判断（但官方也未使用，可接受）

**诊断建议**：
- 保留所有 `isTocList()` 过滤的 block ID，记录到日志中
- 统计被过滤的 list 数量和内容样本，验证是否存在误判
- 对比官方：官方不在此阶段过滤，而是依赖 LLM 提示词和后处理

---

### 阶段 2: ID 列表构建与候选区域筛选

**官方实现（DataFlow）**：
- **算子**：无独立算子，由 `ChunkedPromptedGenerator` 内部处理
- **职责**：
  1. 将 converted JSON 分块（chunk），避免超过 LLM context 长度
  2. 每个 chunk 保持 ID 连续性
  3. 无额外的候选区域筛选（全部交给 LLM）

**当前实现（Mineru2Questions）**：
- **文件**：`extraction.ts::chunkContentBlocks()`
- **实现对齐度**：✅ **对齐 + 优化**
  ```typescript
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
        const overlapStart = Math.max(0, currentChunk.length - overlapBlocks);
        currentChunk = currentChunk.slice(overlapStart);
        currentLen = currentChunk.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
      }
      
      currentChunk.push(block);
      currentLen += blockLen;
    }
    
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }
  ```

**优化点**：
- ✅ **Overlap 窗口**：增加了 15 个 block 的重叠窗口，避免题目在 chunk 边界被切断
- ✅ **对齐官方**：官方的 `ChunkedPromptedGenerator` 也使用类似的 chunking 策略

**潜在问题**：
- ⚠️ **Overlap 去重**：重叠窗口可能导致同一题目被多次提取
  - **当前处理**：在后续的 `parseLLMOutput()` 中通过 `questionIds` 去重
  - **风险**：如果 LLM 在不同 chunk 中对同一题目输出不同的 ID 列表，去重可能失效
  - **建议**：在合并阶段增加基于文本相似度的去重（如 Levenshtein 距离）

**诊断建议**：
- 记录每个 chunk 的起始和结束 ID，以及 overlap 区域的 ID 范围
- 统计重叠区域的题目数量，验证去重是否有效
- 对比官方：官方的 overlap 策略和去重逻辑

---

### 阶段 3: 基于上下文的 LLM 抽取

**官方实现（DataFlow）**：
- **算子**：`ChunkedPromptedGenerator`
- **职责**：
  1. 使用 `QAExtractPrompt` 提示词
  2. 调用 LLM API（支持重试和指数退避）
  3. 返回 LLM 的原始输出（XML 格式）
- **提示词关键点**（`QAExtractPrompt`）：
  - 只输出 ID，不输出原文
  - 使用 `,` 分隔 ID
  - 使用 XML 标签结构化输出：`<chapter><title>ID</title><qa_pair><label>TEXT</label><question>IDs</question><answer>TEXT</answer><solution>IDs</solution></qa_pair></chapter>`
  - 强调连续 ID 的重要性（不要跳过中间的 ID）

**当前实现（Mineru2Questions）**：
- **文件**：`extraction.ts::QA_EXTRACT_PROMPT` 和 `callLLMForTextExtraction()`
- **实现对齐度**：✅ **高度对齐 + 增强**

**提示词对比**：

| 维度 | 官方 DataFlow | 当前 Mineru2Questions | 对齐度 |
|------|---------------|----------------------|--------|
| 只输出 ID | ✅ | ✅ | ✅ 对齐 |
| XML 标签结构 | ✅ | ✅ | ✅ 对齐 |
| 连续 ID 强调 | ❌ 未明确 | ✅ 增加了"CRITICAL: Consecutive ID Handling"章节 | ✅ 优化 |
| 圆圈数字处理 | ❌ 未提及 | ✅ 增加了"①②③ are INDEPENDENT questions"说明 | ✅ 优化 |
| 定义文本过滤 | ❌ 未提及 | ✅ 增加了"DISTINGUISH DEFINITIONS FROM PROBLEMS"说明 | ✅ 优化 |
| Interleaved 模式 | ✅ 通过参数控制 | ✅ 内置在提示词中 | ✅ 对齐 |

**LLM 调用对比**：

| 维度 | 官方 DataFlow | 当前 Mineru2Questions | 对齐度 |
|------|---------------|----------------------|--------|
| 重试次数 | 5 次 | 5 次 | ✅ 对齐 |
| 指数退避 | 1s, 2s, 4s, 8s, 16s | 1s, 2s, 4s, 8s, 16s | ✅ 对齐 |
| 超时时间 | 120s | 120s（强制最低） | ✅ 对齐 |
| max_tokens | 未明确 | 16384 | ⚠️ 需验证 |

**偏离点与风险**：
1. ⚠️ **max_tokens 设置**：当前设置为 16384
   - **风险**：如果一个 chunk 包含大量题目，LLM 输出可能被截断
   - **官方做法**：未在代码中明确设置，可能使用模型默认值
   - **建议**：根据 chunk 大小动态调整 max_tokens，或监控是否存在输出截断

2. ✅ **提示词增强**：当前提示词在官方基础上增加了多项优化
   - 连续 ID 处理说明
   - 圆圈数字识别规则
   - 定义文本过滤规则
   - **评估**：这些增强符合"可泛化信号"原则，不是硬编码特例

**诊断建议**：
- 保存每个 chunk 的 LLM 原始输出到文件（如 `chunk_0_llm_output.xml`）
- 统计 LLM 返回 `<empty></empty>` 的 chunk 数量和位置
- 检查是否存在输出截断（最后一个 `</chapter>` 标签是否完整）
- 对比官方：官方的 LLM 输出样本和错误模式

---

### 阶段 4: ID 回填原文

**官方实现（DataFlow）**：
- **算子**：`LLMOutputParser`
- **职责**：
  1. 解析 LLM 的 XML 输出
  2. 提取 `<chapter>`, `<qa_pair>`, `<label>`, `<question>`, `<answer>`, `<solution>` 标签
  3. 将 question 和 solution 中的 ID 列表回填为原文（从 converted JSON 中查找）
  4. 处理图片 ID，生成 Markdown 图片链接
  5. 过滤无效条目（label 为空或所有字段都为空）
- **关键逻辑**（`_id_to_text`）：
  ```python
  def _id_to_text(self, input_ids, input_json, image_prefix="images"):
      texts = []
      id_list = input_ids.replace(' ', '').split(',')
      for id in id_list:
          try: 
              int(id)
          except:
              continue
          if int(id) < len(input_json):
              try:
                  item = input_json[int(id)]
              except:
                  continue
              if 'text' in item:
                  texts.append(item['text'])
              elif 'img_path' in item:
                  # 生成 Markdown 图片链接
                  img_path = item.get('img_path', '')
                  img_name = os.path.basename(img_path)
                  new_path = f"{image_prefix}/{img_name}"
                  texts.append(f"![{' '.join(item.get('image_caption','image'))}]({new_path})")
              elif item.get('type','') == 'list':
                  if item['sub_type'] == 'text':
                      try:
                          texts.append(input_json[int(id)]['list_items'].pop(0))
                      except:
                          pass
      return '\n'.join(texts)
  ```

**当前实现（Mineru2Questions）**：
- **文件**：`extraction.ts::idsToText()` 和 `parseLLMOutput()`
- **实现对齐度**：✅ **高度对齐**
  ```typescript
  function idsToText(ids: string, blocks: ConvertedBlock[], imagePrefix: string = "images"): string {
    if (!ids || !ids.trim()) return '';
    
    const texts: string[] = [];
    const idList = ids.replace(/\s/g, '').split(',');
    
    for (const idStr of idList) {
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id < 0 || id >= blocks.length) continue;
      
      const block = blocks[id];
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
  ```

**偏离点与风险**：
1. ⚠️ **list_items 处理缺失**：当前实现未处理 `type='list'` 的情况
   - **官方做法**：使用 `list_items.pop(0)` 逐个消费 list item
   - **当前做法**：在阶段 1 已展平 list，因此不需要此逻辑
   - **评估**：✅ 可接受，因为输入格式化阶段已处理

2. ✅ **图片路径处理**：当前实现正确生成 Markdown 图片链接

3. ✅ **容错处理**：对无效 ID（NaN, 越界）进行了跳过处理

**诊断建议**：
- 记录每个 qa_pair 的 ID 回填日志：`questionIds -> questionText length`
- 统计 ID 回填失败的次数（无效 ID、越界 ID）
- 检查是否存在连续 ID 被跳过的情况（如 "10,11,12,13" 变成 "10,13"）

---

### 阶段 5: 问答对合并与去重

**官方实现（DataFlow）**：
- **算子**：`QA_Merger`
- **职责**：
  1. 读取 question JSONL 和 answer JSONL
  2. 基于 `(chapter_title, label)` 进行匹配
  3. 使用 `refine_title()` 规范化章节标题（只保留数字编号）
  4. 使用 `chapter_id` 递增机制处理章节边界（当 label 回退时递增 chapter_id）
  5. 已完整的题目（有 question 和 answer/solution）直接输出
  6. 未完整的题目缓存到 Map 中，等待匹配
- **关键逻辑**（章节边界检测）：
  ```python
  # format_utils.py::merge_qa_pair L42-L48
  if data["chapter_title"] != "" and data["chapter_title"] != chapter_title:
      if data["label"] < label:
          chapter_id += 1
          chapter_title = data["chapter_title"]
      else:
          # 如果题号增加，章节标题却发生变化，说明可能错误提取了子标题。
          # 因此继续使用之前的章节标题。
          data["chapter_title"] = chapter_title
  ```

**当前实现（Mineru2Questions）**：
- **文件**：`extraction.ts::mergeQAPairs()`
- **实现对齐度**：⚠️ **部分对齐，存在偏离**

**对齐点**：
1. ✅ **章节边界检测**：实现了 `chapter_id` 递增机制
   ```typescript
   if (q.chapter_title && q.chapter_title !== '' && q.chapter_title !== currentQuestionChapter) {
     if (labelNum < lastQuestionLabel) {
       questionChapterId++;
       currentQuestionChapter = q.chapter_title;
     } else {
       q.chapter_title = currentQuestionChapter;
     }
   }
   ```

2. ✅ **章节标题规范化**：实现了 `normalizeTitle()` 函数，逻辑与官方 `refine_title()` 一致

3. ✅ **已完整题目直接输出**：对 interleaved 模式（question 和 solution 在同一 PDF）的题目直接输出

**偏离点与风险**：
1. ❌ **过度复杂的索引结构**：使用了三层索引
   - `questionByIds: Map<string, ExtractedQAPair>` - 基于 questionIds
   - `questionMapExact: Map<string, ExtractedQAPair>` - 基于 `chapterId:chapter:label`
   - `questionMapFuzzy: Map<string, ExtractedQAPair[]>` - 基于 label only
   - **官方做法**：只使用 `(chapter_title, label)` 作为唯一键
   - **风险**：三层索引增加了复杂度，可能导致匹配逻辑不一致
   - **建议**：简化为官方的单层索引 `Map<[chapter_title, label], QAPair>`

2. ⚠️ **questionIds 去重**：使用 questionIds 作为主键去重
   ```typescript
   const idsKey = q.questionIds || '';
   if (idsKey && questionByIds.has(idsKey)) {
     if (shouldReplaceQAPair(questionByIds.get(idsKey)!, q)) {
       questionByIds.set(idsKey, q);
     }
     continue;
   }
   ```
   - **官方做法**：不使用 questionIds 去重，而是依赖 `(chapter_title, label)` 唯一性
   - **风险**：如果 LLM 在不同 chunk 中对同一题目输出不同的 ID 列表，去重失效
   - **建议**：改为基于 `(chapter_title, label)` 去重，与官方对齐

3. ⚠️ **择优保留策略**：实现了 `shouldReplaceQAPair()` 函数
   ```typescript
   function shouldReplaceQAPair(existing: ExtractedQAPair, newData: ExtractedQAPair): boolean {
     const existingScore = 
       (existing.question?.length || 0) + 
       (existing.answer?.length || 0) + 
       (existing.solution?.length || 0);
     
     const newScore = 
       (newData.question?.length || 0) + 
       (newData.answer?.length || 0) + 
       (newData.solution?.length || 0);
     
     return newScore > existingScore;
   }
   ```
   - **官方做法**：不进行择优保留，而是使用"后来者优先"策略（但有字段级别的增量更新）
   - **评估**：✅ 这是一个合理的优化，但需要验证是否会导致错误的覆盖

4. ❌ **缺失字段级别的增量更新**：官方在 answer 阶段有字段级别的增量更新
   ```python
   # format_utils.py L98-L101
   if not answers[(data["chapter_title"], data['label'])].get("solution") and data.get("solution"):
       answers[(data["chapter_title"], data['label'])]["solution"] = data["solution"]
   if not answers[(data["chapter_title"], data['label'])].get("answer") and data.get("answer"):
       answers[(data["chapter_title"], data['label'])]["answer"] = data["answer"]
   ```
   - **当前实现**：没有此逻辑
   - **风险**：如果同一题目在不同 chunk 中被部分提取（一次只有 answer，一次只有 solution），可能丢失数据
   - **建议**：增加字段级别的增量更新逻辑

**诊断建议**：
- 记录每个 chapter_title 的 `chapter_id` 递增日志
- 统计 `questionByIds` 去重的次数和被替换的题目
- 统计 `questionMapExact` 和 `questionMapFuzzy` 的匹配成功率
- 对比官方：官方的合并逻辑和匹配策略

---

### 阶段 6: 质量评估与回退策略

**官方实现（DataFlow）**：
- **算子**：无独立算子，但在 `LLMOutputParser` 中有基本的质量过滤
- **职责**：
  1. 过滤 label 为空的条目
  2. 过滤所有字段都为空的条目
  3. 过滤包含 "Law:" 等无效标记的 solution
- **关键逻辑**：
  ```python
  # llm_output_parser.py L91-L92
  if not ((q_match and label_match) or (a_match and label_match) or (s_match and label_match)):
      continue
  ```

**当前实现（Mineru2Questions）**：
- **文件**：`extraction.ts::parseLLMOutput()` 和 `generateResults()`
- **实现对齐度**：⚠️ **部分对齐，缺失回退策略**

**对齐点**：
1. ✅ **基本质量过滤**：实现了与官方一致的过滤逻辑
   ```typescript
   const hasContent = questionText.trim() || answer.trim() || solutionText.trim();
   if (!hasContent) {
     continue;
   }
   ```

2. ✅ **噪声过滤**：增加了多层噪声过滤
   - 目录条目过滤（正则匹配页码结尾）
   - 出版信息过滤（ISBN, CIP, 责任编辑等）
   - chapter_title 为空的条目过滤

3. ✅ **无效 solution 过滤**：实现了 `isValidSolution()` 函数
   ```typescript
   function isValidSolution(solution: string): boolean {
     if (!solution || !solution.trim()) return false;
     if (solution.includes('Law:')) return false;
     if (solution.includes('Error:')) return false;
     if (solution.includes('Invalid:')) return false;
     return true;
   }
   ```

**缺失功能**：
1. ❌ **无二次提示（Retry with Refinement）**：
   - **官方可能的做法**：如果 LLM 返回 `<empty></empty>` 或质量不佳，使用不同的提示词重试
   - **当前实现**：没有二次提示机制
   - **风险**：对于复杂页面或边界情况，可能直接丢失数据
   - **建议**：增加二次提示机制，使用更详细的提示词或示例

2. ❌ **无冲突解决策略**：
   - **场景**：同一 `(chapter_title, label)` 有多个不同的 question 或 solution
   - **官方可能的做法**：使用置信度、内容长度、来源优先级等进行选择
   - **当前实现**：使用 `shouldReplaceQAPair()` 的简单长度比较
   - **风险**：可能选择错误的版本
   - **建议**：增加更复杂的冲突解决策略（如文本相似度、结构完整性）

3. ❌ **无质量评估指标**：
   - **建议指标**：
     - 每个 chapter 的题目数量分布
     - label 连续性检查（是否有跳号）
     - question/answer/solution 的平均长度
     - 图片引用的完整性
   - **用途**：帮助开发者快速定位问题（如某个 chapter 题目数量异常少）

**诊断建议**：
- 统计每个 chapter 的题目数量，检查是否有异常少的章节
- 统计 label 的连续性，检查是否有大量跳号
- 统计 question/answer/solution 的长度分布，检查是否有异常短的条目
- 对比官方：官方的质量评估和回退策略

---

## 二、根因分析与诊断路径

基于上述算子级别对齐分析，当前实现的主要问题可归纳为以下几类：

### 问题分类

#### P0 - 数据丢失风险（高优先级）

1. **阶段 1 - 输入格式化**：`isTocList()` 过严过滤
   - **症状**：选项列表被误判为目录，导致选择题选项丢失
   - **诊断路径**：
     1. 检查 `isTocList()` 的日志，查看被过滤的 list 内容
     2. 搜索结果中是否存在选择题但缺少选项
     3. 对比官方：官方不在此阶段过滤
   - **根因**：在输入阶段过滤而非在 LLM 输出阶段过滤

2. **阶段 5 - 合并去重**：缺失字段级别的增量更新
   - **症状**：同一题目在不同 chunk 中被部分提取，最终只保留一个版本
   - **诊断路径**：
     1. 检查 `questionByIds` 去重日志，查看被替换的题目
     2. 对比被替换前后的 question/answer/solution 内容
     3. 验证是否存在"一次只有 answer，一次只有 solution"的情况
   - **根因**：缺失官方的字段级别增量更新逻辑

3. **阶段 6 - 质量评估**：无二次提示机制
   - **症状**：LLM 返回 `<empty></empty>` 的 chunk 直接丢弃
   - **诊断路径**：
     1. 统计返回 `<empty></empty>` 的 chunk 数量
     2. 检查这些 chunk 的原始内容是否确实为空
     3. 尝试手动调整提示词或增加示例，验证是否能提取
   - **根因**：缺失二次提示和回退策略

#### P1 - 稳定性风险（中优先级）

1. **阶段 3 - LLM 抽取**：max_tokens 可能不足
   - **症状**：LLM 输出被截断，最后一个 `</chapter>` 标签不完整
   - **诊断路径**：
     1. 检查 LLM 原始输出，查看是否存在截断
     2. 统计每个 chunk 的输出 token 数量
     3. 对比 max_tokens 设置和实际输出长度
   - **根因**：固定的 max_tokens 无法适应不同 chunk 的题目数量

2. **阶段 5 - 合并去重**：三层索引结构复杂
   - **症状**：匹配逻辑不一致，部分题目无法匹配
   - **诊断路径**：
     1. 统计 `questionMapExact` 和 `questionMapFuzzy` 的匹配成功率
     2. 检查未匹配的题目的 chapter_title 和 label
     3. 对比官方的单层索引逻辑
   - **根因**：过度设计，偏离官方简单的 `(chapter_title, label)` 索引

#### P2 - 可观测性不足（低优先级）

1. **所有阶段**：缺少中间产物保存
   - **症状**：无法复现问题，无法定位具体算子的失败原因
   - **诊断路径**：
     1. 增加每个算子的输入输出日志
     2. 保存 LLM 原始输出到文件
     3. 保存每个阶段的中间结果（converted JSON, parsed QA pairs, merged QA pairs）
   - **根因**：缺少可观测性设计

2. **阶段 6 - 质量评估**：缺少质量指标
   - **症状**：无法快速判断抽取质量是否正常
   - **诊断路径**：
     1. 增加每个 chapter 的题目数量统计
     2. 增加 label 连续性检查
     3. 增加 question/answer/solution 长度分布统计
   - **根因**：缺少质量评估指标

---

## 三、优化建议与改进方案

### 建议 1：简化输入过滤逻辑（P0）

**当前问题**：`isTocList()` 在输入阶段过滤，可能误判选项列表

**改进方案**：
1. **移除输入阶段的目录过滤**，改为在 LLM 输出解析阶段过滤
2. **增强提示词**，明确告诉 LLM 不要提取目录条目
3. **后处理过滤**，在 `parseLLMOutput()` 中使用更精确的目录特征过滤

**TypeScript 代码示例**：
```typescript
// 移除 convertContentList() 中的 isTocList() 调用
export function convertContentList(blocks: ContentBlock[]): ConvertedBlock[] {
  const converted: ConvertedBlock[] = [];
  let id = 0;
  
  for (const block of blocks) {
    // 展平list类型（不再过滤目录）
    if (block.type === 'list' && block.sub_type === 'text') {
      for (const item of block.list_items || []) {
        converted.push({ id: id++, type: 'text', text: item });
      }
    } else {
      converted.push({
        id: id++,
        type: block.type,
        text: block.text,
        img_path: block.img_path,
        image_caption: block.image_caption?.join(' ')
      });
    }
  }
  return converted;
}

// 在 parseLLMOutput() 中增加更精确的目录过滤
function isTocEntry(question: string): boolean {
  // 目录条目特征：
  // 1. 以页码数字结尾（如 "19.1 算术平方根(1) 2"）
  // 2. 长度较短（< 100 字符）
  // 3. 包含章节编号模式（如 "19.1", "第1章"）
  if (question.length > 100) return false;
  
  // 匹配 "数字.数字 + 中文 + (数字) + 页码" 模式
  const tocPattern = /^\d+\.\d+\s+[\u4e00-\u9fff]+\(\d+\)\s+\d{1,3}$/;
  if (tocPattern.test(question.trim())) return true;
  
  // 匹配 "中文 + (数字) + 页码" 模式
  const tocPattern2 = /^[\u4e00-\u9fff]+\(\d+\)\s+\d{1,3}$/;
  if (tocPattern2.test(question.trim())) return true;
  
  return false;
}

// 在 parseLLMOutput() 的最后增加过滤
qaPairs = qaPairs.filter(qa => !isTocEntry(qa.question));
```

**对齐官方**：官方不在输入阶段过滤，而是依赖 LLM 提示词和后处理

---

### 建议 2：简化合并索引结构（P0）

**当前问题**：三层索引结构复杂，偏离官方逻辑

**改进方案**：
1. **移除 questionByIds 索引**，不再使用 questionIds 去重
2. **简化为单层索引**：`Map<string, ExtractedQAPair>`，key 为 `${chapterId}:${chapter}:${label}`
3. **增加字段级别的增量更新**，对齐官方逻辑

**TypeScript 代码示例**：
```typescript
export function mergeQAPairs(
  questions: ExtractedQAPair[],
  answers: ExtractedQAPair[],
  strictTitleMatch: boolean = false
): MergedQAPair[] {
  const merged: MergedQAPair[] = [];
  
  // 单层索引：chapterId:chapter:label
  const questionMap = new Map<string, ExtractedQAPair>();
  const answerMap = new Map<string, ExtractedQAPair>();
  
  // 章节边界检测（对齐官方）
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
    const normalizedChapter = normalizeTitle(q.chapter_title, strictTitleMatch);
    const key = `${questionChapterId}:${normalizedChapter}:${labelNum}`;
    
    // 已完整的题目直接输出
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
      questionMap.set(key, q);
    }
  }
  
  // 处理答案列表（同样的逻辑）
  let currentAnswerChapter = '';
  let lastAnswerLabel = Infinity;
  let answerChapterId = 0;
  
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
    
    const normalizedChapter = normalizeTitle(a.chapter_title, strictTitleMatch);
    const key = `${answerChapterId}:${normalizedChapter}:${labelNum}`;
    
    // 字段级别的增量更新（对齐官方）
    if (!answerMap.has(key)) {
      answerMap.set(key, a);
    } else {
      const existing = answerMap.get(key)!;
      if (!existing.solution && a.solution) {
        existing.solution = a.solution;
      }
      if (!existing.answer && a.answer) {
        existing.answer = a.answer;
      }
    }
  }
  
  // 合并问题和答案
  for (const [key, q] of questionMap.entries()) {
    if (answerMap.has(key)) {
      const a = answerMap.get(key)!;
      const labelNum = parseInt(key.split(':')[2], 10);
      merged.push({
        label: labelNum,
        question_chapter_title: q.chapter_title,
        answer_chapter_title: a.chapter_title,
        question: q.question,
        answer: a.answer,
        solution: a.solution,
        images: Array.from(new Set([...q.images, ...a.images]))
      });
    }
  }
  
  return merged;
}
```

**对齐官方**：与官方 `merge_qa_pair()` 逻辑完全一致

---

### 建议 3：增加二次提示机制（P0）

**当前问题**：LLM 返回 `<empty></empty>` 的 chunk 直接丢弃

**改进方案**：
1. **检测空结果**：如果 LLM 返回 `<empty></empty>`，进行二次提示
2. **使用更详细的提示词**：增加示例、强调关键规则
3. **降低阈值**：允许提取不完整的题目（只有 question 或只有 solution）

**TypeScript 代码示例**：
```typescript
// 在 callLLMForTextExtraction() 中增加二次提示逻辑
export async function callLLMForTextExtractionWithRetry(
  config: LLMConfig,
  contentJson: string,
  systemPrompt: string = QA_EXTRACT_PROMPT,
  maxTokens: number = 16384
): Promise<string> {
  // 第一次尝试
  let output = await callLLMForTextExtraction(config, contentJson, systemPrompt, maxTokens);
  
  // 如果返回空结果，进行二次提示
  if (output.includes('<empty></empty>') || output.includes('<empty/>')) {
    console.log('[LLM Retry] First attempt returned empty, retrying with enhanced prompt...');
    
    // 使用更详细的提示词
    const enhancedPrompt = systemPrompt + `\n\n## IMPORTANT: This is a retry attempt. The previous attempt returned empty. Please carefully check if there are any math problems, examples (marked as "例①", "例1"), or exercises in the content. Even if the problems are incomplete or unclear, please try to extract them.`;
    
    output = await callLLMForTextExtraction(config, contentJson, enhancedPrompt, maxTokens);
  }
  
  return output;
}
```

**对齐官方**：官方可能有类似的重试机制（需进一步验证）

---

### 建议 4：增加可观测性（P2）

**当前问题**：缺少中间产物保存和质量指标

**改进方案**：
1. **保存中间产物**：每个算子的输入输出保存到文件
2. **增加质量指标**：统计每个 chapter 的题目数量、label 连续性、长度分布
3. **生成诊断报告**：自动生成质量评估报告

**TypeScript 代码示例**：
```typescript
// 在主流程中增加中间产物保存
export async function extractQAPairsWithDiagnostics(
  taskDir: string,
  llmConfig: LLMConfig
): Promise<{ qaPairs: MergedQAPair[], diagnostics: DiagnosticsReport }> {
  const diagnostics: DiagnosticsReport = {
    totalChunks: 0,
    emptyChunks: 0,
    totalQAPairs: 0,
    chapterStats: new Map<string, ChapterStats>(),
    labelGaps: []
  };
  
  // 阶段 1: 输入格式化
  const contentListPath = path.join(taskDir, 'content_list.json');
  const blocks = JSON.parse(fs.readFileSync(contentListPath, 'utf-8'));
  const converted = convertContentList(blocks);
  
  // 保存中间产物
  const convertedPath = path.join(taskDir, 'content_list_converted.json');
  fs.writeFileSync(convertedPath, JSON.stringify(converted, null, 2));
  
  // 阶段 2: 分块
  const chunks = chunkContentBlocks(converted);
  diagnostics.totalChunks = chunks.length;
  
  // 阶段 3: LLM 抽取
  const allQAPairs: ExtractedQAPair[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkJson = JSON.stringify(chunk);
    const llmOutput = await callLLMForTextExtractionWithRetry(llmConfig, chunkJson);
    
    // 保存 LLM 原始输出
    const llmOutputPath = path.join(taskDir, `chunk_${i}_llm_output.xml`);
    fs.writeFileSync(llmOutputPath, llmOutput);
    
    // 检测空结果
    if (llmOutput.includes('<empty></empty>')) {
      diagnostics.emptyChunks++;
    }
    
    // 解析
    const qaPairs = parseLLMOutput(llmOutput, chunk);
    allQAPairs.push(...qaPairs);
    
    // 保存解析结果
    const parsedPath = path.join(taskDir, `chunk_${i}_parsed.json`);
    fs.writeFileSync(parsedPath, JSON.stringify(qaPairs, null, 2));
  }
  
  // 阶段 4: 合并
  const merged = mergeQAPairs(allQAPairs, []);
  diagnostics.totalQAPairs = merged.length;
  
  // 统计质量指标
  for (const qa of merged) {
    const chapter = qa.question_chapter_title;
    if (!diagnostics.chapterStats.has(chapter)) {
      diagnostics.chapterStats.set(chapter, {
        count: 0,
        labels: [],
        avgQuestionLength: 0,
        avgSolutionLength: 0
      });
    }
    const stats = diagnostics.chapterStats.get(chapter)!;
    stats.count++;
    stats.labels.push(qa.label);
    stats.avgQuestionLength += qa.question.length;
    stats.avgSolutionLength += qa.solution.length;
  }
  
  // 计算平均值和检测 label 跳号
  for (const [chapter, stats] of diagnostics.chapterStats.entries()) {
    stats.avgQuestionLength /= stats.count;
    stats.avgSolutionLength /= stats.count;
    
    // 检测 label 跳号
    stats.labels.sort((a, b) => a - b);
    for (let i = 0; i < stats.labels.length - 1; i++) {
      if (stats.labels[i + 1] - stats.labels[i] > 1) {
        diagnostics.labelGaps.push({
          chapter,
          from: stats.labels[i],
          to: stats.labels[i + 1]
        });
      }
    }
  }
  
  // 保存诊断报告
  const diagnosticsPath = path.join(taskDir, 'diagnostics.json');
  fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
  
  return { qaPairs: merged, diagnostics };
}

interface DiagnosticsReport {
  totalChunks: number;
  emptyChunks: number;
  totalQAPairs: number;
  chapterStats: Map<string, ChapterStats>;
  labelGaps: Array<{ chapter: string; from: number; to: number }>;
}

interface ChapterStats {
  count: number;
  labels: number[];
  avgQuestionLength: number;
  avgSolutionLength: number;
}
```

---

## 四、总结与行动计划

### 核心结论

Mineru2Questions 项目在整体架构上遵循了 OpenDCAI/DataFlow 官方流水线的核心思想（基于 ID 的逻辑组装方案），但在多个关键环节存在偏离、容错缺失和过严约束。主要问题集中在：

1. **输入过滤过严**：`isTocList()` 可能误判选项列表
2. **合并逻辑复杂**：三层索引结构偏离官方简单逻辑
3. **缺失容错机制**：无二次提示、无字段级别增量更新
4. **可观测性不足**：缺少中间产物和质量指标

### 优先级行动计划

#### 立即执行（P0 - 数据丢失风险）

1. **移除输入阶段的目录过滤**
   - 修改 `convertContentList()`，移除 `isTocList()` 调用
   - 在 `parseLLMOutput()` 中增加更精确的后处理过滤
   - 预计工作量：2 小时

2. **简化合并索引结构**
   - 重构 `mergeQAPairs()`，移除三层索引
   - 增加字段级别的增量更新逻辑
   - 预计工作量：4 小时

3. **增加二次提示机制**
   - 实现 `callLLMForTextExtractionWithRetry()`
   - 检测空结果并使用增强提示词重试
   - 预计工作量：2 小时

#### 短期优化（P1 - 稳定性风险）

4. **动态调整 max_tokens**
   - 根据 chunk 大小动态计算 max_tokens
   - 监控输出截断情况
   - 预计工作量：2 小时

5. **增加 Overlap 去重验证**
   - 统计重叠区域的题目数量
   - 验证基于 `(chapter_title, label)` 的去重是否有效
   - 预计工作量：2 小时

#### 中期改进（P2 - 可观测性）

6. **增加中间产物保存**
   - 保存每个算子的输入输出
   - 保存 LLM 原始输出
   - 预计工作量：4 小时

7. **实现质量评估指标**
   - 统计每个 chapter 的题目数量
   - 检测 label 跳号
   - 生成诊断报告
   - 预计工作量：4 小时

### 验证方法

1. **回归测试**：使用当前测试任务（八上数学测试.pdf）验证改进效果
2. **对比测试**：与官方 DataFlow 的输出进行对比（如果可能）
3. **边界测试**：使用包含选项列表、目录、复杂排版的 PDF 进行测试
4. **质量指标**：统计改进前后的题目数量、label 连续性、内容完整性

---

## 附录：官方 DataFlow 流水线完整流程

```python
# OpenDCAI/DataFlow/dataflow/statics/pipelines/api_pipelines/pdf_vqa_extract_pipeline.py

class PDF_VQA_extract_optimized_pipeline(PipelineABC):
    def forward(self):
        # 1. MinerU 处理（问题 PDF）
        self.mineru_executor.run(
            storage=self.storage.step(),
            input_key="question_pdf_path",
            output_key="question_markdown_path",
        )
        
        # 2. MinerU 处理（答案 PDF）
        self.mineru_executor.run(
            storage=self.storage.step(),
            input_key="answer_pdf_path",
            output_key="answer_markdown_path",
        )
        
        # 3. 格式化问题输入
        self.input_formatter.run(
            storage=self.storage.step(),
            input_markdown_path_key="question_markdown_path",
            output_converted_layout_key="converted_question_layout_path",
        )
        
        # 4. 格式化答案输入
        self.input_formatter.run(
            storage=self.storage.step(),
            input_markdown_path_key="answer_markdown_path",
            output_converted_layout_key="converted_answer_layout_path",
        )
        
        # 5. LLM 抽取问题
        self.vqa_extractor.run(
            storage=self.storage.step(),
            input_path_key="converted_question_layout_path",
            output_path_key="vqa_extracted_questions_path",
        )
        
        # 6. LLM 抽取答案
        self.vqa_extractor.run(
            storage=self.storage.step(),
            input_path_key="converted_answer_layout_path",
            output_path_key="vqa_extracted_answers_path",
        )
        
        # 7. 解析问题输出
        self.llm_output_question_parser.run(
            storage=self.storage.step(),
            input_response_path_key="vqa_extracted_questions_path",
            input_converted_layout_path_key="converted_question_layout_path",
            input_name_key="name",
            output_qalist_path_key="extracted_questions_path",
        )
        
        # 8. 解析答案输出
        self.llm_output_answer_parser.run(
            storage=self.storage.step(),
            input_response_path_key="vqa_extracted_answers_path",
            input_converted_layout_path_key="converted_answer_layout_path",
            input_name_key="name",
            output_qalist_path_key="extracted_answers_path",
        )
        
        # 9. 合并问答对
        self.qa_merger.run(
            storage=self.storage.step(),
            input_question_qalist_path_key="extracted_questions_path",
            input_answer_qalist_path_key="extracted_answers_path",
            input_name_key="name",
            output_merged_qalist_path_key="output_merged_qalist_path",
            output_merged_md_path_key="output_merged_md_path",
            output_qa_item_key="qa_pair",
        )
```

---

**报告生成时间**：2026-02-08  
**审查人员**：Manus AI Agent  
**参考标准**：OpenDCAI/DataFlow (commit: latest)  
**目标项目**：shcming2023/Mineru2Questions (commit: latest)
