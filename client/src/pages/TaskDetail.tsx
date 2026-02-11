import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Play, Pause, RotateCcw, Download, Loader2, FileJson, FileText, RefreshCw, Terminal, AlertCircle, CheckCircle, Info, AlertTriangle, Clock, Cpu, Zap, ChevronLeft, ChevronRight } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { useState, useEffect, useRef, useMemo } from "react";
import { Streamdown } from "streamdown";

const statusConfig = {
  pending: { label: "等待中", variant: "secondary" as const },
  processing: { label: "处理中", variant: "default" as const },
  completed: { label: "已完成", variant: "default" as const },
  failed: { label: "失败", variant: "destructive" as const },
  paused: { label: "已暂停", variant: "outline" as const },
};

// 日志级别配置
const logLevelConfig = {
  info: { icon: Info, color: "text-blue-500", bg: "bg-blue-500/10" },
  warn: { icon: AlertTriangle, color: "text-yellow-500", bg: "bg-yellow-500/10" },
  error: { icon: AlertCircle, color: "text-red-500", bg: "bg-red-500/10" },
  debug: { icon: Terminal, color: "text-gray-500", bg: "bg-gray-500/10" },
};

export default function TaskDetail() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const taskId = parseInt(params.id || "0");
  const utils = trpc.useUtils();
  
  const [previewFormat, setPreviewFormat] = useState<"json" | "markdown">("json");
  const [activeTab, setActiveTab] = useState<"status" | "logs" | "results">("status");
  const [autoScroll, setAutoScroll] = useState(true);
  const [resultPage, setResultPage] = useState(1);
  const [resultPageSize, setResultPageSize] = useState(10);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  const { data: task, isLoading, refetch } = trpc.task.get.useQuery(
    { id: taskId },
    { 
      enabled: taskId > 0,
      refetchInterval: (query) => {
        return query.state.data?.status === "processing" ? 2000 : false;
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
  
  // 自动滚动到最新日志
  useEffect(() => {
    if (autoScroll && logsEndRef.current && activeTab === "logs") {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [taskLogs, autoScroll, activeTab]);
  
  const startMutation = trpc.task.start.useMutation({
    onSuccess: () => {
      toast.success("任务已开始");
      utils.task.get.invalidate({ id: taskId });
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
  
  const formatLogTime = (date: Date | string | null | undefined) => {
    if (!date) return "--";
    return new Date(date).toLocaleTimeString();
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
  
  const chunkStats = taskLogs ? (() => {
    const totalFromLogs = taskLogs.reduce((max, log) => Math.max(max, log.totalChunks || 0), 0);
    const started = taskLogs.filter(l => l.message?.includes("开始处理Chunk") || l.message?.includes("Processing chunk")).length;
    // Fix: Exclude "LLM response" messages to avoid double counting
    const completed = taskLogs.filter(l => 
      l.message?.includes("Chunk") && 
      (l.message?.includes("完成") || l.message?.includes("completed") || l.message?.includes("处理完毕")) &&
      !l.message?.includes("LLM")
    ).length;
    const failed = taskLogs.filter(l => l.level === "error" && (l.message?.includes("Chunk") || l.stage === "processing")).length;
    const llmCalls = taskLogs.filter(l => l.message?.includes("LLM响应") || l.message?.includes("LLM response")).length;
    const fallbackUsed = taskLogs.filter(l => l.message?.includes("Fallback")).length;
    return {
      total: totalFromLogs || started,
      completed,
      failed,
      llmCalls,
      fallbackUsed,
    };
  })() : { total: 0, completed: 0, failed: 0, llmCalls: 0, fallbackUsed: 0 };

  const slicedContent = useMemo(() => {
    if (!resultContent?.content) return { content: "", totalPages: 0 };
    
    if (previewFormat === "json") {
       // For JSON, we don't pagination string content, but we could if it's an array.
       // For now, return as is.
       return { content: resultContent.content, totalPages: 1 };
    }

    // For Markdown, split by delimiter "---"
    // The format is usually Header --- Question 1 --- Question 2 ...
    const parts = resultContent.content.split(/\n-{3,}\n/);
    
    // If it's just a header or empty
    if (parts.length <= 1) return { content: resultContent.content, totalPages: 1 };

    // Filter out empty parts
    const validParts = parts.filter(p => p.trim().length > 0);
    
    // Calculate pagination
    const totalItems = validParts.length;
    const totalPages = Math.ceil(totalItems / resultPageSize);
    const currentPage = Math.min(Math.max(1, resultPage), totalPages);
    
    const start = (currentPage - 1) * resultPageSize;
    const end = start + resultPageSize;
    
    const slicedParts = validParts.slice(start, end);
    
    // If it's the first page, we might want to keep the header (index 0) if it was stripped
    // But the splitting logic makes it a list of items. 
    // Let's just join them back.
    return { 
      content: slicedParts.join("\n\n---\n\n"), 
      totalPages,
      currentPage
    };
  }, [resultContent, previewFormat, resultPage, resultPageSize]);

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

        {/* 主要内容区域 - 使用Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="status">处理状态</TabsTrigger>
            <TabsTrigger value="logs" className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              实时日志
              {task.status === "processing" && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="results">提取结果</TabsTrigger>
          </TabsList>
          
          {/* 处理状态Tab */}
          <TabsContent value="status" className="space-y-6 mt-6">
            <div className="grid gap-6 md:grid-cols-2">
              {/* 进度卡片 */}
              <Card>
                <CardHeader>
                  <CardTitle>处理进度</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>已处理: {task.processedPages}/{task.totalPages} 页</span>
                      <span>{progress.toFixed(1)}%</span>
                    </div>
                    <Progress value={progress} className="h-3" />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">当前页面</p>
                      <p className="font-medium">{task.currentPage || "--"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">预计剩余时间</p>
                      <p className="font-medium">{formatTime(task.estimatedTimeRemaining)}</p>
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
                </CardContent>
              </Card>

              {/* 统计卡片 */}
              <Card>
                <CardHeader>
                  <CardTitle>提取统计</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-muted/50 rounded-lg text-center">
                      <p className="text-3xl font-bold text-primary">{task.extractedCount}</p>
                      <p className="text-sm text-muted-foreground">提取题目数</p>
                    </div>
                    <div className="p-4 bg-muted/50 rounded-lg text-center">
                      <p className="text-3xl font-bold">{task.retryCount}</p>
                      <p className="text-sm text-muted-foreground">重试次数</p>
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
            </div>
            
            {/* 分块处理状态 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Cpu className="h-5 w-5" />
                  分块处理状态
                </CardTitle>
                <CardDescription>每个内容块的处理情况</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                  <div className="p-3 bg-muted/50 rounded-lg text-center">
                    <p className="text-2xl font-bold">{chunkStats.total}</p>
                    <p className="text-xs text-muted-foreground">总Chunk数</p>
                  </div>
                  <div className="p-3 bg-green-500/10 rounded-lg text-center">
                    <p className="text-2xl font-bold text-green-600">{chunkStats.completed}</p>
                    <p className="text-xs text-muted-foreground">已完成</p>
                  </div>
                  <div className="p-3 bg-red-500/10 rounded-lg text-center">
                    <p className="text-2xl font-bold text-red-600">{chunkStats.failed}</p>
                    <p className="text-xs text-muted-foreground">失败</p>
                  </div>
                  <div className="p-3 bg-blue-500/10 rounded-lg text-center">
                    <p className="text-2xl font-bold text-blue-600">{chunkStats.llmCalls}</p>
                    <p className="text-xs text-muted-foreground">LLM调用</p>
                  </div>
                  <div className="p-3 bg-yellow-500/10 rounded-lg text-center">
                    <p className="text-2xl font-bold text-yellow-600">{chunkStats.fallbackUsed}</p>
                    <p className="text-xs text-muted-foreground">Fallback使用</p>
                  </div>
                </div>
                
                {/* 最近的chunk处理记录 */}
                <ScrollArea className="h-48">
                  {taskLogs && taskLogs.filter(l => l.stage === "extracting").length > 0 ? (
                    <div className="space-y-2">
                      {taskLogs
                        .filter(l => l.stage === "extracting")
                        .slice(0, 20)
                        .map((log, idx) => {
                          const LevelIcon = logLevelConfig[log.level as keyof typeof logLevelConfig]?.icon || Info;
                          const levelColor = logLevelConfig[log.level as keyof typeof logLevelConfig]?.color || "text-gray-500";
                          return (
                            <div
                              key={log.id || idx}
                              className="flex items-start gap-3 p-2 rounded-lg bg-muted/30 text-sm"
                            >
                              <LevelIcon className={`h-4 w-4 mt-0.5 ${levelColor}`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground">{formatLogTime(log.createdAt)}</span>
                                  {log.chunkIndex !== null && log.totalChunks && (
                                    <Badge variant="outline" className="text-xs">
                                      Chunk {(log.chunkIndex || 0) + 1}/{log.totalChunks}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm mt-1">{String(log.message)}</p>
                                {log.details ? (
                                  <pre className="text-xs text-muted-foreground mt-1 overflow-x-auto">
                                    {typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : String(log.details)}
                                  </pre>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <p className="text-center text-muted-foreground py-8">暂无处理记录</p>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>
          
          {/* 实时日志Tab */}
          <TabsContent value="logs" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Terminal className="h-5 w-5" />
                      处理日志
                    </CardTitle>
                    <CardDescription>实时查看任务处理的详细日志</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => setAutoScroll(!autoScroll)}
                    >
                      {autoScroll ? "停止自动滚动" : "开启自动滚动"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => refetchLogs()}>
                      <RefreshCw className="mr-1 h-4 w-4" />
                      刷新
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px] w-full rounded-md border p-4 bg-black/5 dark:bg-white/5">
                  {taskLogs && taskLogs.length > 0 ? (
                    <div className="space-y-2 font-mono text-sm">
                      {[...taskLogs].reverse().map((log, idx) => {
                        const config = logLevelConfig[log.level as keyof typeof logLevelConfig] || logLevelConfig.info;
                        const LevelIcon = config.icon;
                        return (
                          <div
                            key={log.id || idx}
                            className={`flex items-start gap-3 p-2 rounded ${config.bg}`}
                          >
                            <LevelIcon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${config.color}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs text-muted-foreground">{formatLogTime(log.createdAt)}</span>
                                <Badge variant="secondary" className="text-xs">{log.stage}</Badge>
                                {log.chunkIndex !== null && log.totalChunks && (
                                  <Badge variant="outline" className="text-xs">
                                    Chunk {(log.chunkIndex || 0) + 1}/{log.totalChunks}
                                  </Badge>
                                )}
                              </div>
                              <p className={`mt-1 ${config.color}`}>{String(log.message)}</p>
                              {log.details ? (
                                <details className="mt-2">
                                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                                    查看详情
                                  </summary>
                                  <pre className="text-xs text-muted-foreground mt-1 p-2 bg-black/10 dark:bg-white/10 rounded overflow-x-auto">
                                    {typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : String(log.details)}
                                  </pre>
                                </details>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <div ref={logsEndRef} />
                    </div>
                  ) : (
                    <p className="text-center text-muted-foreground py-8">暂无日志记录</p>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>
          
          {/* 提取结果Tab */}
          <TabsContent value="results" className="mt-6">
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
                  <Tabs value={previewFormat} onValueChange={(v) => {
                    setPreviewFormat(v as "json" | "markdown");
                    setResultPage(1); // Reset page on format change
                  }}>
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
                    
                    {/* Pagination Controls */}
                    {previewFormat === "markdown" && slicedContent.totalPages > 1 && (
                      <div className="flex items-center justify-between py-4">
                        <div className="text-sm text-muted-foreground">
                          第 {slicedContent.currentPage} / {slicedContent.totalPages} 页
                        </div>
                        <div className="flex gap-2">
                          <Button 
                            variant="outline" 
                            size="sm" 
                            disabled={resultPage <= 1}
                            onClick={() => setResultPage(p => Math.max(1, p - 1))}
                          >
                            <ChevronLeft className="h-4 w-4 mr-1" />
                            上一页
                          </Button>
                          <Button 
                            variant="outline" 
                            size="sm"
                            disabled={resultPage >= slicedContent.totalPages}
                            onClick={() => setResultPage(p => Math.min(slicedContent.totalPages, p + 1))}
                          >
                            下一页
                            <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        </div>
                      </div>
                    )}

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
                      <ScrollArea className="h-[600px] w-full rounded-md border p-4">
                        {isLoadingContent ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin" />
                          </div>
                        ) : (
                          <div className="prose prose-sm max-w-none dark:prose-invert">
                            <Streamdown>{slicedContent.content || "暂无内容"}</Streamdown>
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
                  <div className="text-center text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>任务尚未完成,暂无提取结果</p>
                    <p className="text-sm mt-2">请等待任务处理完成后查看结果</p>
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
