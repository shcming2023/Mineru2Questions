import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { Plus, Pencil, Trash2, Loader2, CheckCircle, XCircle, TestTube, ExternalLink, Sparkles } from "lucide-react";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { API_PRESETS, type APIPreset } from "../../../shared/apiPresets";

interface ConfigForm {
  name: string;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  maxWorkers: number;
  timeout: number;
  isDefault: boolean;
}

const defaultForm: ConfigForm = {
  name: "",
  apiUrl: "",
  apiKey: "",
  modelName: "",
  maxWorkers: 5,
  timeout: 300,
  isDefault: false,
};

export default function Settings() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ConfigForm>(defaultForm);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  
  const utils = trpc.useUtils();
  const { data: configs, isLoading } = trpc.llmConfig.list.useQuery();
  
  const createMutation = trpc.llmConfig.create.useMutation({
    onSuccess: () => {
      toast.success("配置创建成功");
      setIsDialogOpen(false);
      setForm(defaultForm);
      setSelectedPreset("");
      setSelectedModel("");
      utils.llmConfig.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const updateMutation = trpc.llmConfig.update.useMutation({
    onSuccess: () => {
      toast.success("配置更新成功");
      setIsDialogOpen(false);
      setForm(defaultForm);
      setEditingId(null);
      setSelectedPreset("");
      setSelectedModel("");
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

  const handleOpenCreate = () => {
    setEditingId(null);
    setForm(defaultForm);
    setTestResult(null);
    setSelectedPreset("");
    setSelectedModel("");
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (config: any) => {
    setEditingId(config.id);
    setForm({
      name: config.name,
      apiUrl: config.apiUrl,
      apiKey: "", // 不显示原密钥
      modelName: config.modelName,
      maxWorkers: config.maxWorkers,
      timeout: config.timeout,
      isDefault: config.isDefault,
    });
    setTestResult(null);
    setSelectedPreset("custom");
    setSelectedModel("");
    setIsDialogOpen(true);
  };

  const handlePresetChange = (presetId: string) => {
    setSelectedPreset(presetId);
    setSelectedModel("");
    setTestResult(null);
    
    const preset = API_PRESETS.find(p => p.id === presetId);
    if (preset && presetId !== "custom") {
      // 自动填充预设配置
      const recommendedModel = preset.models.find(m => m.recommended) || preset.models[0];
      setForm({
        ...form,
        name: `${preset.name} - ${recommendedModel.name}`,
        apiUrl: preset.apiUrl,
        modelName: recommendedModel.id,
      });
      setSelectedModel(recommendedModel.id);
    } else {
      // 自定义配置,清空
      setForm({
        ...form,
        name: "",
        apiUrl: "",
        modelName: "",
      });
    }
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    setTestResult(null);
    
    const preset = API_PRESETS.find(p => p.id === selectedPreset);
    if (preset) {
      const model = preset.models.find(m => m.id === modelId);
      if (model) {
        setForm({
          ...form,
          name: `${preset.name} - ${model.name}`,
          modelName: model.id,
        });
      }
    }
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

  const currentPreset = API_PRESETS.find(p => p.id === selectedPreset);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">设置</h1>
            <p className="text-muted-foreground">管理LLM API配置</p>
          </div>
          <Button onClick={handleOpenCreate}>
            <Plus className="mr-2 h-4 w-4" />
            添加配置
          </Button>
        </div>

        {/* 推荐配置卡片 */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="h-5 w-5 text-primary" />
              推荐配置
            </CardTitle>
            <CardDescription>
              以下平台支持视觉理解能力,适合数学题目提取任务
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {API_PRESETS.filter(p => p.id !== "custom" && p.models.some(m => m.supportsVision)).slice(0, 6).map((preset) => {
                const visionModel = preset.models.find(m => m.supportsVision && m.recommended) || preset.models.find(m => m.supportsVision);
                return (
                  <div
                    key={preset.id}
                    className="flex items-center justify-between p-3 bg-background rounded-lg border cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => {
                      handleOpenCreate();
                      setTimeout(() => handlePresetChange(preset.id), 100);
                    }}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{preset.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{visionModel?.name}</p>
                    </div>
                    <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>已配置的API</CardTitle>
            <CardDescription>
              配置用于题目提取的视觉语言模型API。支持OpenAI兼容的API接口。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !configs || configs.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">暂无配置,请点击上方推荐配置快速添加</p>
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
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingId ? "编辑配置" : "添加配置"}</DialogTitle>
              <DialogDescription>
                配置VLM API用于数学题目提取
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4 py-4">
              {/* 预设选择 */}
              {!editingId && (
                <div className="space-y-2">
                  <Label>选择API供应商</Label>
                  <Select value={selectedPreset} onValueChange={handlePresetChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择预设配置或自定义..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="custom">
                        <span className="font-medium">自定义配置</span>
                      </SelectItem>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                        国内平台
                      </div>
                      {API_PRESETS.filter(p => ["siliconflow", "aliyun-bailian", "zhipu", "moonshot", "deepseek", "baidu-qianfan"].includes(p.id)).map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          <div className="flex items-center gap-2">
                            <span>{preset.name}</span>
                            {preset.models.some(m => m.supportsVision) && (
                              <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">视觉</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                        国际平台
                      </div>
                      {API_PRESETS.filter(p => ["openai", "azure-openai", "anthropic", "google-gemini"].includes(p.id)).map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          <div className="flex items-center gap-2">
                            <span>{preset.name}</span>
                            {preset.models.some(m => m.supportsVision) && (
                              <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">视觉</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {/* 预设说明 */}
                  {currentPreset && selectedPreset !== "custom" && (
                    <div className="p-3 bg-muted/50 rounded-lg text-sm">
                      <p className="text-muted-foreground">{currentPreset.description}</p>
                      {currentPreset.docUrl && (
                        <a
                          href={currentPreset.docUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline mt-2"
                        >
                          查看文档 <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 模型选择 */}
              {selectedPreset && selectedPreset !== "custom" && currentPreset && (
                <div className="space-y-2">
                  <Label>选择模型</Label>
                  <Select value={selectedModel} onValueChange={handleModelChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择模型..." />
                    </SelectTrigger>
                    <SelectContent>
                      {currentPreset.models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          <div className="flex items-center gap-2">
                            <span>{model.name}</span>
                            {model.supportsVision && (
                              <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">视觉</span>
                            )}
                            {model.recommended && (
                              <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">推荐</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedModel && (
                    <p className="text-xs text-muted-foreground">
                      {currentPreset.models.find(m => m.id === selectedModel)?.description}
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="name">配置名称 *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="如: GPT-4o Vision"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="apiUrl">API URL *</Label>
                <Input
                  id="apiUrl"
                  value={form.apiUrl}
                  onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  disabled={selectedPreset !== "custom" && selectedPreset !== ""}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="apiKey">
                  API密钥 {editingId ? "(留空保持不变)" : "*"}
                </Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={currentPreset?.keyPlaceholder || (editingId ? "留空保持原密钥" : "sk-...")}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="modelName">模型名称 *</Label>
                <Input
                  id="modelName"
                  value={form.modelName}
                  onChange={(e) => setForm({ ...form, modelName: e.target.value })}
                  placeholder="gpt-4o"
                  disabled={selectedPreset !== "custom" && selectedPreset !== "" && selectedModel !== ""}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="maxWorkers">并发数</Label>
                  <Input
                    id="maxWorkers"
                    type="number"
                    min={1}
                    max={50}
                    value={form.maxWorkers}
                    onChange={(e) => setForm({ ...form, maxWorkers: parseInt(e.target.value) || 5 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeout">超时时间(秒)</Label>
                  <Input
                    id="timeout"
                    type="number"
                    min={30}
                    max={1800}
                    value={form.timeout}
                    onChange={(e) => setForm({ ...form, timeout: parseInt(e.target.value) || 300 })}
                  />
                </div>
              </div>
              
              <div className="flex items-center justify-between">
                <Label htmlFor="isDefault">设为默认配置</Label>
                <Switch
                  id="isDefault"
                  checked={form.isDefault}
                  onCheckedChange={(checked) => setForm({ ...form, isDefault: checked })}
                />
              </div>
              
              {/* 测试结果 */}
              {testResult && (
                <div
                  className={`flex items-center gap-2 p-3 rounded-lg ${
                    testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  }`}
                >
                  {testResult.success ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}
                  <span className="text-sm">{testResult.message}</span>
                </div>
              )}
            </div>
            
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <TestTube className="mr-2 h-4 w-4" />
                )}
                测试连接
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {editingId ? "保存" : "创建"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
