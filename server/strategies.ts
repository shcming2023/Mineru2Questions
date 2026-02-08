import { ConvertedBlock } from "./extraction";

// ============= Configurable Strategy Pattern =============

export type StrategyContext = {
  text: string;
  block?: ConvertedBlock;
  metadata?: Record<string, any>;
};

export type StrategyResult = {
  score: number; // 0..1
  action: 'keep' | 'drop' | 'transform' | 'split' | 'found';
  value?: string | number; // Transformed value or split index
  reason: string;
};

export interface Strategy {
  name: string;
  apply: (ctx: StrategyContext) => StrategyResult;
  threshold: number;
  fallback?: string; // Name of next strategy
}

// Configurable Chain Executor
export class StrategyChain {
  private strategies: Map<string, Strategy> = new Map();

  constructor(initialStrategies: Strategy[] = []) {
    initialStrategies.forEach(s => this.register(s));
  }

  register(strategy: Strategy) {
    this.strategies.set(strategy.name, strategy);
  }

  execute(strategyName: string, ctx: StrategyContext): StrategyResult {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      return { score: 0, action: 'keep', reason: `Strategy ${strategyName} not found` };
    }

    try {
      const result = strategy.apply(ctx);
      if (result.score >= strategy.threshold) {
        return result;
      }
      
      if (strategy.fallback) {
        return this.execute(strategy.fallback, ctx);
      }

      return result;
    } catch (error: any) {
      return { score: 0, action: 'keep', reason: `Error in ${strategyName}: ${error.message}` };
    }
  }
}

// ============= Default Configurations =============

// 1. Chapter Title Filters (QualityGate)
export const DEFAULT_TITLE_FILTERS: Strategy[] = [
  {
    name: "section_marker_filter",
    threshold: 1,
    apply: (ctx) => {
      const patterns = [
        /^名校考题精选/, /^各区考题精选/, /^挑战压轴题/, /^思维与拓展/,
        /^本期导读/, /^本学期将学习/, /^[一二三四五六七八九十]+、(选择|填空|解答|计算|应用|证明)题/
      ];
      const match = patterns.some(p => p.test(ctx.text.trim()));
      return {
        score: match ? 1 : 0,
        action: match ? 'drop' : 'keep',
        reason: match ? 'Matched section marker' : 'No match'
      };
    },
    fallback: "length_filter"
  },
  {
    name: "length_filter",
    threshold: 1,
    apply: (ctx) => ({
      score: ctx.text.length > 100 ? 1 : 0,
      action: ctx.text.length > 100 ? 'drop' : 'keep',
      reason: 'Title too long'
    })
  }
];

// 2. Answer Section Detection (CandidateBuilder)
export const DEFAULT_ANSWER_DETECTION: Strategy[] = [
  {
    name: "explicit_header_match",
    threshold: 1,
    apply: (ctx) => {
      const answerPatterns = [
        /^附\s*录/, /^参考答案/, /^习题答案/, /^答\s*案/, /^解\s*答/,
        /^Appendix/i, /^Answer\s*Key/i, /^Solutions?/i
      ];
      const match = answerPatterns.some(p => p.test(ctx.text.trim()));
      return {
        score: match ? 1 : 0,
        action: match ? 'found' : 'keep',
        reason: match ? 'Matched answer header' : 'No match'
      };
    },
    fallback: "short_header_match"
  },
  {
    name: "short_header_match",
    threshold: 1,
    apply: (ctx) => {
       // Check if text is short (<20 chars) AND matches pattern (reusing logic for now, but could be distinct)
       // Original logic: if (text.length < 20) { match patterns }
       if (ctx.text.length >= 20) {
           return { score: 0, action: 'keep', reason: 'Text too long for heuristic' };
       }
       const answerPatterns = [
        /^附\s*录/, /^参考答案/, /^习题答案/, /^答\s*案/, /^解\s*答/,
        /^Appendix/i, /^Answer\s*Key/i, /^Solutions?/i
       ];
       const match = answerPatterns.some(p => p.test(ctx.text.trim()));
       return {
        score: match ? 1 : 0,
        action: match ? 'found' : 'keep',
        reason: match ? 'Matched short header' : 'No match'
       };
    }
  }
];

// 3. Solution Validation (QualityGate)
export const DEFAULT_SOLUTION_VALIDATION: Strategy[] = [
  {
    name: "keyword_block_filter",
    threshold: 1,
    apply: (ctx) => {
      if (!ctx.text || !ctx.text.trim()) {
        return { score: 1, action: 'drop', reason: 'Empty solution' };
      }
      // DataFlow官方的过滤规则 + 扩展
      const blockKeywords = ['Law:', 'Error:', 'Invalid:'];
      const match = blockKeywords.some(k => ctx.text.includes(k));
      return {
        score: match ? 1 : 0,
        action: match ? 'drop' : 'keep',
        reason: match ? 'Contains blocked keyword' : 'Valid'
      };
    }
  }
];

// 4. Noise Entry Filters (QualityGate)
export const DEFAULT_NOISE_FILTERS: Strategy[] = [
  {
    name: "publication_info_filter",
    threshold: 1,
    apply: (ctx) => {
      const patterns = [/ISBN\s*\d/, /CIP数据/, /出版说明/, /责任编辑/];
      const match = patterns.some(p => p.test(ctx.text));
      return {
        score: match ? 1 : 0,
        action: match ? 'drop' : 'keep',
        reason: match ? 'Matched publication info' : 'Valid'
      };
    }
  },
  {
    name: "toc_filter",
    threshold: 1,
    apply: (ctx) => {
      // 目录特征
      if (ctx.text.startsWith('目录')) return { score: 1, action: 'drop', reason: 'Starts with 目录' };
      if (/^第\d+章/.test(ctx.text) && ctx.text.length < 50) return { score: 1, action: 'drop', reason: 'Short chapter title like text' };
      return { score: 0, action: 'keep', reason: 'Valid' };
    }
  },
  {
    name: "fragment_filter",
    threshold: 1,
    apply: (ctx) => {
      // chapter_title为空且题目很短(可能是碎片)
      const chapterTitle = ctx.metadata?.chapter_title;
      if (!chapterTitle && ctx.text.length < 20) {
        return { score: 1, action: 'drop', reason: 'Short fragment without chapter' };
      }
      return { score: 0, action: 'keep', reason: 'Valid' };
    }
  }
];
