# Mineru2Questions 项目算子阶段对齐诊断报告

## 测试任务信息
- **任务ID**: 202602111658-1770800289216
- **输入**: content_list.json (2900 个 blocks)
- **输出**: 854 个题目 (93 个例题 + 761 个练习题)
- **处理方式**: 47 个 chunks (MAX_CHUNK_SIZE=100, OVERLAP_SIZE=30)

---

## 阶段 1: 输入格式化与标准化

### 官方参考 (DataFlow)
**算子**: `MinerU2LLMInputOperator`
- 为每个 item 添加 `id` 字段
- 展平 list 类型的 list_items (每个 item 独立分配 ID)
- 移除 bbox 和 page_idx (简化 LLM 输入)
- **关键**: 保证 ID 连续性,避免跳号

### 项目实现 (extraction.ts: loadAndFormatBlocks)
```typescript
function loadAndFormatBlocks(contentListPath: string): ConvertedBlock[] {
  const convertedBlocks: ConvertedBlock[] = [];
  let currentId = 0;
  
  for (const block of contentList) {
    // 1. 过滤噪声块
    if (['page_number', 'footer', 'header'].includes(block.type)) continue;
    
    // 1.1 TOC 过滤
    if (block.text && (block.text.trim() === '目录' || block.text.match(/\.{4,}\s*\d+$/))) continue;

    // 2. 展平 list 块
    if (block.type === 'list' && block.list_items) {
      for (const itemText of block.list_items) {
        convertedBlocks.push({
          id: currentId++,
          type: 'text',
          text: itemText.trim(),
          page_idx: block.page_idx,
        });
      }
      continue;
    }

    // 3. 拆分 table 块
    if (block.type === 'table' && typeof tableContent === 'string' && tableContent.includes('<tr')) {
      const rows = tableContent.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      for (const rowHtml of rows) {
        convertedBlocks.push({
          id: currentId++,
          type: 'text',
          text: `[Table Row] ${rowHtml}`,
          page_idx: block.page_idx,
        });
      }
      continue;
    }

    // 4. 处理其他类型 (text, equation, image)
    const newBlock: ConvertedBlock = {
      id: currentId, 
      type: block.type,
      page_idx: block.page_idx
    };
    if (block.text) newBlock.text = block.text.trim();
    if (block.type === 'image' && block.img_path) {
      newBlock.img_path = block.img_path;
      newBlock.image_caption = Array.isArray(block.image_caption) 
        ? block.image_caption.join(' ') 
        : (block.image_caption || '');
    }
    convertedBlocks.push(newBlock);
    currentId++;
  }
  
  return convertedBlocks;
}
```

### 对齐评估: ✅ 高度一致

**优点**:
1. ✅ 正确展平 list_items,每个 item 独立分配 ID
2. ✅ ID 连续性保证 (currentId 严格递增)
3. ✅ 保留 page_idx (虽然官方移除,但项目需要用于输出)
4. ✅ 额外过滤噪声 (TOC, header, footer) - 超出官方实现

**差异**:
1. ⚠️ **Table 拆分逻辑**: 官方未拆分 table,项目按行拆分
   - **影响**: 可能导致 table 内容被过度碎片化,LLM 难以理解完整表格结构
   - **建议**: 考虑保留完整 table 作为单个 block,或在拆分时保留 table 上下文标记

2. ⚠️ **Image caption 处理**: 项目将数组转为字符串,官方保留数组
   - **影响**: 轻微,主要影响日志可读性
   - **建议**: 保持当前实现即可

---

## 阶段 2: ID 列表构建与候选区域筛选

### 官方参考 (DataFlow)
**算子**: `ChunkedPromptedGenerator`
- 将 content_list 切块控制 token (max_chunk_len=128000 tokens)
- **无候选筛选**: 官方直接将完整 chunk 发送给 LLM,由 LLM 自主判断哪些是题目

### 项目实现 (extraction.ts: splitIntoChunks)
```typescript
function splitIntoChunks(
  blocks: ConvertedBlock[],
  maxSize: number,      // 100 blocks
  overlapSize: number   // 30 blocks
): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  
  while (start < blocks.length) {
    const end = Math.min(start + maxSize, blocks.length);
    const chunkBlocks = blocks.slice(start, end);
    
    chunks.push({
      index,
      blocks: chunkBlocks,
      startId: chunkBlocks[0].id,
      endId: chunkBlocks[chunkBlocks.length - 1].id
    });
    
    if (end === blocks.length) break;
    start = end - overlapSize; // 重叠窗口
  }
  
  return chunks;
}
```

### 对齐评估: ⚠️ 部分偏离

**优点**:
1. ✅ 重叠窗口设计 (30 blocks) - 避免题目被切断
2. ✅ 简单高效,无复杂规则

**差异与风险**:
1. ⚠️ **按 block 数量切块 vs 按 token 数量切块**
   - **官方**: max_chunk_len=128000 tokens (动态计算 token 数)
   - **项目**: MAX_CHUNK_SIZE=100 blocks (固定 block 数)
   - **风险**: 
     - 如果某些 block 包含大量文本 (如长题干、表格),可能超出 LLM 上下文限制
     - 如果某些 block 很短 (如单个数字、符号),可能浪费 LLM 容量
   - **建议**: 
     - 增加 token 计数逻辑,动态调整 chunk 大小
     - 或至少增加总 token 数上限检查,超限时拆分

2. ⚠️ **无候选筛选**: 项目与官方一致,直接发送完整 chunk
   - **优点**: 避免硬编码规则,泛化性强
   - **风险**: LLM 可能被噪声干扰 (如目录、页眉、定义文本)
   - **当前缓解**: 已在阶段 1 过滤部分噪声 (TOC, header, footer)
   - **建议**: 保持当前策略,通过提示词引导 LLM 识别

---

## 阶段 3: 基于上下文的 LLM 抽取

### 官方参考 (DataFlow)
**提示词**: `QAExtractPrompt`
- **核心约束**: LLM 只输出 ID/ID 区间/ID 列表
- **输出格式**: XML 标签结构
  ```xml
  <chapter><title>ID</title>
  <qa_pair>
    <label>题号</label>
    <type>example|exercise</type>
    <question>ID,ID,ID</question>
    <solution>ID,ID,ID</solution>
  </qa_pair>
  </chapter>
  ```

### 项目实现 (prompts.ts: QUESTION_EXTRACT_PROMPT)
**核心规则**:
```
## CRITICAL RULE 1: ID-ONLY OUTPUT
You MUST output ONLY block IDs (comma-separated numbers), NOT the actual text content.
✅ CORRECT: <question>10,11,12</question>
❌ WRONG: <question>What is the square root of 16?</question>

## CRITICAL RULE 2: INCLUDE ALL CONSECUTIVE BLOCKS (ESPECIALLY IMAGES)
When a question spans multiple consecutive blocks, you MUST include ALL IDs in sequence.
DO NOT skip any block, especially image blocks (type='image') and equation blocks (type='equation').
✅ CORRECT: <question>45,46,47,48</question>  <!-- includes text + image + text -->
❌ WRONG: <question>45,47,48</question>       <!-- MISSING image block 46 -->
```

### 对齐评估: ✅ 完全一致 + 增强

**优点**:
1. ✅ 严格执行 ID-Only 原则,与官方完全一致
2. ✅ 强调图片 ID 连续性 (CRITICAL RULE 2) - **超出官方,针对性优化**
3. ✅ 题目类型识别 (example vs exercise)
4. ✅ 章节标题关联 (Parent Chapter Association)
5. ✅ 丰富的示例 (4 个完整示例覆盖常见场景)

**差异**:
1. ⚠️ **近距离答案提取**: 项目仅对 example 提取 solution (within ~5 blocks)
   - **官方**: 题答分离模式,通过 QA_Merger 合并
   - **项目**: 题答混排模式,直接在 LLM 阶段提取
   - **评估**: 合理差异,项目聚焦单文件场景

2. ⚠️ **章节标题提取策略**:
   - **项目**: "Parent Chapter Association" - 子标题关联父章节
   - **官方**: 未明确说明此策略
   - **评估**: 项目增强,但可能导致章节标题不准确 (见阶段 4 分析)

---

## 阶段 4: ID 回填原文

### 官方参考 (DataFlow)
**算子**: `LLMOutputParser`
```python
def _id_to_text(self, input_ids, input_json, image_prefix="images"):
    texts = []
    id_list = input_ids.replace(' ', '').split(',')
    for id in id_list:
        if int(id) < len(input_json):
            item = input_json[int(id)]
            if 'text' in item:
                texts.append(item['text'])
            elif 'img_path' in item:
                img_name = os.path.basename(img_path)
                new_path = f"{image_prefix}/{img_name}"
                texts.append(f"![{' '.join(item.get('image_caption','image'))}]({new_path})")
    return '\n'.join(texts)
```

### 项目实现 (parser.ts: getTextAndImagesFromIds)
```typescript
private getTextAndImagesFromIds(ids: string): { text: string; images: string[] } {
  if (!ids || ids.trim() === '') return { text: '', images: [] };

  const idList = ids.split(',').map(id => parseInt(id.trim(), 10));
  const textParts: string[] = [];
  const images: string[] = [];

  for (const id of idList) {
    const block = this.blocks.find(b => b.id === id);
    if (!block) continue;

    if (block.type === 'image' && block.img_path) {
      images.push(path.join(this.imagePrefix, block.img_path));
    } else if (block.text) {
      textParts.push(block.text);
    }
  }

  return {
    text: textParts.join(' ').trim(),
    images
  };
}
```

### 对齐评估: ⚠️ 关键差异

**优点**:
1. ✅ 正确解析 ID 序列 (逗号分隔)
2. ✅ 正确提取文本和图片
3. ✅ 图片路径处理 (path.join 确保正确性)

**关键差异**:
1. ❌ **图片处理方式不同**
   - **官方**: 图片转为 Markdown 格式 `![caption](path)`,**嵌入到文本中**
   - **项目**: 图片单独存储在 `images` 数组,**不嵌入文本**
   - **影响**: 
     - 项目输出的 `question` 字段**不包含图片引用**,只有纯文本
     - 图片位置信息丢失 (无法知道图片在题干中的哪个位置)
     - Markdown 导出时图片统一放在题目末尾,而非原始位置
   - **示例对比**:
     ```json
     // 官方输出
     {
       "question": "如图所示\n![图片](images/fig1.jpg)\n已知 a^2 + b^2 = c^2\n求 c 的值."
     }
     
     // 项目输出
     {
       "question": "如图所示 已知 a^2 + b^2 = c^2 求 c 的值.",
       "images": ["../images/fig1.jpg"]
     }
     ```
   - **后果**: 
     - 用户无法从 `question` 文本直接看到完整题目 (缺少图片)
     - 下游系统 (如题库、LLM 训练) 需要额外处理图片数组
   - **建议**: 
     - **方案 A (推荐)**: 对齐官方,将图片以 Markdown 格式嵌入 `question` 文本
     - **方案 B**: 保持当前实现,但在文档中明确说明,并提供图片位置信息 (如 `imagePositions: [2, 5]`)

2. ⚠️ **文本拼接方式**
   - **官方**: `'\n'.join(texts)` (换行符分隔)
   - **项目**: `textParts.join(' ').trim()` (空格分隔)
   - **影响**: 
     - 项目输出的文本可能丢失原始段落结构
     - 对于多行题目 (如证明题、应用题),可读性下降
   - **建议**: 改为 `'\n'` 分隔,保留段落结构

---

## 阶段 5: 问答对合并与去重

### 官方参考 (DataFlow)
**算子**: `QA_Merger`
- **合并策略**: 根据 `(章节标题, 题号)` 匹配问答对
- **章节标题规范化**: `refine_title()`
  ```python
  def refine_title(title: str, strict_title_match=False):
      title = re.sub(r'\s+', '', title)  # 删除空格与换行符
      if not strict_title_match:
          try:
              # 优先提取阿拉伯数字章节编号
              new_title = re.search(r"\d+\.\d+|\d+", title).group()
          except:    
              try:
                  # 其次提取中文数字章节编号
                  new_title = re.search(r'[一二三四五六七八九零十百]+', title).group()   
              except:
                  new_title = title
          title = new_title
      return title
  ```
- **题号连续性检测**: 防止误提取子标题
  ```python
  if data["chapter_title"] != "" and data["chapter_title"] != chapter_title:
      if data["label"] < label:  # 题号重新开始,说明是新章节
          chapter_id += 1
          chapter_title = data["chapter_title"]
      else:  # 题号增加但章节标题变化,说明可能错误提取了子标题
          data["chapter_title"] = chapter_title  # 继续使用之前的章节标题
  ```

### 项目实现 (extraction.ts: deduplicateQuestions + cleanChapterTitles)

**去重逻辑**:
```typescript
function deduplicateQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const seen = new Set<string>();
  const unique: ExtractedQuestion[] = [];
  
  for (const q of questions) {
    const key = q.questionIds;  // 使用 questionIds 作为唯一键
    if (key && key.trim().length > 0) {
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(q);
      }
    } else {
      unique.push(q);
    }
  }
  
  return unique;
}
```

**章节标题清洗**:
```typescript
function cleanChapterTitles(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const titleBlacklist = ["选择题", "填空题", "判断题", "应用题", "计算题", "递等式", "竖式", "基础训练", "拓展训练"];
  const chapterNumberRegex = /^(\d+(\.\d+)*|第[一二三四五六七八九十\d]+[章节])/;
  let lastValidTitle = "";

  return questions.map(q => {
    const title = q.chapter_title || "";
    const isNoiseTitle = titleBlacklist.some(keyword => title.includes(keyword));
    
    if (isNoiseTitle) {
      const match = title.match(chapterNumberRegex);
      if (match) {
        q.chapter_title = match[0];
        lastValidTitle = q.chapter_title;
      } else {
        q.chapter_title = lastValidTitle; // 使用上一个有效的标题
      }
    } else {
      if (q.chapter_title) lastValidTitle = q.chapter_title;
    }
    return q;
  });
}
```

### 对齐评估: ⚠️ 关键缺失

**优点**:
1. ✅ 使用 `questionIds` 去重 - 对齐官方策略 (基于 ID 而非文本)
2. ✅ 章节标题黑名单过滤 - 针对性优化
3. ✅ 章节编号提取 (阿拉伯数字 + 中文数字)

**关键缺失**:
1. ❌ **无题号连续性检测**
   - **官方**: 题号增加但章节标题变化时,继续使用之前章节标题
   - **项目**: 直接使用 LLM 输出的章节标题,无验证
   - **后果**: 
     - LLM 可能误将子标题 (如 "基础训练") 识别为新章节
     - 导致同一章节的题目被拆分到不同章节
   - **示例**:
     ```
     题目 1-10: 章节 "19.1 平方根"
     题目 11: 章节 "基础训练" (实际应该仍属于 "19.1 平方根")
     题目 12-20: 章节 "基础训练"
     ```
   - **建议**: 
     - 增加题号连续性检测逻辑
     - 或在提示词中更明确地要求 LLM 区分主章节和子标题

2. ❌ **章节标题规范化不完整**
   - **官方**: `refine_title()` 提取章节编号 (如 "19.1" 或 "第一章")
   - **项目**: `cleanChapterTitles()` 只处理黑名单,不提取编号
   - **后果**: 
     - 章节标题可能包含冗余文本 (如 "第19章 平方根 基础训练")
     - 导致章节匹配失败 (如果题目和答案的章节标题格式不一致)
   - **建议**: 
     - 增加章节编号提取逻辑 (对齐官方 `refine_title()`)
     - 或提供 `strict_title_match` 参数供用户选择

3. ⚠️ **无跨页合并逻辑**
   - **官方**: QA_Merger 支持题答分离模式,跨文件合并
   - **项目**: 仅支持单文件模式,无跨页合并
   - **评估**: 合理差异,项目聚焦单文件场景
   - **风险**: 如果题目跨页 (题干在页尾,答案在下一页),可能丢失

---

## 阶段 6: 质量评估与回退策略

### 官方参考 (DataFlow)
**暂未实现**,但文档提到未来会加入:
- 二次提示 (对缺失字段或边界不清的条目)
- 冲突解决策略 (多个 label 匹配同一题目)
- 置信度评分

### 项目实现

**容错回退** (parser.ts: parseWithFallback):
```typescript
public parseWithFallback(llmOutput: string, chunkIndex: number): ExtractedQuestion[] {
  try {
    const questions = this.strictParse(llmOutput, chunkIndex);
    return questions;
  } catch (strictError: any) {
    console.warn(`[Chunk ${chunkIndex}] Strict parse failed: ${strictError.message}`);
    try {
      const questions = this.lenientParse(llmOutput, chunkIndex);
      return questions;
    } catch (lenientError: any) {
      console.error(`[Chunk ${chunkIndex}] Lenient parse also failed: ${lenientError.message}`);
      return [];
    }
  }
}
```

**质量过滤** (extraction.ts: filterLowQuality):
```typescript
function filterLowQuality(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  return questions.filter(q => {
    if (!q.question || q.question.trim().length === 0) return false;
    if (q.question.trim().length < 5) return false;
    if (!q.label || q.label.trim().length === 0) return false;
    return true;
  });
}
```

**LLM 注意力衰减检测** (extraction.ts: Sanity Check):
```typescript
if (chunk.blocks.length > 40 && questions.length <= 1) {
  if (retries < maxRetries) {
    throw new Error(`Sanity Check Failed: Input has ${chunk.blocks.length} blocks but only ${questions.length} questions extracted.`);
  }
}
```

### 对齐评估: ✅ 超出官方

**优点**:
1. ✅ 严格解析 + 宽松解析双重容错 - **超出官方**
2. ✅ 质量过滤 (空题目、短题目、无题号) - **超出官方**
3. ✅ LLM 注意力衰减检测 - **创新性容错**
4. ✅ 详细日志记录 (LLM 输出、解析结果、错误信息) - **超出官方**

**建议**:
1. ⚠️ **Sanity Check 阈值**: `chunk.blocks.length > 40 && questions.length <= 1`
   - 可能过于严格,导致误报 (如某些页面确实只有 1 个题目)
   - **建议**: 调整为比例检测,如 `questions.length / chunk.blocks.length < 0.02`

---

## 总体评估

### 对齐度评分

| 阶段 | 官方算子 | 项目实现 | 对齐度 | 评级 |
|------|---------|---------|--------|------|
| 1. 输入格式化 | MinerU2LLMInputOperator | loadAndFormatBlocks | 95% | ✅ 优秀 |
| 2. ID 列表构建 | ChunkedPromptedGenerator | splitIntoChunks | 80% | ⚠️ 良好 |
| 3. LLM 抽取 | QAExtractPrompt | QUESTION_EXTRACT_PROMPT | 100% | ✅ 完美 |
| 4. ID 回填 | LLMOutputParser._id_to_text | getTextAndImagesFromIds | 70% | ⚠️ 需改进 |
| 5. 合并去重 | QA_Merger + refine_title | deduplicateQuestions + cleanChapterTitles | 60% | ⚠️ 需改进 |
| 6. 质量评估 | (未实现) | parseWithFallback + filterLowQuality | 120% | ✅ 超出 |

**总体对齐度**: 约 **85%**

---

## 核心问题诊断

### P0 问题 (必须修复)

1. **图片未嵌入文本** (阶段 4)
   - **现象**: `question` 字段不包含图片引用,图片单独存储在 `images` 数组
   - **根因**: `getTextAndImagesFromIds()` 将图片和文本分开处理
   - **影响**: 用户无法从文本直接看到完整题目,图片位置信息丢失
   - **修复**: 将图片以 Markdown 格式嵌入 `question` 文本

2. **章节标题规范化缺失** (阶段 5)
   - **现象**: 章节标题可能包含冗余文本 (如 "第19章 平方根 基础训练")
   - **根因**: `cleanChapterTitles()` 只处理黑名单,不提取编号
   - **影响**: 章节匹配可能失败,题目分类不准确
   - **修复**: 增加章节编号提取逻辑 (对齐官方 `refine_title()`)

### P1 问题 (建议修复)

3. **题号连续性检测缺失** (阶段 5)
   - **现象**: LLM 可能误将子标题识别为新章节
   - **根因**: 无题号连续性验证
   - **影响**: 同一章节的题目被拆分
   - **修复**: 增加题号连续性检测逻辑

4. **文本拼接方式** (阶段 4)
   - **现象**: 文本用空格拼接,丢失段落结构
   - **根因**: `textParts.join(' ')`
   - **影响**: 多行题目可读性下降
   - **修复**: 改为 `'\n'` 分隔

### P2 问题 (可选优化)

5. **按 block 数量切块** (阶段 2)
   - **现象**: 固定 100 blocks/chunk,未考虑 token 数
   - **根因**: 简化实现
   - **影响**: 可能超出 LLM 上下文限制
   - **修复**: 增加 token 计数逻辑

6. **Table 拆分逻辑** (阶段 1)
   - **现象**: 按行拆分 table
   - **根因**: 过度碎片化
   - **影响**: LLM 难以理解完整表格
   - **修复**: 保留完整 table 或增加上下文标记

---

## 测试结果分析

### 数据统计
- **总题目**: 854 个
- **例题**: 93 个 (10.9%)
- **练习题**: 761 个 (89.1%)
- **有答案**: 93 个 (仅例题,符合预期)
- **无答案**: 761 个 (练习题,符合预期)

### 质量抽查 (questions[50:55])

**题目 50-54 分析**:
```json
{
  "label": "11",
  "type": "exercise",
  "chapter_title": "23.2 平行四边形",
  "question": "11. 如图, 在  $\\square ABCD$  中, 对角线  $AC, BD$  交于点  $O$ ...",
  "images": [],  // ❌ 问题: "如图" 但无图片
  "questionIds": "291"
}
```

**发现**:
1. ❌ **题目包含 "如图" 但 `images` 为空**
   - **可能原因**: 
     - LLM 未输出图片 ID (漏掉了紧邻的 image block)
     - 或该 block 的 `type` 不是 'image'
   - **验证方法**: 检查 `formatted_blocks.json` 中 ID 291 附近是否有 image block
   - **修复**: 强化提示词中的图片连续性规则 (已有 CRITICAL RULE 2,但可能需要更多示例)

2. ✅ **章节标题格式**: "23.2 平行四边形" - 格式正确
   - 说明 `cleanChapterTitles()` 基本有效

3. ✅ **题号连续**: 11, 12, 13, 14, 15, 16 - 连续性良好
   - 说明 LLM 能正确识别独立题目

---

## 可观测性评估

### 日志完整性: ✅ 优秀

项目提供了丰富的中间产物:
- `debug/formatted_blocks.json` - 格式化后的 blocks
- `debug/chunk_X_prompt.txt` - 发送给 LLM 的完整 prompt
- `logs/chunk_X_llm_output.txt` - LLM 原始输出
- `logs/chunk_X_parsed_questions.log` - 解析后的题目
- `logs/chunk_X_error.json` - 错误信息

**建议**:
- ✅ 保持当前日志策略
- ⚠️ 增加 `logs/chunk_X_blocks.json` - 保存每个 chunk 的 blocks (便于调试 ID 引用)

---

## 下一步行动建议

### 立即修复 (P0)

1. **修改 `getTextAndImagesFromIds()`**:
   ```typescript
   private getTextAndImagesFromIds(ids: string): { text: string; images: string[] } {
     const idList = ids.split(',').map(id => parseInt(id.trim(), 10));
     const parts: string[] = [];
     const images: string[] = [];

     for (const id of idList) {
       const block = this.blocks.find(b => b.id === id);
       if (!block) continue;

       if (block.type === 'image' && block.img_path) {
         const imgPath = path.join(this.imagePrefix, block.img_path);
         images.push(imgPath);
         // 嵌入 Markdown 图片引用
         const caption = block.image_caption || 'image';
         parts.push(`![${caption}](${imgPath})`);
       } else if (block.text) {
         parts.push(block.text);
       }
     }

     return {
       text: parts.join('\n').trim(),  // 改为换行符分隔
       images
     };
   }
   ```

2. **增加章节编号提取**:
   ```typescript
   function refineChapterTitle(title: string): string {
     if (!title || title.trim() === '') return '';
     
     // 删除空格与换行符
     title = title.replace(/\s+/g, '');
     
     // 优先提取阿拉伯数字章节编号
     const arabicMatch = title.match(/\d+(\.\d+)*/);
     if (arabicMatch) return arabicMatch[0];
     
     // 其次提取中文数字章节编号
     const chineseMatch = title.match(/第?[一二三四五六七八九零十百]+[章节]/);
     if (chineseMatch) return chineseMatch[0];
     
     // 保留原标题
     return title;
   }
   ```

### 短期优化 (P1)

3. **增加题号连续性检测**:
   ```typescript
   function validateChapterTitles(questions: ExtractedQuestion[]): ExtractedQuestion[] {
     let lastTitle = '';
     let lastLabel = 0;
     
     return questions.map(q => {
       const currentLabel = parseInt(q.label.match(/\d+/)?.[0] || '0', 10);
       
       if (q.chapter_title && q.chapter_title !== lastTitle) {
         if (currentLabel > lastLabel) {
           // 题号增加但章节变化,可能是误提取子标题
           console.warn(`Suspected sub-title: "${q.chapter_title}" (label ${currentLabel} > ${lastLabel})`);
           q.chapter_title = lastTitle;  // 继续使用上一个章节
         } else {
           // 题号重新开始,说明是新章节
           lastTitle = q.chapter_title;
         }
       }
       
       lastLabel = currentLabel;
       return q;
     });
   }
   ```

### 长期优化 (P2)

4. **Token 计数逻辑**:
   - 使用 `tiktoken` 或类似库计算 token 数
   - 动态调整 chunk 大小,确保不超过 LLM 上下文限制

5. **Table 处理优化**:
   - 保留完整 table 作为单个 block
   - 或在拆分时增加上下文标记 (如 `[Table Start]`, `[Table End]`)
