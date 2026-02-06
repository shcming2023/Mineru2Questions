import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createLLMConfig,
  getLLMConfigsByUser,
  getLLMConfigById,
  updateLLMConfig,
  deleteLLMConfig,
  getDefaultLLMConfig,
  createExtractionTask,
  getExtractionTasksByUser,
  getExtractionTaskById,
  updateExtractionTask,
  deleteExtractionTask,
  createPageProcessingLogs,
  getPageProcessingLogsByTask,
  updatePageProcessingLog,
  getPendingPageLogs,
  getFailedPageLogs,
  getTaskLogs
} from "./db";
import { storagePut, storageGet } from "./storage";
import { pauseTask, resumeTask, cancelTask, isTaskPaused } from "./extraction";
import { startTaskProcessing, pauseTaskProcessing, cancelTaskProcessing } from "./taskProcessor";

// LLM配置路由
const llmConfigRouter = router({
  // 获取用户所有配置
  list: protectedProcedure.query(async ({ ctx }) => {
    return await getLLMConfigsByUser(ctx.user.id);
  }),
  
  // 获取单个配置
  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const config = await getLLMConfigById(input.id, ctx.user.id);
      if (!config) {
        throw new TRPCError({ code: "NOT_FOUND", message: "配置不存在" });
      }
      // 不返回完整的API密钥,只返回掩码版本
      return {
        ...config,
        apiKey: config.apiKey.substring(0, 8) + "..." + config.apiKey.substring(config.apiKey.length - 4)
      };
    }),
  
  // 获取默认配置
  getDefault: protectedProcedure.query(async ({ ctx }) => {
    return await getDefaultLLMConfig(ctx.user.id);
  }),
  
  // 创建配置
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(128),
      apiUrl: z.string().url(),
      apiKey: z.string().min(1),
      modelName: z.string().min(1).max(128),
      maxWorkers: z.number().min(1).max(50).default(5),
      timeout: z.number().min(30).max(1800).default(300),
      isDefault: z.boolean().default(false)
    }))
    .mutation(async ({ ctx, input }) => {
      const id = await createLLMConfig({
        ...input,
        userId: ctx.user.id
      });
      return { id };
    }),
  
  // 更新配置
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(128).optional(),
      apiUrl: z.string().url().optional(),
      apiKey: z.string().min(1).optional(),
      modelName: z.string().min(1).max(128).optional(),
      maxWorkers: z.number().min(1).max(50).optional(),
      timeout: z.number().min(30).max(1800).optional(),
      isDefault: z.boolean().optional()
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;
      await updateLLMConfig(id, ctx.user.id, updates);
      return { success: true };
    }),
  
  // 删除配置
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await deleteLLMConfig(input.id, ctx.user.id);
      return { success: true };
    }),
  
  // 测试API连接
  test: protectedProcedure
    .input(z.object({
      apiUrl: z.string().url(),
      apiKey: z.string().min(1),
      modelName: z.string().min(1)
    }))
    .mutation(async ({ input }) => {
      try {
        const axios = (await import("axios")).default;
        const response = await axios.post(
          `${input.apiUrl}/chat/completions`,
          {
            model: input.modelName,
            messages: [{ role: "user", content: "Hello, this is a test message. Please respond with 'OK'." }],
            max_tokens: 10
          },
          {
            headers: {
              "Authorization": `Bearer ${input.apiKey}`,
              "Content-Type": "application/json"
            },
            timeout: 30000
          }
        );
        
        if (response.data?.choices?.[0]?.message?.content) {
          return { success: true, message: "API连接成功" };
        }
        return { success: false, message: "API响应格式异常" };
      } catch (error: any) {
        return { 
          success: false, 
          message: error.response?.data?.error?.message || error.message || "连接失败" 
        };
      }
    })
});

// 提取任务路由
const taskRouter = router({
  // 获取用户所有任务
  list: protectedProcedure.query(async ({ ctx }) => {
    return await getExtractionTasksByUser(ctx.user.id);
  }),
  
  // 获取单个任务详情
  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.id, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      return task;
    }),
  
  // 获取任务的页面处理日志
  getPageLogs: protectedProcedure
    .input(z.object({ taskId: z.number() }))
    .query(async ({ ctx, input }) => {
      // 先验证任务属于当前用户
      const task = await getExtractionTaskById(input.taskId, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      return await getPageProcessingLogsByTask(input.taskId);
    }),
  
  // 获取任务的详细处理日志(包含LLM调用信息)
  getLogs: protectedProcedure
    .input(z.object({ 
      taskId: z.number(),
      limit: z.number().min(1).max(500).optional().default(100)
    }))
    .query(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.taskId, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      return await getTaskLogs(input.taskId, input.limit);
    }),
  
  // 创建新任务
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(256),
      configId: z.number().optional(),
      sourceFolder: z.string(), // S3文件夹路径
      markdownPath: z.string().optional(),
      contentListPath: z.string().optional(),
      imagesFolder: z.string().optional(),
      totalPages: z.number().min(1)
    }))
    .mutation(async ({ ctx, input }) => {
      // 如果没有指定配置,使用默认配置
      let configId = input.configId;
      if (!configId) {
        const defaultConfig = await getDefaultLLMConfig(ctx.user.id);
        if (defaultConfig) {
          configId = defaultConfig.id;
        }
      }
      
      const id = await createExtractionTask({
        ...input,
        configId,
        userId: ctx.user.id,
        status: "pending"
      });
      
      // 创建页面处理日志
      const pageLogs = [];
      for (let i = 0; i < input.totalPages - 1; i++) {
        pageLogs.push({
          taskId: id,
          pageIndex: i,
          status: "pending" as const
        });
      }
      await createPageProcessingLogs(pageLogs);
      
      return { id };
    }),
  
  // 开始/恢复任务
  start: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.id, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status === "processing") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "任务已在处理中" });
      }
      
      if (task.status === "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "任务已完成" });
      }
      
      // 更新状态为处理中
      await updateExtractionTask(input.id, {
        status: "processing",
        startedAt: task.startedAt || new Date()
      });
      
      resumeTask(input.id);
      
      // 启动任务处理
      startTaskProcessing(input.id, ctx.user.id);
      
      return { success: true };
    }),
  
  // 暂停任务
  pause: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.id, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status !== "processing") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "只能暂停处理中的任务" });
      }
      
      pauseTaskProcessing(input.id);
      await updateExtractionTask(input.id, { status: "paused" });
      
      return { success: true };
    }),
  
  // 重试失败的任务
  retry: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.id, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status !== "failed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "只能重试失败的任务" });
      }
      
      // 重置失败的页面状态
      const failedLogs = await getFailedPageLogs(input.id);
      for (const log of failedLogs) {
        await updatePageProcessingLog(log.id, { 
          status: "pending",
          errorMessage: null
        });
      }
      
      await updateExtractionTask(input.id, {
        status: "pending",
        errorMessage: null,
        retryCount: task.retryCount + 1
      });
      
      return { success: true };
    }),
  
  // 删除任务
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.id, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status === "processing") {
        cancelTaskProcessing(input.id);
      }
      
      await deleteExtractionTask(input.id, ctx.user.id);
      return { success: true };
    }),
  
  // 更新任务进度(内部使用)
  updateProgress: protectedProcedure
    .input(z.object({
      id: z.number(),
      processedPages: z.number(),
      currentPage: z.number(),
      estimatedTimeRemaining: z.number().optional()
    }))
    .mutation(async ({ ctx, input }) => {
      await updateExtractionTask(input.id, {
        processedPages: input.processedPages,
        currentPage: input.currentPage,
        estimatedTimeRemaining: input.estimatedTimeRemaining
      });
      return { success: true };
    })
});

// 文件上传路由
const uploadRouter = router({
  // 获取上传预签名URL
  getUploadUrl: protectedProcedure
    .input(z.object({
      fileName: z.string(),
      fileType: z.string(),
      taskName: z.string()
    }))
    .mutation(async ({ ctx, input }) => {
      const timestamp = Date.now();
      const fileKey = `tasks/${ctx.user.id}/${input.taskName}-${timestamp}/${input.fileName}`;
      
      // 使用storagePut获取URL(这里我们返回key供前端使用)
      return { 
        fileKey,
        uploadPath: fileKey
      };
    }),
  
  // 上传文件内容
  uploadFile: protectedProcedure
    .input(z.object({
      fileKey: z.string(),
      content: z.string(), // base64编码的内容
      contentType: z.string()
    }))
    .mutation(async ({ input }) => {
      const buffer = Buffer.from(input.content, 'base64');
      const result = await storagePut(input.fileKey, buffer, input.contentType);
      return { url: result.url, key: result.key };
    }),
  
  // 获取文件下载URL
  getDownloadUrl: protectedProcedure
    .input(z.object({ fileKey: z.string() }))
    .query(async ({ input }) => {
      const result = await storageGet(input.fileKey);
      return { url: result.url };
    })
});

// 结果路由
const resultRouter = router({
  // 获取结果文件内容
  getContent: protectedProcedure
    .input(z.object({ 
      taskId: z.number(),
      format: z.enum(["json", "markdown"])
    }))
    .query(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.taskId, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status !== "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "任务尚未完成" });
      }
      
      const filePath = input.format === "json" ? task.resultJsonPath : task.resultMarkdownPath;
      if (!filePath) {
        return { content: "", format: input.format };
      }
      
      try {
        const { url } = await storageGet(filePath);
        const axios = (await import("axios")).default;
        const response = await axios.get(url, { timeout: 30000 });
        return { content: typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2), format: input.format };
      } catch (error) {
        return { content: "无法加载结果文件", format: input.format };
      }
    }),

  // 获取任务结果预览
  preview: protectedProcedure
    .input(z.object({ 
      taskId: z.number(),
      format: z.enum(["json", "markdown"])
    }))
    .query(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.taskId, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status !== "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "任务尚未完成" });
      }
      
      const filePath = input.format === "json" ? task.resultJsonPath : task.resultMarkdownPath;
      if (!filePath) {
        throw new TRPCError({ code: "NOT_FOUND", message: "结果文件不存在" });
      }
      
      const { url } = await storageGet(filePath);
      return { url, format: input.format };
    }),
  
  // 获取下载链接
  getDownloadLinks: protectedProcedure
    .input(z.object({ taskId: z.number() }))
    .query(async ({ ctx, input }) => {
      const task = await getExtractionTaskById(input.taskId, ctx.user.id);
      if (!task) {
        throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在" });
      }
      
      if (task.status !== "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "任务尚未完成" });
      }
      
      const links: { name: string; url: string; type: string }[] = [];
      
      if (task.resultJsonPath) {
        const { url } = await storageGet(task.resultJsonPath);
        links.push({ name: `${task.name}_questions.json`, url, type: "json" });
      }
      
      if (task.resultMarkdownPath) {
        const { url } = await storageGet(task.resultMarkdownPath);
        links.push({ name: `${task.name}_questions.md`, url, type: "markdown" });
      }
      
      return { links, extractedCount: task.extractedCount };
    })
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  
  llmConfig: llmConfigRouter,
  task: taskRouter,
  upload: uploadRouter,
  result: resultRouter
});

export type AppRouter = typeof appRouter;
