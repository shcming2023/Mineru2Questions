export type StrategyAction = "keep" | "drop" | "found";

export interface StrategyContext {
  text?: string;
  [key: string]: unknown;
}

export interface StrategyResult {
  action: StrategyAction;
  score?: number;
  reason?: string;
}

export type StrategyFn = (context: StrategyContext) => StrategyResult;

export interface StrategyDefinition {
  name: string;
  run: StrategyFn;
  fallback?: string;
}

export type StrategyMap = Record<string, StrategyDefinition>;

const TITLE_MAX_LENGTH = 100;
const SHORT_HEADER_MAX_LENGTH = 40;

const EXPLICIT_ANSWER_HEADER_PATTERN =
  /(参考答案|答案|解答|Answer\s*Key)/i;

export class StrategyChain {
  private readonly strategies: StrategyMap;

  constructor(strategies: StrategyMap) {
    this.strategies = strategies;
  }

  execute(strategyName: string, context: StrategyContext): StrategyResult {
    const visited = new Set<string>();
    let current: string | undefined = strategyName;
    let lastResult: StrategyResult | null = null;

    while (current) {
      if (visited.has(current)) {
        break;
      }
      visited.add(current);

      const definition: StrategyDefinition | undefined =
        this.strategies[current];
      if (!definition) {
        break;
      }

      const result = definition.run(context);
      lastResult = result;

      if (result.action !== "keep" || !definition.fallback) {
        return result;
      }

      current = definition.fallback;
    }

    return lastResult ?? { action: "keep" };
  }
}

export const DEFAULT_TITLE_FILTERS: StrategyMap = {
  section_marker_filter: {
    name: "section_marker_filter",
    run: context => {
      const text = String(context.text ?? "").trim();
      if (!text) {
        return { action: "keep" };
      }

      const sectionPattern =
        /^(一、|二、|三、|四、|五、|六、|七、|八、|九、|十、)(选择题|填空题|判断题|解答题|综合题|本章小结|复习题)/;

      if (sectionPattern.test(text)) {
        return { action: "drop", score: 1, reason: "Section marker" };
      }

      return { action: "keep" };
    },
    fallback: "length_filter",
  },
  length_filter: {
    name: "length_filter",
    run: context => {
      const text = String(context.text ?? "").trim();
      if (text.length > TITLE_MAX_LENGTH) {
        return { action: "drop", reason: "Title too long" };
      }
      return { action: "keep" };
    },
  },
};

export const DEFAULT_ANSWER_DETECTION: StrategyMap = {
  explicit_header_match: {
    name: "explicit_header_match",
    run: context => {
      const raw = context.text;
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) {
        return { action: "keep" };
      }

      if (EXPLICIT_ANSWER_HEADER_PATTERN.test(text)) {
        return { action: "found", score: 1 };
      }

      return { action: "keep" };
    },
    fallback: "short_header_match",
  },
  short_header_match: {
    name: "short_header_match",
    run: context => {
      const raw = context.text;
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) {
        return { action: "keep" };
      }

      if (text.length > SHORT_HEADER_MAX_LENGTH) {
        return { action: "keep", reason: "Text too long for heuristic" };
      }

      if (EXPLICIT_ANSWER_HEADER_PATTERN.test(text)) {
        return { action: "found", score: 0.8 };
      }

      return { action: "keep" };
    },
  },
};
