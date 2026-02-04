import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, boolean } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * LLM API配置表 - 存储用户的API配置
 */
export const llmConfigs = mysqlTable("llm_configs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 128 }).notNull(), // 配置名称
  apiUrl: text("apiUrl").notNull(), // API URL
  apiKey: text("apiKey").notNull(), // API密钥(加密存储)
  modelName: varchar("modelName", { length: 128 }).notNull(), // 模型名称
  maxWorkers: int("maxWorkers").default(5).notNull(), // 并发数
  timeout: int("timeout").default(300).notNull(), // 超时时间(秒)
  isDefault: boolean("isDefault").default(false).notNull(), // 是否为默认配置
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type LLMConfig = typeof llmConfigs.$inferSelect;
export type InsertLLMConfig = typeof llmConfigs.$inferInsert;

/**
 * 提取任务表 - 存储每个教材的提取任务
 */
export const extractionTasks = mysqlTable("extraction_tasks", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  configId: int("configId"), // 关联的LLM配置
  name: varchar("name", { length: 256 }).notNull(), // 任务名称(教材名)
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed", "paused"]).default("pending").notNull(),
  
  // 文件信息
  sourceFolder: text("sourceFolder").notNull(), // MinerU输出文件夹路径(S3)
  markdownPath: text("markdownPath"), // markdown文件路径
  contentListPath: text("contentListPath"), // content_list.json路径
  imagesFolder: text("imagesFolder"), // images文件夹路径
  
  // 进度信息
  totalPages: int("totalPages").default(0).notNull(), // 总页数
  processedPages: int("processedPages").default(0).notNull(), // 已处理页数
  currentPage: int("currentPage").default(0).notNull(), // 当前处理页
  startedAt: timestamp("startedAt"), // 开始时间
  completedAt: timestamp("completedAt"), // 完成时间
  estimatedTimeRemaining: int("estimatedTimeRemaining"), // 预计剩余时间(秒)
  
  // 结果信息
  resultJsonPath: text("resultJsonPath"), // 结果JSON路径
  resultMarkdownPath: text("resultMarkdownPath"), // 结果Markdown路径
  extractedCount: int("extractedCount").default(0).notNull(), // 提取的题目数量
  
  // 错误信息
  errorMessage: text("errorMessage"),
  retryCount: int("retryCount").default(0).notNull(),
  
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ExtractionTask = typeof extractionTasks.$inferSelect;
export type InsertExtractionTask = typeof extractionTasks.$inferInsert;

/**
 * 页面处理记录表 - 记录每个页面的处理状态(用于断点恢复)
 */
export const pageProcessingLogs = mysqlTable("page_processing_logs", {
  id: int("id").autoincrement().primaryKey(),
  taskId: int("taskId").notNull(),
  pageIndex: int("pageIndex").notNull(), // 页面索引
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed"]).default("pending").notNull(),
  inputImages: json("inputImages"), // 输入的图片列表
  outputText: text("outputText"), // LLM输出的原始文本
  extractedQuestions: json("extractedQuestions"), // 提取的题目列表
  errorMessage: text("errorMessage"),
  processingTime: int("processingTime"), // 处理耗时(毫秒)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type PageProcessingLog = typeof pageProcessingLogs.$inferSelect;
export type InsertPageProcessingLog = typeof pageProcessingLogs.$inferInsert;
