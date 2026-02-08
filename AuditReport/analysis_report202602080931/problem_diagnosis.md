# 当前实现问题诊断

## 测试数据概况
- **测试任务**: 202602080714-1770506098605
- **输入文档**: 八上数学测试.md
- **总题目数**: 225题
- **章节覆盖**: 19.1, 20.1, 20.2, 21.1-21.5, 22.1-22.3

## 核心问题识别

### P1: 题号重复问题 (严重)
**现象**: 
- label=1 出现21次
- label=2 出现23次
- 每个章节的题号都从1开始,导致不同章节的相同题号被视为重复

**根因分析**:
1. **章节边界检测不足**: 当前实现虽然有 `questionChapterId` 机制,但可能存在以下问题:
   - 章节标题规范化过度(只保留数字),导致不同章节被误判为同一章节
   - 题号重置检测逻辑不够鲁棒
   
2. **去重键设计缺陷**: 
   - 当前使用 `${questionChapterId}:${normalizedChapter}:${labelKey}` 作为去重键
   - 但如果 `questionChapterId` 判断失误,会导致不同章节的题目被覆盖

**对比 DataFlow 官方**:
- DataFlow 的 `merge_qa_pair` 函数使用更严格的章节边界检测
- 官方实现中没有看到复杂的 `questionChapterId` 逻辑,而是直接使用规范化后的章节标题

### P2: 所有题目的 label 都是 1 (严重)
**现象**:
```json
{
  "label": 1,
  "chapter_title": "19.1",
  "question": "例① 实数 $\\sqrt{16}$ 的算术平方根是",
  ...
}
```

**根因分析**:
1. **圆圈数字识别问题**: 题目中使用 "例①" 作为标记,但当前实现可能在以下环节出错:
   - LLM 输出阶段: 提示词要求将 ① 转换为 1,但可能所有圆圈数字都被转换为 1
   - 解析阶段: `normalizeLabel` 函数虽然支持圆圈数字转换,但可能有bug
   
2. **提示词问题**: 
   ```
   For circled numbers: use "1" for ①, "2" for ②, "3" for ③, etc.
   ```
   这个指令可能导致 LLM 将所有 "例①" 都输出为 label=1

**对比 DataFlow 官方**:
- 官方提示词中明确要求: "Preserve each problem's original label/number"
- 官方不强制转换圆圈数字,而是保留原始标记

### P3: 题目内容质量问题
**观察**:
- 部分题目的 question 和 solution 被分离(应该是同一个例题)
- 例如第1题和第2题可能是同一个例题的不同部分

**根因分析**:
1. **Interleaved 模式识别不足**: 
   - 当前实现虽然有 interleaved 处理逻辑,但可能在以下情况失效:
     - 例题和解答之间有其他内容块(如图片、公式)
     - 解答跨多个内容块
     
2. **ID 连续性检测缺失**:
   - DataFlow 官方强调 "consecutive IDs" 的重要性
   - 当前实现的提示词虽然有这个要求,但 LLM 可能没有正确执行

## 对齐 DataFlow 官方流水线

### 算子阶段对比

| 阶段 | DataFlow 官方 | Mineru2Questions 当前实现 | 差异 |
|------|---------------|---------------------------|------|
| 1. 输入格式化 | `MinerU2LLMInputOperator` | `convertContentList` | ✓ 基本对齐 |
| 2. LLM 抽取 | `ChunkedPromptedGenerator` | `extractQAPairsWithLLM` | ⚠️ 提示词有差异 |
| 3. 输出解析 | `LLMOutputParser` | `parseLLMOutput` | ✓ 基本对齐 |
| 4. 问答合并 | `QA_Merger` | `mergeQAPairs` | ⚠️ 去重逻辑有差异 |

### 关键差异点

#### 差异1: 提示词设计
**DataFlow 官方** (QAExtractPrompt):
```python
- Preserve each problem's original label/number, such as "例1", "Example 3", "习题1", "11"
- Use Arabic numerals only. For example, if the label is "例一", convert it to "例1"
```

**Mineru2Questions 当前**:
```typescript
- For circled numbers: use "1" for ①, "2" for ②, "3" for ③, etc.
```

**问题**: 当前实现强制转换圆圈数字,导致 "例①" 被转换为 "1",丢失了 "例" 前缀

#### 差异2: 章节标题规范化
**DataFlow 官方** (refine_title):
```python
def refine_title(title, strict_match=False):
    # 删除空格和换行
    normalized = title.replace(/\s+/g, '')
    
    if not strict_match:
        # 只提取数字编号(如"19.1"或"19"),丢弃中文描述
        match = re.match(r'\d+\.\d+|\d+', normalized)
        if match:
            return match.group(0)
```

**Mineru2Questions 当前**:
```typescript
export function normalizeTitle(title: string, strictMatch: boolean = false): string {
  let normalized = title.replace(/\s+/g, '');
  if (!strictMatch) {
    const arabicMatch = normalized.match(/\d+\.\d+|\d+/);
    if (arabicMatch) {
      return arabicMatch[0];
    }
  }
  return normalized;
}
```

**评估**: ✓ 基本对齐,但需要检查实际使用场景

#### 差异3: 去重键生成
**DataFlow 官方**:
- 使用 `label` 作为主键
- 使用 `chapter_title` 进行分组
- 没有复杂的 `questionChapterId` 机制

**Mineru2Questions 当前**:
```typescript
const key = `${questionChapterId}:${normalizedChapter}:${labelKey}`;
```

**问题**: `questionChapterId` 的生成逻辑可能有bug,导致不同章节被分配相同的ID

## 下一步行动

### 优先级 P0 (立即修复)
1. **修复 label 提取逻辑**: 
   - 保留原始 label (如 "例①"),不要强制转换
   - 或者正确转换为 "例1" 而不是 "1"
   
2. **简化去重键生成**:
   - 参考官方实现,使用更简单的 `${normalizedChapter}:${labelKey}` 作为去重键
   - 移除或修复 `questionChapterId` 机制

### 优先级 P1 (重要优化)
3. **增强 Interleaved 模式识别**:
   - 检测例题和解答的连续性
   - 处理中间插入的图片、公式等内容块
   
4. **改进提示词**:
   - 对齐 DataFlow 官方提示词的关键指令
   - 强化 "consecutive IDs" 的要求

### 优先级 P2 (长期改进)
5. **增加可观测性**:
   - 记录每个算子阶段的输入输出
   - 保存 LLM 原始输出用于调试
   
6. **容错机制**:
   - 添加二次提示逻辑
   - 实现冲突解决策略
