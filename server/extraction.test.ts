/**
 * 数学题目提取核心逻辑测试
 */

import { describe, expect, it } from "vitest";
import {
  convertMinerUContentList,
  idsToText,
  extractImagesFromIds,
  parseLLMOutput,
  normalizeTitle,
  normalizeLabel,
  convertCircledNumbers,
  getLabelKey,
  mergeQAPairs,
  generateResults,
  chunkContentBlocks,
  ConvertedBlock,
  ExtractedQAPair
} from "./extraction";

describe("MinerU Content List Conversion", () => {
  it("should convert basic text blocks", () => {
    const contentList = [
      { type: "text", text: "第一章 数学基础" },
      { type: "text", text: "1. 求解方程 x + 2 = 5" }
    ];
    
    const converted = convertMinerUContentList(contentList);
    
    expect(converted).toHaveLength(2);
    expect(converted[0]).toEqual({ id: 0, type: "text", text: "第一章 数学基础" });
    expect(converted[1]).toEqual({ id: 1, type: "text", text: "1. 求解方程 x + 2 = 5" });
  });

  it("should convert image blocks", () => {
    const contentList = [
      { type: "image", img_path: "images/fig1.jpg", image_caption: ["图1: 三角形"] }
    ];
    
    const converted = convertMinerUContentList(contentList);
    
    expect(converted).toHaveLength(1);
    expect(converted[0]).toEqual({
      id: 0,
      type: "image",
      img_path: "images/fig1.jpg",
      image_caption: "图1: 三角形"
    });
  });

  it("should flatten list items", () => {
    const contentList = [
      { type: "list", sub_type: "text", list_items: ["A. 选项1", "B. 选项2", "C. 选项3"] }
    ];
    
    const converted = convertMinerUContentList(contentList);
    
    expect(converted).toHaveLength(3);
    expect(converted[0]).toEqual({ id: 0, type: "text", text: "A. 选项1" });
    expect(converted[1]).toEqual({ id: 1, type: "text", text: "B. 选项2" });
    expect(converted[2]).toEqual({ id: 2, type: "text", text: "C. 选项3" });
  });
});

describe("ID to Text Conversion", () => {
  const blocks: ConvertedBlock[] = [
    { id: 0, type: "text", text: "第一章" },
    { id: 1, type: "text", text: "求解方程" },
    { id: 2, type: "image", img_path: "images/fig1.jpg", image_caption: "图1" },
    { id: 3, type: "text", text: "x + 2 = 5" }
  ];

  it("should convert single ID to text", () => {
    const result = idsToText("1", blocks);
    expect(result).toBe("求解方程");
  });

  it("should convert multiple IDs to text", () => {
    const result = idsToText("1,3", blocks);
    // 优化3: 智能拼接 - 短内容用空格连接
    expect(result).toBe("求解方程 x + 2 = 5");
  });

  it("should handle image blocks", () => {
    const result = idsToText("2", blocks, "images");
    expect(result).toBe("![图1](images/fig1.jpg)");
  });

  it("should handle invalid IDs gracefully", () => {
    const result = idsToText("99,1", blocks);
    expect(result).toBe("求解方程");
  });
});

describe("Image Extraction from IDs", () => {
  const blocks: ConvertedBlock[] = [
    { id: 0, type: "text", text: "题目" },
    { id: 1, type: "image", img_path: "images/fig1.jpg" },
    { id: 2, type: "text", text: "答案" },
    { id: 3, type: "image", img_path: "images/fig2.jpg" }
  ];

  it("should extract image paths from IDs", () => {
    const images = extractImagesFromIds("0,1,2,3", blocks);
    expect(images).toEqual(["images/fig1.jpg", "images/fig2.jpg"]);
  });

  it("should return empty array for text-only IDs", () => {
    const images = extractImagesFromIds("0,2", blocks);
    expect(images).toEqual([]);
  });
});

describe("LLM Output Parsing", () => {
  const blocks: ConvertedBlock[] = [
    { id: 0, type: "text", text: "第一章 代数" },
    { id: 1, type: "text", text: "求解方程 x + 2 = 5" },
    { id: 2, type: "text", text: "解: x = 3" }
  ];

  it("should parse empty output", () => {
    const result = parseLLMOutput("<empty></empty>", blocks);
    expect(result).toEqual([]);
  });

  it("should parse single QA pair", () => {
    const llmOutput = `<chapter><title>0</title>
<qa_pair><label>1</label><question>1</question>
<answer>3</answer><solution>2</solution></qa_pair>
</chapter>`;
    
    const result = parseLLMOutput(llmOutput, blocks);
    
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("1");
    expect(result[0].question).toBe("求解方程 x + 2 = 5");
    expect(result[0].answer).toBe("3");
    expect(result[0].solution).toBe("解: x = 3");
    expect(result[0].chapter_title).toBe("第一章 代数");
  });

  it("should parse multiple QA pairs", () => {
    const llmOutput = `<chapter><title>0</title>
<qa_pair><label>1</label><question>1</question>
<answer>3</answer><solution></solution></qa_pair>
<qa_pair><label>2</label><question>2</question>
<answer></answer><solution></solution></qa_pair>
</chapter>`;
    
    const result = parseLLMOutput(llmOutput, blocks);
    
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("1");
    expect(result[1].label).toBe("2");
  });
});

describe("Title Normalization", () => {
  it("should preserve chapter context for better distinction", () => {
    // 优化: 保留更多上下文信息,避免不同章节被规范化为相同的值
    expect(normalizeTitle("第1章 代数")).toBe("第1章");
    expect(normalizeTitle("第1单元 加法")).toBe("第1单元");
    // 非章节标题保留完整内容
    expect(normalizeTitle("1.2 方程")).toBe("1.2方程");
  });

  it("should preserve Chinese chapter context", () => {
    expect(normalizeTitle("第一章 代数")).toBe("第一章");
    expect(normalizeTitle("第一单元 加法")).toBe("第一单元");
    // 练习标题
    expect(normalizeTitle("练习一")).toBe("练习一");
    // 非章节标题保留完整内容
    expect(normalizeTitle("六、选择题")).toBe("六、选择题");
  });

  it("should handle strict match mode", () => {
    expect(normalizeTitle("第一章 代数", true)).toBe("第一章代数");
  });
  
  it("should truncate long titles", () => {
    const longTitle = "这是一个非常长的标题用于测试截断功能是否正常工作并且不会导致问题";
    // P2修复: 截断阈值从30放宽到50
    expect(normalizeTitle(longTitle).length).toBeLessThanOrEqual(50);
  });
});

describe("Label Normalization", () => {
  it("should extract numbers from labels", () => {
    expect(normalizeLabel("1")).toBe(1);
    expect(normalizeLabel("例1")).toBe(1);
    expect(normalizeLabel("习题12")).toBe(12);
    expect(normalizeLabel("三、16")).toBe(16);
  });

  it("should return null for invalid labels", () => {
    expect(normalizeLabel("无")).toBeNull();
    expect(normalizeLabel("")).toBeNull();
  });
});

describe("QA Pair Merging", () => {
  it("should merge questions with answers", () => {
    const questions: ExtractedQAPair[] = [
      { label: "1", question: "求解 x + 2 = 5", answer: "", solution: "", chapter_title: "第1章", images: [] }
    ];
    
    const answers: ExtractedQAPair[] = [
      { label: "1", question: "", answer: "3", solution: "x = 5 - 2 = 3", chapter_title: "第1章", images: [] }
    ];
    
    const merged = mergeQAPairs(questions, answers);
    
    expect(merged).toHaveLength(1);
    expect(merged[0].question).toBe("求解 x + 2 = 5");
    expect(merged[0].answer).toBe("3");
    expect(merged[0].solution).toBe("x = 5 - 2 = 3");
  });

  it("should keep complete QA pairs from questions", () => {
    const questions: ExtractedQAPair[] = [
      { label: "1", question: "求解 x + 2 = 5", answer: "3", solution: "解: x = 3", chapter_title: "第1章", images: [] }
    ];
    
    const merged = mergeQAPairs(questions, []);
    
    expect(merged).toHaveLength(1);
    expect(merged[0].answer).toBe("3");
  });
});

describe("Result Generation", () => {
  it("should generate JSON and Markdown output", () => {
    const qaPairs = [
      {
        label: 1,
        question_chapter_title: "第1章",
        answer_chapter_title: "第1章",
        question: "求解 x + 2 = 5",
        answer: "3",
        solution: "x = 5 - 2 = 3",
        images: ["fig1.jpg"]
      }
    ];
    
    const { json, markdown } = generateResults(qaPairs);
    
    expect(json).toHaveLength(1);
    expect(json[0].label).toBe(1);
    expect(json[0].question).toBe("求解 x + 2 = 5");
    
    expect(markdown).toContain("# 提取的数学题目");
    expect(markdown).toContain("求解 x + 2 = 5");
    expect(markdown).toContain("**答案:** 3");
  });
});

describe("Content Block Chunking with Overlap", () => {
  it("should create chunks with overlap", () => {
    // 创建足够多的内容块来触发分块
    const blocks: ConvertedBlock[] = [];
    for (let i = 0; i < 100; i++) {
      blocks.push({
        id: i,
        type: "text",
        text: `这是第${i}个内容块，包含一些数学题目内容。` + "x".repeat(1000)
      });
    }
    
    // 使用较小的maxChunkLen来触发分块
    const chunks = chunkContentBlocks(blocks, 10000, 5);
    
    // 应该创建多个chunk
    expect(chunks.length).toBeGreaterThan(1);
    
    // 检查overlap: 第二个chunk的开头应该包含第一个chunk的结尾块
    if (chunks.length >= 2) {
      const firstChunkEnd = chunks[0].slice(-5);
      const secondChunkStart = chunks[1].slice(0, 5);
      
      // 第二个chunk的开头应该包含第一个chunk结尾的块
      const firstChunkEndIds = firstChunkEnd.map(b => b.id);
      const secondChunkStartIds = secondChunkStart.map(b => b.id);
      
      // 检查是否有重叠
      const hasOverlap = firstChunkEndIds.some(id => secondChunkStartIds.includes(id));
      expect(hasOverlap).toBe(true);
    }
  });

  it("should handle small content without chunking", () => {
    const blocks: ConvertedBlock[] = [
      { id: 0, type: "text", text: "第一章" },
      { id: 1, type: "text", text: "题目1" }
    ];
    
    const chunks = chunkContentBlocks(blocks, 100000, 5);
    
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });
});

// 测试圆圈数字转换
describe('convertCircledNumbers', () => {
  it('should convert circled numbers to Arabic numbers', () => {
    expect(convertCircledNumbers('①')).toBe('1');
    expect(convertCircledNumbers('②')).toBe('2');
    expect(convertCircledNumbers('⑩')).toBe('10');
    expect(convertCircledNumbers('⑳')).toBe('20');
  });

  it('should convert multiple circled numbers in text', () => {
    expect(convertCircledNumbers('①②③')).toBe('123');
    expect(convertCircledNumbers('题目①和题目②')).toBe('题目1和题目2');
  });

  it('should not change text without circled numbers', () => {
    expect(convertCircledNumbers('123')).toBe('123');
    expect(convertCircledNumbers('题目1')).toBe('题目1');
  });
});

// 测试normalizeLabel对圆圈数字的支持
describe('normalizeLabel with circled numbers', () => {
  it('should normalize circled number labels', () => {
    expect(normalizeLabel('①')).toBe(1);
    expect(normalizeLabel('②')).toBe(2);
    expect(normalizeLabel('⑩')).toBe(10);
  });

  it('should normalize mixed labels', () => {
    expect(normalizeLabel('例①')).toBe(1);
    expect(normalizeLabel('题目②')).toBe(2);
  });
});

// 测试getLabelKey对圆圈数字的支持
describe('getLabelKey with circled numbers', () => {
  it('should convert circled numbers in label key', () => {
    expect(getLabelKey('①')).toBe('1');
    expect(getLabelKey('②')).toBe('2');
    expect(getLabelKey('例①')).toBe('1');
  });
});


// 测试Fallback拆分器
import { splitMultiQuestionFallback } from "./extraction";

describe('splitMultiQuestionFallback', () => {
  it('should extract questions with numbered format', () => {
    const blocks: ConvertedBlock[] = [
      { id: 0, type: 'text', text: '第19章 实数' },
      { id: 1, type: 'text', text: '1. 求解方程 x + 2 = 5' },
      { id: 2, type: 'text', text: '解: x = 3' },
      { id: 3, type: 'text', text: '2. 计算 3 × 4 的值' },
    ];
    
    const results = splitMultiQuestionFallback(blocks, 0);
    
    expect(results.length).toBe(2);
    expect(results[0].label).toBe('1');
    expect(results[0].question).toContain('求解方程');
    expect(results[0].chapter_title).toBe('第19章 实数');
    expect(results[1].label).toBe('2');
    expect(results[1].chapter_title).toBe('第19章 实数');
  });

  it('should extract questions with circled numbers', () => {
    const blocks: ConvertedBlock[] = [
      { id: 0, type: 'text', text: '第20章 二次根式' },
      { id: 1, type: 'text', text: '① 化简 √4 的值等于多少' },
      { id: 2, type: 'text', text: '这是第一题的继续内容' },
      { id: 3, type: 'text', text: '② 计算 √9 + √16 的结果' },
      { id: 4, type: 'text', text: '这是第二题的继续内容' },
    ];
    
    const results = splitMultiQuestionFallback(blocks, 0);
    
    // 第一题和第二题都应该被提取
    expect(results.length).toBe(2);
    expect(results[0].label).toBe('1');
    expect(results[0].chapter_title).toBe('第20章 二次根式');
    expect(results[1].label).toBe('2');
  });

  it('should filter out table of contents entries', () => {
    const blocks: ConvertedBlock[] = [
      { id: 0, type: 'text', text: '第19章 实数' },
      { id: 1, type: 'text', text: '1. 这是一道真正的题目内容较长' },
      { id: 2, type: 'text', text: '题目的继续内容包含更多信息' },
    ];
    
    const results = splitMultiQuestionFallback(blocks, 0);
    
    // 应该提取真正的题目
    expect(results.length).toBe(1);
    expect(results[0].question).toContain('真正的题目');
    expect(results[0].chapter_title).toBe('第19章 实数');
  });

  it('should handle Chinese number format', () => {
    const blocks: ConvertedBlock[] = [
      { id: 0, type: 'text', text: '一、选择题（每题分2分）' },
      { id: 1, type: 'text', text: '这是选择题的内容和选项' },
      { id: 2, type: 'text', text: '二、填空题（每题分3分）' },
      { id: 3, type: 'text', text: '这是填空题的内容' },
    ];
    
    const results = splitMultiQuestionFallback(blocks, 0);
    
    expect(results.length).toBe(2);
    expect(results[0].label).toBe('一');
    expect(results[1].label).toBe('二');
  });

  it('should track chapter changes', () => {
    const blocks: ConvertedBlock[] = [
      { id: 0, type: 'text', text: '第19章 实数' },
      { id: 1, type: 'text', text: '1. 第一章的题目内容较长' },
      { id: 2, type: 'text', text: '题目的继续内容' },
      { id: 3, type: 'text', text: '第20章 二次根式' },
      { id: 4, type: 'text', text: '2. 第二章的题目内容较长' },
      { id: 5, type: 'text', text: '题目的继续内容' },
    ];
    
    const results = splitMultiQuestionFallback(blocks, 0);
    
    expect(results.length).toBe(2);
    expect(results[0].chapter_title).toBe('第19章 实数');
    expect(results[1].chapter_title).toBe('第20章 二次根式');
  });
});
