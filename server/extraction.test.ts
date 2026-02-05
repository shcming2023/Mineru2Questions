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
  it("should extract Arabic numbers", () => {
    expect(normalizeTitle("第1章 代数")).toBe("1");
    expect(normalizeTitle("1.2 方程")).toBe("1.2");
  });

  it("should extract Chinese numbers", () => {
    expect(normalizeTitle("第一章 代数")).toBe("一");
    expect(normalizeTitle("六、选择题")).toBe("六");
  });

  it("should handle strict match mode", () => {
    expect(normalizeTitle("第一章 代数", true)).toBe("第一章代数");
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
