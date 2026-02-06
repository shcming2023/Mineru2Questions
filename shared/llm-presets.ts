/**
 * 主流LLM API预设配置
 * 用户只需选择提供商和填入API Key即可使用
 */

export interface LLMPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  defaultModel: string;
  defaultTimeout: number;
  defaultMaxWorkers: number;
  apiKeyPlaceholder: string;
  docsUrl: string;
}

export const LLM_PRESETS: LLMPreset[] = [
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    models: [
      {
        id: 'Qwen/Qwen2.5-VL-72B-Instruct',
        name: 'Qwen2.5-VL-72B-Instruct',
        description: '通义千问2.5视觉语言模型72B参数版本,支持图文理解'
      },
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen2.5-72B-Instruct',
        description: '通义千问2.5文本模型72B参数版本'
      },
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        name: 'Qwen2.5-7B-Instruct',
        description: '通义千问2.5文本模型7B参数版本'
      },
      {
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek-V3',
        description: 'DeepSeek第三代模型,671B参数'
      },
      {
        id: 'deepseek-ai/DeepSeek-R1',
        name: 'DeepSeek-R1',
        description: 'DeepSeek推理模型,支持复杂推理任务'
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
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'OpenAI最新多模态模型,支持图文理解'
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'GPT-4优化版本,速度更快'
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: 'GPT-3.5优化版本,性价比高'
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
    models: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        description: 'Anthropic最新模型,支持图文理解'
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        description: 'Claude 3最强模型'
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        description: 'Claude 3平衡版本'
      }
    ],
    defaultModel: 'claude-3-5-sonnet-20241022',
    defaultTimeout: 300,
    defaultMaxWorkers: 5,
    apiKeyPlaceholder: '请输入Anthropic API Key (从 https://console.anthropic.com/ 获取)',
    docsUrl: 'https://docs.anthropic.com/'
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
