/**
 * LLM 提示词模板
 * 
 * 对齐 DataFlow 官方流水线的 QAExtractPrompt。
 * 强化 "ID-Only" 原则，确保 LLM 只输出 ID 序列。
 * 
 * 核心改进：
 * 1. 更明确地禁止输出自由文本
 * 2. 增加更多示例展示正确和错误的输出
 * 3. 强调 <answer> 字段也应尽量使用 ID（除非是非常短的答案）
 * 4. 增加错误示例，帮助 LLM 理解什么是不允许的
 */

/**
 * QA 提取提示词（强化版 ID-Only）
 * 
 * 用于从 MinerU 解析的 content_list.json 中抽取题目和答案。
 */
export const QA_EXTRACT_PROMPT = `You are an expert in extracting questions and answers from educational materials. You are given a JSON array containing content blocks from a textbook page. Each block has an "id" field.

## CRITICAL RULE: ID-ONLY OUTPUT
**You MUST output ONLY block IDs (comma-separated numbers), NOT the actual text content.**
- ✅ CORRECT: <question>10,11,12</question>
- ❌ WRONG: <question>What is the square root of 16?</question>

The system will automatically retrieve the text using the IDs you provide.

## Your Tasks:
1. **Identify chapter/section titles** and output their block IDs in <title>...</title>.
2. **Identify math problems** (including examples like "例①", "例1", "Example 1") and output their block IDs in <question>...</question>.
3. **Identify solutions/answers** and output their block IDs in <solution>...</solution>.
4. **For very short answers** (like "Yes", "3.14", "A"), you MAY output the text directly in <answer>...</answer>.
5. **ONE QUESTION PER <qa_pair>**: Never merge multiple questions into a single <qa_pair> block.

## Consecutive ID Handling
- When a question or solution spans multiple consecutive blocks, include ALL consecutive IDs.
- Example: If a problem consists of blocks 10, 11, 12, 13, output "10,11,12,13" - DO NOT skip any IDs.
- Pay attention to equation blocks (type='equation') - they are often part of the surrounding text.

## Question Numbering Recognition
- Circled numbers ①②③④⑤⑥⑦⑧⑨⑩ are INDEPENDENT questions. Each starts a NEW <qa_pair>.
- Arabic numbers like 1. 2. 3. or 1) 2) 3) are also INDEPENDENT questions.
- ONLY (1)(2)(3) or (a)(b)(c) WITHIN a question are sub-questions that belong together.

## Chapter/Section Titles
- Always enclose qa pairs in a <chapter>...</chapter> block.
- <title>TITLE_ID</title> should contain the ID of the chapter title block.
- If there's no chapter title, use <title></title> (empty).

## Figures/Diagrams
- When a question/solution refers to a figure, include the image block's ID in the ID sequence.
- Image blocks have type "image" and contain "img_path" field.

## Output Format
If no qualifying content is found:
<empty></empty>

Otherwise:
<chapter><title>TITLE_ID</title>
<qa_pair><label>LABEL</label><question>QUESTION_IDS</question>
<answer>SHORT_ANSWER_TEXT</answer><solution>SOLUTION_IDS</solution></qa_pair>
</chapter>

## Example 1: Standard Questions
Input blocks:
[
  {"id": 7, "type": "text", "text": "Chapter 1: Square Roots"},
  {"id": 8, "type": "text", "text": "1. What is the square root of 16?"},
  {"id": 9, "type": "text", "text": "Solution: The square root of 16 is 4."}
]

✅ CORRECT Output:
<chapter><title>7</title>
<qa_pair><label>1</label><question>8</question>
<answer>4</answer><solution>9</solution></qa_pair>
</chapter>

❌ WRONG Output (contains free text instead of IDs):
<chapter><title>Chapter 1: Square Roots</title>
<qa_pair><label>1</label><question>What is the square root of 16?</question>
<answer>4</answer><solution>The square root of 16 is 4.</solution></qa_pair>
</chapter>

## Example 2: Multi-Block Question with Image
Input blocks:
[
  {"id": 10, "type": "text", "text": "一、选择题"},
  {"id": 11, "type": "text", "text": "① 如图, 直线 l 与正五边形 ABCDE 的两边 AB, AE 分别交于点 M, N,"},
  {"id": 12, "type": "image", "img_path": "images/fig1.jpg"},
  {"id": 13, "type": "text", "text": "则 ∠1 + ∠2 的度数是多少?"}
]

✅ CORRECT Output:
<chapter><title>10</title>
<qa_pair><label>1</label><question>11,12,13</question>
<answer></answer><solution></solution></qa_pair>
</chapter>

❌ WRONG Output (missing image ID):
<chapter><title>10</title>
<qa_pair><label>1</label><question>11,13</question>
<answer></answer><solution></solution></qa_pair>
</chapter>

## Example 3: Interleaved Example with Solution
Input blocks:
[
  {"id": 20, "type": "text", "text": "例① 计算 √16 的算术平方根."},
  {"id": 21, "type": "text", "text": "解: √16 = 4, 4 的算术平方根是 2,"},
  {"id": 22, "type": "text", "text": "所以 √16 的算术平方根是 2."}
]

✅ CORRECT Output:
<chapter><title></title>
<qa_pair><label>例1</label><question>20</question>
<answer>2</answer><solution>21,22</solution></qa_pair>
</chapter>

❌ WRONG Output (free text in question and solution):
<chapter><title></title>
<qa_pair><label>例1</label><question>计算 √16 的算术平方根.</question>
<answer>2</answer><solution>√16 = 4, 4 的算术平方根是 2, 所以 √16 的算术平方根是 2.</solution></qa_pair>
</chapter>

## Example 4: Multiple Separate Questions
Input blocks:
[
  {"id": 30, "type": "text", "text": "二、填空题"},
  {"id": 31, "type": "text", "text": "① √9 = ___"},
  {"id": 32, "type": "text", "text": "② √25 = ___"},
  {"id": 33, "type": "text", "text": "③ √49 = ___"}
]

✅ CORRECT Output (3 separate qa_pairs):
<chapter><title>30</title>
<qa_pair><label>1</label><question>31</question>
<answer></answer><solution></solution></qa_pair>
<qa_pair><label>2</label><question>32</question>
<answer></answer><solution></solution></qa_pair>
<qa_pair><label>3</label><question>33</question>
<answer></answer><solution></solution></qa_pair>
</chapter>

❌ WRONG Output (merging multiple questions):
<chapter><title>30</title>
<qa_pair><label>1</label><question>31,32,33</question>
<answer></answer><solution></solution></qa_pair>
</chapter>

## Special Cases
- **Definition text** without a problem number is NOT a problem - do not extract it.
- **Incomplete problems** that continue to the next chunk should be omitted.
- **Preserve original labels** like "例1", "习题3", "①" in the <label> field.

Please now process the provided JSON and output your result following the ID-ONLY rule strictly.`;

/**
 * VQA 提取提示词（备用方案）
 * 
 * 用于直接从页面图片提取题目和答案（当 ID-based 方案失败时使用）。
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
