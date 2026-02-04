import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { Plus, Pencil, Trash2, Loader2, CheckCircle, XCircle, TestTube } from "lucide-react";
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
  
  const utils = trpc.useUtils();
  const { data: configs, isLoading } = trpc.llmConfig.list.useQuery();
  
  const createMutation = trpc.llmConfig.create.useMutation({
    onSuccess: () => {
      toast.success("配置创建成功");
      setIsDialogOpen(false);
      setForm(defaultForm);
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
            <p className="text-muted-foreground">管理LLM API配置</p>
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
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingId ? "编辑配置" : "添加配置"}</DialogTitle>
              <DialogDescription>
                配置VLM API用于数学题目提取
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4 py-4">
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
                  placeholder={editingId ? "留空保持原密钥" : "sk-..."}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="modelName">模型名称 *</Label>
                <Input
                  id="modelName"
                  value={form.modelName}
                  onChange={(e) => setForm({ ...form, modelName: e.target.value })}
                  placeholder="gpt-4o"
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
