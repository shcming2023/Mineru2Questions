import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Play, Pause, RotateCcw, Download, Loader2, FileJson, FileText, RefreshCw, Terminal, AlertCircle, CheckCircle, Info, AlertTriangle } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { useState, useEffect, useRef } from "react";
import { Streamdown } from "streamdown";

const statusConfig = {
  pending: { label: "等待中", variant: "secondary" as const },
  processing: { label: "处理中", variant: "default" as const },
  completed: { label: "已完成", variant: "default" as const },
  failed: { label: "失败", variant: "destructive" as const },
  paused: { label: "已暂停", variant: "outline" as const },
};

const logLevelIcons = {
  info: <Info className="h-4 w-4 text-blue-500" />,
  warn: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
  error: <AlertCircle className="h-4 w-4 text-red-500" />,
  success: <CheckCircle className="h-4 w-4 text-green-500" />,
};

const logLevelColors = {
  info: "text-blue-600 bg-blue-50",
  warn: "text-yellow-600 bg-yellow-50",
  error: "text-red-600 bg-red-50",
  success: "text-green-600 bg-green-50",
};

export default function TaskDetail() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const taskId = parseInt(params.id || "0");
  const utils = trpc.useUtils();
  
  const [previewFormat, setPreviewFormat] = useState<"json" | "markdown">("json");
  const [activeTab, setActiveTab] = useState<"progress" | "logs" | "result">("progress");
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  const { data: task, isLoading, refetch } = trpc.task.get.useQuery(
    { id: taskId },
    { 
      enabled: taskId > 0,
      refetchInterval: (query) => {
        return query.state.data?.status === "processing" ? 3000 : false;
      }
    }
  );
  
  const { data: pageLogs } = trpc.task.getPageLogs.useQuery(
    { taskId },
    { enabled: taskId > 0 }
  );
  
  // 获取详细处理日志
  const { data: taskLogs, refetch: refetchLogs } = trpc.task.getLogs.useQuery(
    { taskId, limit: 200 },
    { 
      enabled: taskId > 0,
      refetchInterval: (query) => {
        // 处理中时自动刷新日志
        return task?.status === "processing" ? 2000 : false;
      }
    }
  );
  
  const { data: downloadLinks } = trpc.result.getDownloadLinks.useQuery(
    { taskId },
    { enabled: task?.status === "completed" }
  );
  
  const { data: resultContent, isLoading: isLoadingContent } = trpc.result.getContent.useQuery(
    { taskId, format: previewFormat },
    { enabled: task?.status === "completed" }
  );
  
  const startMutation = trpc.task.start.useMutation({
    onSuccess: () => {
      toast.success("任务已开始");
      utils.task.get.invalidate({ id: taskId });
      setActiveTab("logs"); // 自动切换到日志标签
    },
    onError: (error) => toast.error(error.message),
  });
  
  const pauseMutation = trpc.task.pause.useMutation({
    onSuccess: () => {
      toast.success("任务已暂停");
      utils.task.get.invalidate({ id: taskId });
    },
    onError: (error) => toast.error(error.message),
  });
  
  const retryMutation = trpc.task.retry.useMutation({
    onSuccess: () => {
      toast.success("任务已重置");
      utils.task.get.invalidate({ id: taskId });
    },
    onError: (error) => toast.error(error.message),
  });

  // 自动滚动到最新日志
  useEffect(() => {
    if (task?.status === "processing" && activeTab === "logs") {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [taskLogs, task?.status, activeTab]);

  // 任务完成时自动切换到结果标签
  useEffect(() => {
    if (task?.status === "completed" && activeTab === "logs") {
      setActiveTab("result");
    }
  }, [task?.status]);

  const formatTime = (seconds: number | null | undefined) => {
    if (!seconds) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
  };

  const formatDate = (date: Date | string | null | undefined) => {
    if (!date) return "--";
    return new Date(date).toLocaleString();
  };

  const formatLogTime = (date: Date | string) => {
    return new Date(date).toLocaleTimeString('zh-CN', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    });
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (!task) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-muted-foreground mb-4">任务不存在</p>
          <Button onClick={() => setLocation("/tasks")}>返回任务列表</Button>
        </div>
      </DashboardLayout>
    );
  }

  const status = statusConfig[task.status];
  const progress = task.totalPages > 0 ? (task.processedPages / task.totalPages) * 100 : 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* 头部 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => setLocation("/tasks")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight">{task.name}</h1>
                <Badge variant={status.variant}>{status.label}</Badge>
              </div>
              <p className="text-muted-foreground">创建于 {formatDate(task.createdAt)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { refetch(); refetchLogs(); }}>
              <RefreshCw className="mr-1 h-4 w-4" />
              刷新
            </Button>
            {(task.status === "pending" || task.status === "paused") && (
              <Button size="sm" onClick={() => startMutation.mutate({ id: taskId })}>
                <Play className="mr-1 h-4 w-4" />
                开始
              </Button>
            )}
            {task.status === "processing" && (
              <Button variant="outline" size="sm" onClick={() => pauseMutation.mutate({ id: taskId })}>
                <Pause className="mr-1 h-4 w-4" />
                暂停
              </Button>
            )}
            {task.status === "failed" && (
              <Button variant="outline" size="sm" onClick={() => retryMutation.mutate({ id: taskId })}>
                <RotateCcw className="mr-1 h-4 w-4" />
                重试
              </Button>
            )}
          </div>
        </div>

        {/* 进度概览 */}
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">处理进度</p>
                  <p className="text-2xl font-bold">{task.processedPages} / {task.totalPages} 块</p>
                </div>
                <div className="text-right space-y-1">
                  <p className="text-sm text-muted-foreground">提取题目数</p>
                  <p className="text-2xl font-bold text-primary">{task.extractedCount}</p>
                </div>
              </div>
              <Progress value={progress} className="h-3" />
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{progress.toFixed(1)}% 完成</span>
                <span>预计剩余: {formatTime(task.estimatedTimeRemaining)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 主内容区域 - 标签页 */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="progress">
              处理状态
            </TabsTrigger>
            <TabsTrigger value="logs" className="relative">
              <Terminal className="mr-1 h-4 w-4" />
              实时日志
              {task.status === "processing" && (
                <span className="absolute -top-1 -right-1 h-2 w-2 bg-green-500 rounded-full animate-pulse" />
              )}
            </TabsTrigger>
            <TabsTrigger value="result" disabled={task.status !== "completed"}>
              提取结果
            </TabsTrigger>
          </TabsList>

          {/* 处理状态标签 */}
          <TabsContent value="progress" className="mt-4">
            <div className="grid gap-6 md:grid-cols-2">
              {/* 详细信息卡片 */}
              <Card>
                <CardHeader>
                  <CardTitle>任务详情</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">当前处理块</p>
                      <p className="font-medium">{task.currentPage || "--"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">重试次数</p>
                      <p className="font-medium">{task.retryCount}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">开始时间</p>
                      <p className="font-medium">{formatDate(task.startedAt)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">完成时间</p>
                      <p className="font-medium">{formatDate(task.completedAt)}</p>
                    </div>
                  </div>
                  
                  {task.errorMessage && (
                    <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <p className="font-medium">错误信息:</p>
                      <p>{task.errorMessage}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 页面处理状态 */}
              <Card>
                <CardHeader>
                  <CardTitle>分块处理状态</CardTitle>
                  <CardDescription>每个内容块的处理情况</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-64">
                    {pageLogs && pageLogs.length > 0 ? (
                      <div className="space-y-2">
                        {pageLogs.map((log) => (
                          <div
                            key={log.id}
                            className="flex items-center justify-between p-2 rounded-lg bg-muted/30"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-medium">Chunk {log.pageIndex + 1}</span>
                              <Badge
                                variant={
                                  log.status === "completed"
                                    ? "default"
                                    : log.status === "failed"
                                    ? "destructive"
                                    : log.status === "processing"
                                    ? "default"
                                    : "secondary"
                                }
                                className="text-xs"
                              >
                                {log.status === "completed"
                                  ? "已完成"
                                  : log.status === "failed"
                                  ? "失败"
                                  : log.status === "processing"
                                  ? "处理中"
                                  : "等待中"}
                              </Badge>
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {log.processingTime ? `${(log.processingTime / 1000).toFixed(1)}秒` : "--"}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-center text-muted-foreground py-8">暂无处理记录</p>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* 实时日志标签 */}
          <TabsContent value="logs" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Terminal className="h-5 w-5" />
                      处理日志
                    </CardTitle>
                    <CardDescription>
                      实时查看任务处理的详细日志
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => refetchLogs()}>
                    <RefreshCw className="mr-1 h-4 w-4" />
                    刷新
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px] w-full rounded-md border bg-muted/20 p-4">
                  {taskLogs && taskLogs.length > 0 ? (
                    <div className="space-y-2 font-mono text-sm">
                      {[...taskLogs].reverse().map((log) => (
                        <div
                          key={log.id}
                          className={`flex items-start gap-3 p-2 rounded ${logLevelColors[log.level as keyof typeof logLevelColors] || 'bg-muted/50'}`}
                        >
                          <span className="flex-shrink-0 mt-0.5">
                            {logLevelIcons[log.level as keyof typeof logLevelIcons] || <Info className="h-4 w-4" />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-muted-foreground">
                                {formatLogTime(log.createdAt)}
                              </span>
                              <Badge variant="outline" className="text-xs">
                                {log.stage}
                              </Badge>
                            </div>
                            <p className="mt-1 break-words">{log.message}</p>
                            {log.details && (
                              <pre className="mt-1 text-xs text-muted-foreground overflow-x-auto">
                                {typeof log.details === 'string' 
                                  ? log.details 
                                  : JSON.stringify(log.details, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                      ))}
                      <div ref={logsEndRef} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Terminal className="h-12 w-12 mb-4 opacity-50" />
                      <p>暂无日志</p>
                      <p className="text-sm">启动任务后将显示处理日志</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* 提取结果标签 */}
          <TabsContent value="result" className="mt-4">
            {task.status === "completed" ? (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>提取结果</CardTitle>
                      <CardDescription>预览和下载提取的题目</CardDescription>
                    </div>
                    {downloadLinks && (
                      <div className="flex gap-2">
                        {downloadLinks.links.map((link) => (
                          <Button
                            key={link.type}
                            variant="outline"
                            size="sm"
                            asChild
                          >
                            <a href={link.url} download={link.name}>
                              <Download className="mr-1 h-4 w-4" />
                              {link.type === "json" ? "JSON" : "Markdown"}
                            </a>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs value={previewFormat} onValueChange={(v) => setPreviewFormat(v as "json" | "markdown")}>
                    <TabsList>
                      <TabsTrigger value="json">
                        <FileJson className="mr-1 h-4 w-4" />
                        JSON格式
                      </TabsTrigger>
                      <TabsTrigger value="markdown">
                        <FileText className="mr-1 h-4 w-4" />
                        Markdown格式
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="json" className="mt-4">
                      <ScrollArea className="h-96 w-full rounded-md border p-4">
                        {isLoadingContent ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin" />
                          </div>
                        ) : (
                          <pre className="text-sm whitespace-pre-wrap">{resultContent?.content || "暂无内容"}</pre>
                        )}
                      </ScrollArea>
                    </TabsContent>
                    <TabsContent value="markdown" className="mt-4">
                      <ScrollArea className="h-96 w-full rounded-md border p-4">
                        {isLoadingContent ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin" />
                          </div>
                        ) : (
                          <div className="prose prose-sm max-w-none dark:prose-invert">
                            <Streamdown>{resultContent?.content || "暂无内容"}</Streamdown>
                          </div>
                        )}
                      </ScrollArea>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-12">
                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                    <FileText className="h-12 w-12 mb-4 opacity-50" />
                    <p>任务完成后将显示提取结果</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
