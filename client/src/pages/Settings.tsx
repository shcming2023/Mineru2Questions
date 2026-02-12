import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Plus, Pencil, Trash2, Loader2, CheckCircle, XCircle, TestTube, ExternalLink } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { LLM_PRESETS, getPresetById, type LLMPreset, PURPOSE_LABELS, type LLMPurpose } from "../../../shared/llm-presets";

interface ConfigForm {
  presetId: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  maxWorkers: number;
  timeout: number;
  isDefault: boolean;
  purpose: LLMPurpose;
}

const STORAGE_KEY = "llm_config_last_values";

const defaultForm: ConfigForm = {
  presetId: "siliconflow",
  name: "",
  apiUrl: "",
  apiKey: "",
  modelName: "",
  maxWorkers: 5,
  timeout: 300,
  isDefault: false,
  purpose: "vision_extract",
};

// 从localStorage加载上次的配置值
function loadLastConfig(): Partial<ConfigForm> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error("Failed to load last config:", error);
  }
  return {};
}

// 保存配置值到localStorage
function saveLastConfig(form: ConfigForm) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  } catch (error) {
    console.error("Failed to save last config:", error);
  }
}

const PURPOSE_BADGE_COLORS: Record<LLMPurpose, string> = {
  vision_extract: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  long_context: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  general: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
};

export default function Settings() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ConfigForm>(defaultForm);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<LLMPreset | null>(null);
  
  const utils = trpc.useUtils();
  const { data: configs, isLoading } = trpc.llmConfig.list.useQuery();
  
  const createMutation = trpc.llmConfig.create.useMutation({
    onSuccess: () => {
      toast.success("配置创建成功");
      saveLastConfig(form);
      setIsDialogOpen(false);
      setForm(defaultForm);
      utils.llmConfig.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const updateMutation = trpc.llmConfig.update.useMutation({
    onSuccess: () => {
      toast.success("配置更新成功");
      saveLastConfig(form);
      setIsDialogOpen(false);
      setForm(defaultForm);
      setEditingId(null);
      utils.llmConfig.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const deleteMutation = trpc.llmConfig.delete.useMutation({
    onSuccess: () => {
      toast.success("配置已删除");
      utils.llmConfig.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const testMutation = trpc.llmConfig.test.useMutation({
    onSuccess: (result) => {
      setTestResult(result);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    },
    onError: (error) => {
      setTestResult({ success: false, message: error.message });
      toast.error(error.message);
    },
  });

  // 当选择预设时,自动填充配置
  const handlePresetChange = (presetId: string) => {
    const preset = getPresetById(presetId);
    if (!preset) return;
    
    setSelectedPreset(preset);
    setForm(prev => ({
      ...prev,
      presetId,
      name: preset.name,
      apiUrl: preset.baseUrl,
      modelName: preset.defaultModel,
      maxWorkers: preset.defaultMaxWorkers,
      timeout: preset.defaultTimeout,
      purpose: preset.primaryPurpose || "general",
    }));
  };

  const handleOpenCreate = () => {
    setEditingId(null);
    
    const lastConfig = loadLastConfig();
    const initialForm = { ...defaultForm, ...lastConfig };
    
    const preset = getPresetById(initialForm.presetId);
    if (preset) {
      if (!initialForm.apiUrl) initialForm.apiUrl = preset.baseUrl;
      if (!initialForm.modelName) initialForm.modelName = preset.defaultModel;
      if (!initialForm.name) initialForm.name = preset.name;
    }
    
    setForm(initialForm);
    setSelectedPreset(preset || null);
    
    setTestResult(null);
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (config: any) => {
    setEditingId(config.id);
    
    let matchedPresetId = "custom";
    for (const preset of LLM_PRESETS) {
      if (preset.baseUrl && config.apiUrl.includes(preset.baseUrl.split('/v1')[0])) {
        matchedPresetId = preset.id;
        break;
      }
    }
    
    const preset = getPresetById(matchedPresetId);
    setSelectedPreset(preset || null);
    
    setForm({
      presetId: matchedPresetId,
      name: config.name,
      apiUrl: config.apiUrl,
      apiKey: "",
      modelName: config.modelName,
      maxWorkers: config.maxWorkers,
      timeout: config.timeout,
      isDefault: config.isDefault,
      purpose: config.purpose || "vision_extract",
    });
    setTestResult(null);
    setIsDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name || !form.apiUrl || !form.modelName) {
      toast.error("请填写必填字段");
      return;
    }
    
    if (editingId) {
      const updates: any = { id: editingId };
      if (form.name) updates.name = form.name;
      if (form.apiUrl) updates.apiUrl = form.apiUrl;
      if (form.apiKey) updates.apiKey = form.apiKey;
      if (form.modelName) updates.modelName = form.modelName;
      updates.maxWorkers = form.maxWorkers;
      updates.timeout = form.timeout;
      updates.isDefault = form.isDefault;
      updates.purpose = form.purpose;
      updateMutation.mutate(updates);
    } else {
      if (!form.apiKey) {
        toast.error("请输入API密钥");
        return;
      }
      createMutation.mutate(form);
    }
  };

  const handleTest = () => {
    if (!form.apiUrl || !form.apiKey || !form.modelName) {
      toast.error("请先填写API URL、密钥和模型名称");
      return;
    }
    setTestResult(null);
    testMutation.mutate({
      apiUrl: form.apiUrl,
      apiKey: form.apiKey,
      modelName: form.modelName,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">设置</h1>
            <p className="text-muted-foreground">管理LLM API配置，不同流水线阶段可使用不同的模型</p>
          </div>
          <Button onClick={handleOpenCreate}>
            <Plus className="mr-2 h-4 w-4" />
            添加配置
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>LLM API配置</CardTitle>
            <CardDescription>
              配置用于不同流水线阶段的LLM API。
              <strong>视觉抽取</strong>用于题目提取（需要理解图片），
              <strong>长文本推理</strong>用于章节预处理（需要大上下文窗口）。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !configs || configs.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">暂无配置</p>
                <Button onClick={handleOpenCreate}>
                  <Plus className="mr-2 h-4 w-4" />
                  添加第一个配置
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {configs.map((config) => (
                  <div
                    key={config.id}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{config.name}</span>
                        {config.isDefault && (
                          <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                            默认
                          </span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded ${PURPOSE_BADGE_COLORS[(config as any).purpose as LLMPurpose] || PURPOSE_BADGE_COLORS.general}`}>
                          {PURPOSE_LABELS[(config as any).purpose as LLMPurpose] || PURPOSE_LABELS.general}
                        </span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        <span>模型: {config.modelName}</span>
                        <span className="mx-2">|</span>
                        <span>并发: {config.maxWorkers}</span>
                        <span className="mx-2">|</span>
                        <span>超时: {config.timeout}秒</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate max-w-md">
                        {config.apiUrl}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenEdit(config)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除</AlertDialogTitle>
                            <AlertDialogDescription>
                              确定要删除配置 "{config.name}" 吗?
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate({ id: config.id })}
                              className="bg-destructive text-destructive-foreground"
                            >
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 配置对话框 */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingId ? "编辑配置" : "添加配置"}</DialogTitle>
              <DialogDescription>
                选择预设模型提供商,或自定义API配置
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4 py-4">
              {/* 用途选择 */}
              <div className="space-y-2">
                <Label htmlFor="purpose">用途 *</Label>
                <Select value={form.purpose} onValueChange={(value) => setForm({ ...form, purpose: value as LLMPurpose })}>
                  <SelectTrigger id="purpose">
                    <SelectValue placeholder="选择用途" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vision_extract">
                      <div className="flex flex-col">
                        <span>视觉抽取</span>
                        <span className="text-xs text-muted-foreground">用于题目提取，需要理解图片/公式</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="long_context">
                      <div className="flex flex-col">
                        <span>长文本推理</span>
                        <span className="text-xs text-muted-foreground">用于章节预处理，需要 100K+ 上下文窗口</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="general">
                      <div className="flex flex-col">
                        <span>通用</span>
                        <span className="text-xs text-muted-foreground">可用于多种任务</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 预设提供商选择器 */}
              <div className="space-y-2">
                <Label htmlFor="preset">模型提供商 *</Label>
                <Select value={form.presetId} onValueChange={handlePresetChange}>
                  <SelectTrigger id="preset">
                    <SelectValue placeholder="选择模型提供商" />
                  </SelectTrigger>
                  <SelectContent>
                    {LLM_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                        {preset.primaryPurpose && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({PURPOSE_LABELS[preset.primaryPurpose]})
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedPreset && selectedPreset.docsUrl && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <a 
                      href={selectedPreset.docsUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 hover:underline"
                    >
                      查看官方文档 <ExternalLink className="h-3 w-3" />
                    </a>
                  </p>
                )}
              </div>

              {/* 配置名称 */}
              <div className="space-y-2">
                <Label htmlFor="name">配置名称 *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="如: SiliconFlow Qwen2.5-VL"
                />
              </div>
              
              {/* API URL */}
              <div className="space-y-2">
                <Label htmlFor="apiUrl">API URL *</Label>
                <Input
                  id="apiUrl"
                  value={form.apiUrl}
                  onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
                  placeholder="https://api.siliconflow.cn/v1/chat/completions"
                  disabled={form.presetId !== 'custom'}
                />
                {form.presetId !== 'custom' && (
                  <p className="text-xs text-muted-foreground">
                    已自动填充预设API URL
                  </p>
                )}
              </div>
              
              {/* API密钥 */}
              <div className="space-y-2">
                <Label htmlFor="apiKey">
                  API密钥 {editingId ? "(留空保持不变)" : "*"}
                </Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={selectedPreset?.apiKeyPlaceholder || "请输入API密钥"}
                />
              </div>
              
              {/* 模型名称 */}
              <div className="space-y-2">
                <Label htmlFor="modelName">模型名称 *</Label>
                {selectedPreset && selectedPreset.models.length > 0 ? (
                  <>
                    <Select 
                      value={form.modelName} 
                      onValueChange={(value) => setForm({ ...form, modelName: value })}
                    >
                      <SelectTrigger id="modelName">
                        <SelectValue placeholder="选择模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedPreset.models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            <div className="flex flex-col">
                              <span>{model.name}</span>
                              {model.description && (
                                <span className="text-xs text-muted-foreground">
                                  {model.description}
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : (
                  <Input
                    id="modelName"
                    value={form.modelName}
                    onChange={(e) => setForm({ ...form, modelName: e.target.value })}
                    placeholder="输入模型名称"
                  />
                )}
              </div>
              
              {/* 高级选项 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="maxWorkers">并发数</Label>
                  <Input
                    id="maxWorkers"
                    type="number"
                    min="1"
                    max="20"
                    value={form.maxWorkers}
                    onChange={(e) => setForm({ ...form, maxWorkers: parseInt(e.target.value) || 5 })}
                  />
                  <p className="text-xs text-muted-foreground">
                    同时处理的任务数量
                  </p>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="timeout">超时时间(秒)</Label>
                  <Input
                    id="timeout"
                    type="number"
                    min="30"
                    max="600"
                    value={form.timeout}
                    onChange={(e) => setForm({ ...form, timeout: parseInt(e.target.value) || 300 })}
                  />
                  <p className="text-xs text-muted-foreground">
                    API请求超时时间
                  </p>
                </div>
              </div>
              
              {/* 设为默认 */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="isDefault">设为默认配置</Label>
                  <p className="text-xs text-muted-foreground">
                    新建任务时自动使用此配置
                  </p>
                </div>
                <Switch
                  id="isDefault"
                  checked={form.isDefault}
                  onCheckedChange={(checked) => setForm({ ...form, isDefault: checked })}
                />
              </div>

              {/* 测试结果 */}
              {testResult && (
                <div className={`flex items-center gap-2 p-3 rounded-lg ${
                  testResult.success 
                    ? "bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100" 
                    : "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100"
                }`}>
                  {testResult.success ? (
                    <CheckCircle className="h-5 w-5 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="text-sm">{testResult.message}</span>
                </div>
              )}
            </div>
            
            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    测试中...
                  </>
                ) : (
                  <>
                    <TestTube className="mr-2 h-4 w-4" />
                    测试连接
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                取消
              </Button>
              <Button 
                onClick={handleSubmit}
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending) ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    保存中...
                  </>
                ) : (
                  "保存"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
