import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { Plus, Play, Pause, RotateCcw, Trash2, Eye, Loader2, Activity, AlertTriangle, ShieldCheck } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const statusConfig = {
  pending: { label: "等待中", variant: "secondary" as const, color: "bg-gray-500" },
  processing: { label: "处理中", variant: "default" as const, color: "bg-blue-500" },
  completed: { label: "已完成", variant: "default" as const, color: "bg-green-500" },
  failed: { label: "失败", variant: "destructive" as const, color: "bg-red-500" },
  paused: { label: "已暂停", variant: "outline" as const, color: "bg-yellow-500" },
};

export default function Tasks() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  
  const { data: tasks, isLoading } = trpc.task.list.useQuery();
  const { data: health, refetch: refetchHealth } = trpc.task.checkHealth.useQuery();
  
  const cleanupMutation = trpc.task.cleanup.useMutation({
    onSuccess: (data) => {
      toast.success(`环境清理完成，重置了 ${data.count} 个陈旧任务`);
      utils.task.list.invalidate();
      refetchHealth();
    },
    onError: (error) => toast.error(error.message),
  });

  const startMutation = trpc.task.start.useMutation({
    onSuccess: () => {
      toast.success("任务已开始");
      utils.task.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const pauseMutation = trpc.task.pause.useMutation({
    onSuccess: () => {
      toast.success("任务已暂停");
      utils.task.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const retryMutation = trpc.task.retry.useMutation({
    onSuccess: () => {
      toast.success("任务已重置,可以重新开始");
      utils.task.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  
  const deleteMutation = trpc.task.delete.useMutation({
    onSuccess: () => {
      toast.success("任务已删除");
      utils.task.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const formatTime = (seconds: number | null | undefined) => {
    if (!seconds) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">任务管理</h1>
            <p className="text-muted-foreground">管理您的题目提取任务</p>
          </div>
          <div className="flex gap-2">
            {health && (
              <Button 
                variant={health.isHealthy ? "outline" : "destructive"}
                size="sm"
                onClick={() => cleanupMutation.mutate()}
                disabled={cleanupMutation.isPending || (health.isHealthy && health.activeTasks === 0)}
              >
                {cleanupMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : health.isHealthy ? (
                  <ShieldCheck className="mr-2 h-4 w-4" />
                ) : (
                  <AlertTriangle className="mr-2 h-4 w-4" />
                )}
                {health.staleTasks > 0 ? "清理陈旧任务" : "系统状态正常"}
              </Button>
            )}
            <Button onClick={() => setLocation("/tasks/new")}>
              <Plus className="mr-2 h-4 w-4" />
              新建任务
            </Button>
          </div>
        </div>

        {health && !health.isHealthy && health.staleTasks > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>检测到环境异常</AlertTitle>
            <AlertDescription className="flex items-center justify-between">
              <span>检测到 {health.staleTasks} 个任务可能已卡死（陈旧进程）。建议立即清理环境以确保新任务正常执行。</span>
              <Button 
                variant="outline" 
                size="sm" 
                className="bg-white/10 hover:bg-white/20 border-white/20"
                onClick={() => cleanupMutation.mutate()}
                disabled={cleanupMutation.isPending}
              >
                立即清理
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-muted-foreground mb-4">暂无任务</p>
              <Button onClick={() => setLocation("/tasks/new")}>
                <Plus className="mr-2 h-4 w-4" />
                创建第一个任务
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {tasks.map((task) => {
              const status = statusConfig[task.status];
              const progress = task.totalPages > 0 
                ? (task.processedPages / task.totalPages) * 100 
                : 0;
              
              return (
                <Card key={task.id} className="hover:shadow-md transition-shadow">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <CardTitle className="text-lg">{task.name}</CardTitle>
                        <CardDescription>
                          创建于 {new Date(task.createdAt).toLocaleString()}
                        </CardDescription>
                      </div>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {/* 进度条 */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span>进度: {task.processedPages}/{task.totalPages} 页</span>
                          <span>{progress.toFixed(1)}%</span>
                        </div>
                        <Progress value={progress} className="h-2" />
                      </div>
                      
                      {/* 统计信息 */}
                      <div className="flex gap-6 text-sm text-muted-foreground">
                        <span>提取题目: {task.extractedCount} 道</span>
                        {task.estimatedTimeRemaining && task.status === "processing" && (
                          <span>预计剩余: {formatTime(task.estimatedTimeRemaining)}</span>
                        )}
                        {task.retryCount > 0 && (
                          <span>重试次数: {task.retryCount}</span>
                        )}
                      </div>
                      
                      {/* 错误信息 */}
                      {task.errorMessage && (
                        <p className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                          {task.errorMessage}
                        </p>
                      )}
                      
                      {/* 操作按钮 */}
                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLocation(`/tasks/${task.id}`)}
                        >
                          <Eye className="mr-1 h-4 w-4" />
                          查看详情
                        </Button>
                        
                        {(task.status === "pending" || task.status === "paused") && (
                          <Button
                            size="sm"
                            onClick={() => startMutation.mutate({ id: task.id })}
                            disabled={startMutation.isPending}
                          >
                            <Play className="mr-1 h-4 w-4" />
                            开始
                          </Button>
                        )}
                        
                        {task.status === "processing" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => pauseMutation.mutate({ id: task.id })}
                            disabled={pauseMutation.isPending}
                          >
                            <Pause className="mr-1 h-4 w-4" />
                            暂停
                          </Button>
                        )}
                        
                        {task.status === "failed" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => retryMutation.mutate({ id: task.id })}
                            disabled={retryMutation.isPending}
                          >
                            <RotateCcw className="mr-1 h-4 w-4" />
                            重试
                          </Button>
                        )}
                        
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="text-destructive">
                              <Trash2 className="mr-1 h-4 w-4" />
                              删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>确认删除</AlertDialogTitle>
                              <AlertDialogDescription>
                                确定要删除任务 "{task.name}" 吗?此操作不可撤销。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMutation.mutate({ id: task.id })}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
