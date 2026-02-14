import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Core user table backing auth flow.
 */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: text("email", { length: 320 }),
  loginMethod: text("loginMethod", { length: 64 }),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).defaultNow().notNull(),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * LLM API配置表 - 存储用户的API配置
 */
export const llmConfigs = sqliteTable("llm_configs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId").notNull(),
  name: text("name", { length: 128 }).notNull(), // 配置名称
  apiUrl: text("apiUrl").notNull(), // API URL
  apiKey: text("apiKey").notNull(), // API密钥(加密存储)
  modelName: text("modelName", { length: 128 }).notNull(), // 模型名称
  maxWorkers: integer("maxWorkers").default(5).notNull(), // 并发数
  timeout: integer("timeout").default(300).notNull(), // 超时时间(秒)
  contextWindow: integer("contextWindow").default(128000).notNull(), // 上下文窗口大小 (tokens)
  isDefault: integer("isDefault", { mode: "boolean" }).default(false).notNull(), // 是否为默认配置
  purpose: text("purpose", { enum: ["vision_extract", "long_context", "general"] }).default("vision_extract").notNull(), // 用途：视觉抽取 / 长文本推理 / 通用
  createdAt: integer("createdAt", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).defaultNow().notNull(),
});

export type LLMConfig = typeof llmConfigs.$inferSelect;
export type InsertLLMConfig = typeof llmConfigs.$inferInsert;

/**
 * 提取任务表 - 存储每个教材的提取任务
 */
export const extractionTasks = sqliteTable("extraction_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId").notNull(),
  configId: integer("configId"), // 关联的LLM配置（题目抽取用）
  chapterConfigId: integer("chapterConfigId"), // 关联的LLM配置（章节预处理用）
  name: text("name", { length: 256 }).notNull(), // 任务名称(教材名)
  status: text("status", { enum: ["pending", "processing", "completed", "failed", "paused"] }).default("pending").notNull(),
  
  // 文件信息
  sourceFolder: text("sourceFolder").notNull(), // MinerU输出文件夹路径(S3)
  markdownPath: text("markdownPath"), // markdown文件路径
  contentListPath: text("contentListPath"), // content_list.json路径
  imagesFolder: text("imagesFolder"), // images文件夹路径
  
  // 进度信息
  totalPages: integer("totalPages").default(0).notNull(), // 总页数
  processedPages: integer("processedPages").default(0).notNull(), // 已处理页数
  currentPage: integer("currentPage").default(0).notNull(), // 当前处理页
  startedAt: integer("startedAt", { mode: "timestamp" }), // 开始时间
  completedAt: integer("completedAt", { mode: "timestamp" }), // 完成时间
  estimatedTimeRemaining: integer("estimatedTimeRemaining"), // 预计剩余时间(秒)
  
  // 结果信息
  resultJsonPath: text("resultJsonPath"), // 结果JSON路径
  resultMarkdownPath: text("resultMarkdownPath"), // 结果Markdown路径
  extractedCount: integer("extractedCount").default(0).notNull(), // 提取的题目数量
  
  // 错误信息
  errorMessage: text("errorMessage"),
  retryCount: integer("retryCount").default(0).notNull(),
  
  // 任务族系
  parentTaskId: integer("parentTaskId"), // 父任务ID
  rootTaskId: integer("rootTaskId"), // 根任务ID (用于快速查询整个族系)
  
  createdAt: integer("createdAt", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).defaultNow().notNull(),
});

export type ExtractionTask = typeof extractionTasks.$inferSelect;
export type InsertExtractionTask = typeof extractionTasks.$inferInsert;

/**
 * 页面处理记录表 - 记录每个页面的处理状态(用于断点恢复)
 */
export const pageProcessingLogs = sqliteTable("page_processing_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("taskId").notNull(),
  pageIndex: integer("pageIndex").notNull(), // 页面索引
  status: text("status", { enum: ["pending", "processing", "completed", "failed"] }).default("pending").notNull(),
  inputImages: text("inputImages", { mode: "json" }), // 输入的图片列表
  outputText: text("outputText"), // LLM输出的原始文本
  extractedQuestions: text("extractedQuestions", { mode: "json" }), // 提取的题目列表
  errorMessage: text("errorMessage"),
  processingTime: integer("processingTime"), // 处理耗时(毫秒)
  createdAt: integer("createdAt", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).defaultNow().notNull(),
});

export type PageProcessingLog = typeof pageProcessingLogs.$inferSelect;
export type InsertPageProcessingLog = typeof pageProcessingLogs.$inferInsert;

/**
 * 任务日志表 - 记录任务处理过程中的详细日志
 */
export const taskLogs = sqliteTable("task_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("taskId").notNull(),
  level: text("level", { enum: ["info", "warn", "error", "debug"] }).default("info").notNull(),
  stage: text("stage", { length: 64 }), // 处理阶段: loading, chunking, extracting, merging, saving
  chunkIndex: integer("chunkIndex"), // 当前处理的chunk索引
  totalChunks: integer("totalChunks"), // 总 chunk数
  message: text("message").notNull(), // 日志消息
  details: text("details", { mode: "json" }), // 详细信息(JSON)
  createdAt: integer("createdAt", { mode: "timestamp" }).defaultNow().notNull(),
});

export type TaskLog = typeof taskLogs.$inferSelect;
export type InsertTaskLog = typeof taskLogs.$inferInsert;

/**
 * 审计日志表 - 用于Mineral-Aligner合规性审查
 */
export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stage: text("stage", { length: 64 }).notNull(),
  inputLen: integer("inputLen"),
  outputLen: integer("outputLen"),
  rejectReason: text("rejectReason"),
  fallbackUsed: integer("fallbackUsed", { mode: "boolean" }),
  timestamp: integer("timestamp").notNull(),
  taskId: text("taskId"),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
