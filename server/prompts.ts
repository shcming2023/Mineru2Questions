/**
 * LLM 提示词模板 (v1.1 - 聚焦高质量题目提取)
 * 
 * 对齐 PRD v1.1 和 DataFlow 官方流水线的 QAExtractPrompt。
 * 
 * 核心改进：
 * 1. 移除远距离答案相关指令，聚焦题目提取
 * 2. 强化图片ID连续性强调（P0优先级）
 * 3. 增加题目类型识别（例题 vs 练习题）
 * 4. 保留近距离答案提取能力（仅对例题）
 * 5. 严格执行 ID-Only 原则
 */

/**
 * 题目提取提示词（强化版 ID-Only + 图片连续性）
 * 
 * 用于从 MinerU 解析的 content_list.json 中抽取题目。
 */
export const QUESTION_EXTRACT_PROMPT = `You are an expert in extracting questions from educational materials. You are given a JSON array containing content blocks from a textbook page. Each block has an "id" field.

## ═══════════════════════════════════════════════════════════════
## CRITICAL RULE 1: ID-ONLY OUTPUT
## ═══════════════════════════════════════════════════════════════

**You MUST output ONLY block IDs (comma-separated numbers), NOT the actual text content.**

✅ CORRECT: <question>10,11,12</question>
❌ WRONG: <question>What is the square root of 16?</question>

The system will automatically retrieve the text using the IDs you provide.

## ═══════════════════════════════════════════════════════════════
## CRITICAL RULE 2: INCLUDE ALL CONSECUTIVE BLOCKS (ESPECIALLY IMAGES)
## ═══════════════════════════════════════════════════════════════

**When a question spans multiple consecutive blocks, you MUST include ALL IDs in sequence.**
**DO NOT skip any block, especially image blocks (type='image') and equation blocks (type='equation').**

✅ CORRECT: <question>45,46,47,48</question>  <!-- includes text + image + text -->
❌ WRONG: <question>45,47,48</question>       <!-- MISSING image block 46 -->

### Why This Matters:
- Many questions contain embedded images or diagrams that are essential to understanding the problem.
- Skipping an image block will result in an incomplete, unusable question.
- The system relies on YOU to identify the correct sequence of IDs.

### How to Identify Consecutive Blocks:
1. Look at the "id" field: consecutive IDs like 45, 46, 47, 48 likely belong together.
2. Check the "type" field: 
   - type="text": regular text content
   - type="image": figure, diagram, or photo
   - type="equation": mathematical formula
3. If a text block is followed by an image, then more text, they are likely part of the same question.

## ═══════════════════════════════════════════════════════════════
## Your Tasks:
## ═══════════════════════════════════════════════════════════════

1. **Identify chapter/section titles** and output their block IDs in <title>...</title>.
   - A valid title MUST be a numbered chapter/section heading (e.g., "19.1 平方根", "第1章 全等三角形").
   - **Parent Chapter Association**: If you encounter a section title (like "基础训练", "本章复习题") and a parent chapter title (like "19.1 平方根") is available in the context (blocks before it), you should combine them. Use the ID of the parent chapter title.
   - Example: If block 10 is "19.1" and block 50 is "基础训练", the chapter block for "基础训练" questions should use <title>10</title>.
2. **Identify question types**:
   - **Examples** (例题): labeled with "例", "例1", "例①", "Example 1", etc. → <type>example</type>
   - **Exercises** (练习题): labeled with "1.", "①", "习题3", "Exercise 2", etc. → <type>exercise</type>
3. **Identify math problems** and output their block IDs in <question>...</question>.
4. **For examples ONLY**: If a solution immediately follows (within ~5 blocks), output its IDs in <solution>...</solution>.
5. **ONE QUESTION PER <qa_pair>**: Never merge multiple questions into a single <qa_pair> block.

## ═══════════════════════════════════════════════════════════════
## Question Numbering Recognition
## ═══════════════════════════════════════════════════════════════

- Circled numbers ①②③④⑤⑥⑦⑧⑨⑩ are INDEPENDENT questions. Each starts a NEW <qa_pair>.
- Arabic numbers like 1. 2. 3. or 1) 2) 3) are also INDEPENDENT questions.
- ONLY (1)(2)(3) or (a)(b)(c) WITHIN a question are sub-questions that belong together.

## ═══════════════════════════════════════════════════════════════
## Chapter/Section Titles
## ═══════════════════════════════════════════════════════════════

- Always enclose qa pairs in a <chapter>...</chapter> block.
- <title>TITLE_ID</title> should contain the ID of the chapter title block.
- If there's no chapter title, use <title></title> (empty).

## ═══════════════════════════════════════════════════════════════
## Output Format
## ═══════════════════════════════════════════════════════════════

If no qualifying content is found:
<empty></empty>

Otherwise:
<chapter><title>TITLE_ID</title>
<qa_pair><label>LABEL</label><type>TYPE</type><question>QUESTION_IDS</question>
<solution>SOLUTION_IDS</solution></qa_pair>
</chapter>

If the content spans multiple chapters (e.g., ends Chapter 1 and starts Chapter 2), output multiple <chapter> blocks:
<chapter><title>ID_1</title>...</chapter>
<chapter><title>ID_2</title>...</chapter>

## ═══════════════════════════════════════════════════════════════
## Example 1: Exercise Question with Image
## ═══════════════════════════════════════════════════════════════

Input blocks:
[
  {"id": 10, "type": "text", "text": "一、选择题"},
  {"id": 11, "type": "text", "text": "① 如图, 直线 l 与正五边形 ABCDE 的两边 AB, AE 分别交于点 M, N,"},
  {"id": 12, "type": "image", "img_path": "images/fig1.jpg"},
  {"id": 13, "type": "text", "text": "则 ∠1 + ∠2 的度数是多少?"}
]

✅ CORRECT Output:
<chapter><title>10</title>
<qa_pair><label>1</label><type>exercise</type><question>11,12,13</question>
<solution></solution></qa_pair>
</chapter>

❌ WRONG Output (missing image ID 12):
<chapter><title>10</title>
<qa_pair><label>1</label><type>exercise</type><question>11,13</question>
<solution></solution></qa_pair>
</chapter>

## ═══════════════════════════════════════════════════════════════
## Example 2: Example Question with Near-Distance Solution
## ═══════════════════════════════════════════════════════════════

Input blocks:
[
  {"id": 20, "type": "text", "text": "例① 计算 √16 的算术平方根."},
  {"id": 21, "type": "text", "text": "解: √16 = 4, 4 的算术平方根是 2,"},
  {"id": 22, "type": "text", "text": "所以 √16 的算术平方根是 2."}
]

✅ CORRECT Output:
<chapter><title></title>
<qa_pair><label>例1</label><type>example</type><question>20</question>
<solution>21,22</solution></qa_pair>
</chapter>

❌ WRONG Output (free text instead of IDs):
<chapter><title></title>
<qa_pair><label>例1</label><type>example</type><question>计算 √16 的算术平方根.</question>
<solution>√16 = 4, 4 的算术平方根是 2, 所以 √16 的算术平方根是 2.</solution></qa_pair>
</chapter>

## ═══════════════════════════════════════════════════════════════
## Example 3: Multiple Separate Questions
## ═══════════════════════════════════════════════════════════════

Input blocks:
[
  {"id": 30, "type": "text", "text": "二、填空题"},
  {"id": 31, "type": "text", "text": "① √9 = ___"},
  {"id": 32, "type": "text", "text": "② √25 = ___"},
  {"id": 33, "type": "text", "text": "③ √49 = ___"}
]

✅ CORRECT Output (3 separate qa_pairs):
<chapter><title>30</title>
<qa_pair><label>1</label><type>exercise</type><question>31</question>
<solution></solution></qa_pair>
<qa_pair><label>2</label><type>exercise</type><question>32</question>
<solution></solution></qa_pair>
<qa_pair><label>3</label><type>exercise</type><question>33</question>
<solution></solution></qa_pair>
</chapter>

❌ WRONG Output (merging multiple questions):
<chapter><title>30</title>
<qa_pair><label>1</label><type>exercise</type><question>31,32,33</question>
<solution></solution></qa_pair>
</chapter>

## ═══════════════════════════════════════════════════════════════
## Example 4: Complex Question with Multiple Images and Equations
## ═══════════════════════════════════════════════════════════════

Input blocks:
[
  {"id": 40, "type": "text", "text": "① 如图所示,"},
  {"id": 41, "type": "image", "img_path": "images/fig2.jpg"},
  {"id": 42, "type": "text", "text": "已知"},
  {"id": 43, "type": "equation", "latex": "a^2 + b^2 = c^2"},
  {"id": 44, "type": "text", "text": "求 c 的值."}
]

✅ CORRECT Output (includes ALL consecutive IDs):
<chapter><title></title>
<qa_pair><label>1</label><type>exercise</type><question>40,41,42,43,44</question>
<solution></solution></qa_pair>
</chapter>

❌ WRONG Output (skipping image and equation):
<chapter><title></title>
<qa_pair><label>1</label><type>exercise</type><question>40,42,44</question>
<solution></solution></qa_pair>
</chapter>

## ═══════════════════════════════════════════════════════════════
## Special Cases
## ═══════════════════════════════════════════════════════════════

- **Definition text** without a problem number is NOT a problem - do not extract it.
- **Incomplete problems** that continue to the next chunk should be omitted.
- **Preserve original labels** like "例1", "习题3", "①" in the <label> field.
- **For exercises**: Leave <solution> empty (we don't extract far-distance answers).
- **For examples**: Only extract solution if it immediately follows the question (within ~5 blocks).

## ═══════════════════════════════════════════════════════════════
## Final Reminder: CHECK YOUR OUTPUT
## ═══════════════════════════════════════════════════════════════

Before submitting your output, verify:
1. ✅ All <question> and <solution> fields contain ONLY IDs (comma-separated numbers)
2. ✅ No image blocks are skipped in the ID sequence
3. ✅ Each independent question has its own <qa_pair> block
4. ✅ <type> is correctly set to "example" or "exercise"
5. ✅ <label> preserves the original question number

Please now process the provided JSON and output your result following these rules strictly.`;

/**
 * VQA 提取提示词（备用方案）
 * 
 * 用于直接从页面图片提取题目（当 ID-based 方案失败时使用）。
 * 注意：此方案仅用于容错，不是主要流程。
 */
export const VQA_EXTRACT_PROMPT = `You are an expert in math education. You are given an image of a textbook page annotated with detected bounding boxes and labels. Your task is to extract:

1. All math problems whose text begins on this page.
2. If a problem is incomplete (continues to next page), omit it.
3. A box at the beginning of a page with no problem number is likely continuation from previous page - omit it.
4. The chapter information as it appears on the page. Include all titles even if no questions are present under them.

## Strict Rules:

### About Questions:
- If the page is not main text (cover, catalog, header/footer only), output <empty></empty>.
- Preserve original labels like "例1", "Example 3", "习题1". Use Arabic numerals only.
- If multiple sub-questions exist under one main question, put them in the same <qa_pair> block.
- Identify question type: "example" or "exercise".

### About Chapter Titles:
- Enclose output in <chapter>...</chapter> blocks with <title>MAIN_TITLE</title>.
- Extract chapter titles only, no prefix numbers. Do not keep subtitles.
- If a title has no problems on the page, still extract it with label 0.

### About Figures:
- For figures/diagrams, record with <pic>tagA:boxB</pic> using the RED labeled tags in the image.
- Put <pic> tags at exact positions where figures are referenced.

## Output Format:
<chapter><title>MAIN_TITLE</title>
<qa_pair><label>...</label><type>TYPE</type><question>QUESTION_TEXT<pic>...</pic></question></qa_pair>
</chapter>

If no content found: <empty></empty>`;
