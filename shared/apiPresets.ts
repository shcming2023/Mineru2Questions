/**
 * 常见AI API供应商预设配置
 * 用户只需填写API Key即可快速完成配置
 */

export interface APIPreset {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  models: {
    id: string;
    name: string;
    description: string;
    supportsVision: boolean;
    recommended?: boolean;
  }[];
  description: string;
  docUrl: string;
  keyPlaceholder: string;
  keyPattern?: string; // 用于验证API Key格式的正则表达式
}

export const API_PRESETS: APIPreset[] = [
  // ============= 国内平台 =============
  {
    id: "siliconflow",
    name: "硅基流动",
    provider: "SiliconFlow",
    apiUrl: "https://api.siliconflow.cn/v1",
    models: [
      {
        id: "Qwen/Qwen2.5-VL-72B-Instruct",
        name: "Qwen2.5-VL-72B",
        description: "通义千问视觉大模型,72B参数,支持图片理解",
        supportsVision: true,
        recommended: true
      },
      {
        id: "Qwen/Qwen2.5-VL-32B-Instruct",
        name: "Qwen2.5-VL-32B",
        description: "通义千问视觉大模型,32B参数",
        supportsVision: true
      },
      {
        id: "Pro/Qwen/Qwen2.5-VL-7B-Instruct",
        name: "Qwen2.5-VL-7B (Pro)",
        description: "通义千问视觉大模型,7B参数,性价比高",
        supportsVision: true
      },
      {
        id: "deepseek-ai/DeepSeek-V3",
        name: "DeepSeek-V3",
        description: "DeepSeek最新模型,强大的推理能力",
        supportsVision: false
      },
      {
        id: "Qwen/Qwen2.5-72B-Instruct",
        name: "Qwen2.5-72B",
        description: "通义千问文本大模型,72B参数",
        supportsVision: false
      }
    ],
    description: "国内领先的AI模型服务平台,提供多种开源模型的API服务,价格实惠",
    docUrl: "https://docs.siliconflow.cn/",
    keyPlaceholder: "sk-xxx...",
    keyPattern: "^sk-[a-zA-Z0-9]+"
  },
  {
    id: "aliyun-bailian",
    name: "阿里云百炼",
    provider: "Alibaba Cloud",
    apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      {
        id: "qwen-vl-max",
        name: "通义千问VL-Max",
        description: "阿里云最强视觉大模型,支持图片理解和分析",
        supportsVision: true,
        recommended: true
      },
      {
        id: "qwen-vl-plus",
        name: "通义千问VL-Plus",
        description: "阿里云视觉大模型,平衡性能和成本",
        supportsVision: true
      },
      {
        id: "qwen-max",
        name: "通义千问Max",
        description: "阿里云最强文本大模型",
        supportsVision: false
      },
      {
        id: "qwen-plus",
        name: "通义千问Plus",
        description: "阿里云文本大模型,性价比高",
        supportsVision: false
      },
      {
        id: "qwen-turbo",
        name: "通义千问Turbo",
        description: "阿里云快速文本模型,响应速度快",
        supportsVision: false
      }
    ],
    description: "阿里云AI服务平台,提供通义千问系列模型",
    docUrl: "https://help.aliyun.com/zh/model-studio/",
    keyPlaceholder: "sk-xxx...",
    keyPattern: "^sk-[a-zA-Z0-9]+"
  },
  {
    id: "zhipu",
    name: "智谱AI",
    provider: "Zhipu AI",
    apiUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      {
        id: "glm-4v-plus",
        name: "GLM-4V-Plus",
        description: "智谱最强视觉大模型,支持图片理解",
        supportsVision: true,
        recommended: true
      },
      {
        id: "glm-4v",
        name: "GLM-4V",
        description: "智谱视觉大模型",
        supportsVision: true
      },
      {
        id: "glm-4-plus",
        name: "GLM-4-Plus",
        description: "智谱最强文本大模型",
        supportsVision: false
      },
      {
        id: "glm-4",
        name: "GLM-4",
        description: "智谱文本大模型",
        supportsVision: false
      },
      {
        id: "glm-4-flash",
        name: "GLM-4-Flash",
        description: "智谱快速模型,免费使用",
        supportsVision: false
      }
    ],
    description: "清华系AI公司,提供GLM系列大模型",
    docUrl: "https://open.bigmodel.cn/dev/api",
    keyPlaceholder: "xxx.xxx",
    keyPattern: "^[a-zA-Z0-9]+\\.[a-zA-Z0-9]+"
  },
  {
    id: "moonshot",
    name: "月之暗面 (Kimi)",
    provider: "Moonshot AI",
    apiUrl: "https://api.moonshot.cn/v1",
    models: [
      {
        id: "moonshot-v1-128k",
        name: "Moonshot-v1-128K",
        description: "支持128K上下文的长文本模型",
        supportsVision: false,
        recommended: true
      },
      {
        id: "moonshot-v1-32k",
        name: "Moonshot-v1-32K",
        description: "支持32K上下文的模型",
        supportsVision: false
      },
      {
        id: "moonshot-v1-8k",
        name: "Moonshot-v1-8K",
        description: "支持8K上下文的快速模型",
        supportsVision: false
      }
    ],
    description: "Kimi智能助手背后的AI公司,擅长长文本处理",
    docUrl: "https://platform.moonshot.cn/docs/",
    keyPlaceholder: "sk-xxx...",
    keyPattern: "^sk-[a-zA-Z0-9]+"
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    provider: "DeepSeek",
    apiUrl: "https://api.deepseek.com/v1",
    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek-V3",
        description: "DeepSeek最新模型,强大的推理和编程能力",
        supportsVision: false,
        recommended: true
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek-R1",
        description: "DeepSeek推理模型,擅长复杂推理任务",
        supportsVision: false
      }
    ],
    description: "国内领先的AI研究公司,以高性价比著称",
    docUrl: "https://platform.deepseek.com/api-docs/",
    keyPlaceholder: "sk-xxx...",
    keyPattern: "^sk-[a-zA-Z0-9]+"
  },
  {
    id: "baidu-qianfan",
    name: "百度千帆",
    provider: "Baidu",
    apiUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat",
    models: [
      {
        id: "ernie-4.0-8k",
        name: "文心一言4.0",
        description: "百度最强大模型",
        supportsVision: false,
        recommended: true
      },
      {
        id: "ernie-3.5-8k",
        name: "文心一言3.5",
        description: "百度主力大模型,性价比高",
        supportsVision: false
      }
    ],
    description: "百度AI开放平台,提供文心一言系列模型",
    docUrl: "https://cloud.baidu.com/doc/WENXINWORKSHOP/",
    keyPlaceholder: "需要Access Token",
    keyPattern: "^[a-zA-Z0-9._-]+"
  },
  
  // ============= 国际平台 =============
  {
    id: "openai",
    name: "OpenAI",
    provider: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "OpenAI最新多模态模型,支持图片理解",
        supportsVision: true,
        recommended: true
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o-mini",
        description: "GPT-4o的轻量版本,性价比高",
        supportsVision: true
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        description: "GPT-4的增强版本,支持128K上下文",
        supportsVision: true
      },
      {
        id: "gpt-4",
        name: "GPT-4",
        description: "OpenAI强大的文本模型",
        supportsVision: false
      },
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        description: "快速且经济的模型",
        supportsVision: false
      }
    ],
    description: "全球领先的AI公司,ChatGPT的创造者",
    docUrl: "https://platform.openai.com/docs/",
    keyPlaceholder: "sk-xxx...",
    keyPattern: "^sk-[a-zA-Z0-9]+"
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    provider: "Microsoft Azure",
    apiUrl: "https://{resource-name}.openai.azure.com/openai/deployments/{deployment-name}",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "Azure托管的GPT-4o模型",
        supportsVision: true,
        recommended: true
      },
      {
        id: "gpt-4",
        name: "GPT-4",
        description: "Azure托管的GPT-4模型",
        supportsVision: false
      },
      {
        id: "gpt-35-turbo",
        name: "GPT-3.5 Turbo",
        description: "Azure托管的GPT-3.5模型",
        supportsVision: false
      }
    ],
    description: "微软Azure云托管的OpenAI服务,企业级安全和合规",
    docUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
    keyPlaceholder: "需要配置Azure端点和密钥",
    keyPattern: "^[a-zA-Z0-9]+"
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    provider: "Anthropic",
    apiUrl: "https://api.anthropic.com/v1",
    models: [
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Anthropic最新模型,支持图片理解",
        supportsVision: true,
        recommended: true
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Anthropic最强模型,适合复杂任务",
        supportsVision: true
      },
      {
        id: "claude-3-sonnet-20240229",
        name: "Claude 3 Sonnet",
        description: "平衡性能和成本的模型",
        supportsVision: true
      },
      {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
        description: "快速且经济的模型",
        supportsVision: true
      }
    ],
    description: "专注于AI安全的公司,Claude系列以长上下文和准确性著称",
    docUrl: "https://docs.anthropic.com/",
    keyPlaceholder: "sk-ant-xxx...",
    keyPattern: "^sk-ant-[a-zA-Z0-9-]+"
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    provider: "Google",
    apiUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      {
        id: "gemini-2.0-flash-exp",
        name: "Gemini 2.0 Flash",
        description: "Google最新多模态模型,支持图片理解",
        supportsVision: true,
        recommended: true
      },
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "支持100万token上下文的强大模型",
        supportsVision: true
      },
      {
        id: "gemini-1.5-flash",
        name: "Gemini 1.5 Flash",
        description: "快速且经济的多模态模型",
        supportsVision: true
      }
    ],
    description: "Google的AI模型系列,以超长上下文和多模态能力著称",
    docUrl: "https://ai.google.dev/docs",
    keyPlaceholder: "AIza...",
    keyPattern: "^AIza[a-zA-Z0-9_-]+"
  },
  
  // ============= 自定义配置 =============
  {
    id: "custom",
    name: "自定义配置",
    provider: "Custom",
    apiUrl: "",
    models: [
      {
        id: "custom",
        name: "自定义模型",
        description: "手动输入模型名称",
        supportsVision: true
      }
    ],
    description: "手动配置API地址和模型,适用于私有部署或其他API服务",
    docUrl: "",
    keyPlaceholder: "API密钥",
    keyPattern: ".*"
  }
];

/**
 * 根据预设ID获取预设配置
 */
export function getPresetById(presetId: string): APIPreset | undefined {
  return API_PRESETS.find(p => p.id === presetId);
}

/**
 * 获取支持视觉理解的预设列表
 */
export function getVisionCapablePresets(): APIPreset[] {
  return API_PRESETS.filter(p => p.models.some(m => m.supportsVision));
}

/**
 * 获取推荐的视觉模型
 */
export function getRecommendedVisionModels(): { preset: APIPreset; model: APIPreset['models'][0] }[] {
  const result: { preset: APIPreset; model: APIPreset['models'][0] }[] = [];
  
  for (const preset of API_PRESETS) {
    const recommendedModel = preset.models.find(m => m.supportsVision && m.recommended);
    if (recommendedModel) {
      result.push({ preset, model: recommendedModel });
    }
  }
  
  return result;
}
