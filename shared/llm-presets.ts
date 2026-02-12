/**
 * 主流LLM API预设配置
 * 用户只需选择提供商和填入API Key即可使用
 * 
 * purpose 字段说明：
 * - vision_extract: 视觉语言模型，用于题目抽取（需要理解图片/公式）
 * - long_context: 长上下文模型，用于章节预处理（需要 100K+ 上下文窗口）
 * - general: 通用模型，可用于多种任务
 */

export type LLMPurpose = 'vision_extract' | 'long_context' | 'general';

export const PURPOSE_LABELS: Record<LLMPurpose, string> = {
  vision_extract: '视觉抽取',
  long_context: '长文本推理',
  general: '通用',
};

export interface LLMPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: Array<{
    id: string;
    name: string;
    description?: string;
    /** 推荐用途 */
    recommendedPurpose?: LLMPurpose;
  }>;
  defaultModel: string;
  defaultTimeout: number;
  defaultMaxWorkers: number;
  apiKeyPlaceholder: string;
  docsUrl: string;
  /** 该提供商主要适用的用途 */
  primaryPurpose?: LLMPurpose;
}

export const LLM_PRESETS: LLMPreset[] = [
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    primaryPurpose: 'vision_extract',
    models: [
      {
        id: 'Qwen/Qwen2.5-VL-72B-Instruct',
        name: 'Qwen2.5-VL-72B-Instruct',
        description: '通义千问2.5视觉语言模型72B参数版本,支持图文理解',
        recommendedPurpose: 'vision_extract'
      },
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen2.5-72B-Instruct',
        description: '通义千问2.5文本模型72B参数版本',
        recommendedPurpose: 'general'
      },
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        name: 'Qwen2.5-7B-Instruct',
        description: '通义千问2.5文本模型7B参数版本',
        recommendedPurpose: 'general'
      },
      {
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek-V3',
        description: 'DeepSeek第三代模型,671B参数',
        recommendedPurpose: 'general'
      },
      {
        id: 'deepseek-ai/DeepSeek-R1',
        name: 'DeepSeek-R1',
        description: 'DeepSeek推理模型,支持复杂推理任务',
        recommendedPurpose: 'general'
      }
    ],
    defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
    defaultTimeout: 300,
    defaultMaxWorkers: 5,
    apiKeyPlaceholder: '请输入SiliconFlow API Key (从 https://cloud.siliconflow.cn/account/ak 获取)',
    docsUrl: 'https://docs.siliconflow.cn/docs'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    primaryPurpose: 'vision_extract',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'OpenAI最新多模态模型,支持图文理解',
        recommendedPurpose: 'vision_extract'
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'GPT-4优化版本,速度更快',
        recommendedPurpose: 'general'
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: 'GPT-3.5优化版本,性价比高',
        recommendedPurpose: 'general'
      }
    ],
    defaultModel: 'gpt-4o',
    defaultTimeout: 300,
    defaultMaxWorkers: 5,
    apiKeyPlaceholder: '请输入OpenAI API Key (从 https://platform.openai.com/api-keys 获取)',
    docsUrl: 'https://platform.openai.com/docs'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    primaryPurpose: 'general',
    models: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        description: 'Anthropic最新模型,支持图文理解,200K上下文',
        recommendedPurpose: 'general'
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        description: 'Claude 3最强模型',
        recommendedPurpose: 'general'
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        description: 'Claude 3平衡版本',
        recommendedPurpose: 'general'
      }
    ],
    defaultModel: 'claude-3-5-sonnet-20241022',
    defaultTimeout: 300,
    defaultMaxWorkers: 5,
    apiKeyPlaceholder: '请输入Anthropic API Key (从 https://console.anthropic.com/ 获取)',
    docsUrl: 'https://docs.anthropic.com/'
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    primaryPurpose: 'long_context',
    models: [
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: '1M上下文窗口,适合长文本推理和章节预处理',
        recommendedPurpose: 'long_context'
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description: '1M上下文窗口,最强推理能力',
        recommendedPurpose: 'long_context'
      },
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        description: '快速多模态模型',
        recommendedPurpose: 'general'
      }
    ],
    defaultModel: 'gemini-2.5-flash',
    defaultTimeout: 300,
    defaultMaxWorkers: 3,
    apiKeyPlaceholder: '请输入 Google AI API Key (从 https://aistudio.google.com/apikey 获取)',
    docsUrl: 'https://ai.google.dev/docs'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    primaryPurpose: 'long_context',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek-V3',
        description: '128K上下文,适合长文本推理',
        recommendedPurpose: 'long_context'
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek-R1',
        description: '推理模型,适合复杂任务',
        recommendedPurpose: 'general'
      }
    ],
    defaultModel: 'deepseek-chat',
    defaultTimeout: 300,
    defaultMaxWorkers: 5,
    apiKeyPlaceholder: '请输入 DeepSeek API Key (从 https://platform.deepseek.com/ 获取)',
    docsUrl: 'https://platform.deepseek.com/api-docs'
  },
  {
    id: 'custom',
    name: '自定义API',
    baseUrl: '',
    models: [],
    defaultModel: '',
    defaultTimeout: 300,
    defaultMaxWorkers: 5,
    apiKeyPlaceholder: '请输入API Key',
    docsUrl: ''
  }
];

/**
 * 根据ID获取预设配置
 */
export function getPresetById(id: string): LLMPreset | undefined {
  return LLM_PRESETS.find(p => p.id === id);
}

/**
 * 获取所有预设提供商列表
 */
export function getAllPresets(): LLMPreset[] {
  return LLM_PRESETS;
}
