import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { 
  InsertUser, users, 
  llmConfigs, InsertLLMConfig, LLMConfig,
  extractionTasks, InsertExtractionTask, ExtractionTask,
  pageProcessingLogs, InsertPageProcessingLog, PageProcessingLog
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ==================== User Functions ====================

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ==================== LLM Config Functions ====================

export async function createLLMConfig(config: InsertLLMConfig): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // 如果设为默认,先取消其他默认配置
  if (config.isDefault) {
    await db.update(llmConfigs)
      .set({ isDefault: false })
      .where(eq(llmConfigs.userId, config.userId));
  }
  
  const result = await db.insert(llmConfigs).values(config);
  return result[0].insertId;
}

export async function getLLMConfigsByUser(userId: number): Promise<LLMConfig[]> {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(llmConfigs)
    .where(eq(llmConfigs.userId, userId))
    .orderBy(desc(llmConfigs.createdAt));
}

export async function getLLMConfigById(id: number, userId: number): Promise<LLMConfig | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(llmConfigs)
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.userId, userId)))
    .limit(1);
  
  return result[0];
}

export async function updateLLMConfig(id: number, userId: number, updates: Partial<InsertLLMConfig>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // 如果设为默认,先取消其他默认配置
  if (updates.isDefault) {
    await db.update(llmConfigs)
      .set({ isDefault: false })
      .where(eq(llmConfigs.userId, userId));
  }
  
  await db.update(llmConfigs)
    .set(updates)
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.userId, userId)));
}

export async function deleteLLMConfig(id: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.delete(llmConfigs)
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.userId, userId)));
}

export async function getDefaultLLMConfig(userId: number): Promise<LLMConfig | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(llmConfigs)
    .where(and(eq(llmConfigs.userId, userId), eq(llmConfigs.isDefault, true)))
    .limit(1);
  
  return result[0];
}

// ==================== Extraction Task Functions ====================

export async function createExtractionTask(task: InsertExtractionTask): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(extractionTasks).values(task);
  return result[0].insertId;
}

export async function getExtractionTasksByUser(userId: number): Promise<ExtractionTask[]> {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(extractionTasks)
    .where(eq(extractionTasks.userId, userId))
    .orderBy(desc(extractionTasks.createdAt));
}

export async function getExtractionTaskById(id: number, userId: number): Promise<ExtractionTask | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(extractionTasks)
    .where(and(eq(extractionTasks.id, id), eq(extractionTasks.userId, userId)))
    .limit(1);
  
  return result[0];
}

export async function updateExtractionTask(id: number, updates: Partial<InsertExtractionTask>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.update(extractionTasks)
    .set(updates)
    .where(eq(extractionTasks.id, id));
}

export async function deleteExtractionTask(id: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // 先删除关联的页面处理记录
  await db.delete(pageProcessingLogs)
    .where(eq(pageProcessingLogs.taskId, id));
  
  await db.delete(extractionTasks)
    .where(and(eq(extractionTasks.id, id), eq(extractionTasks.userId, userId)));
}

// ==================== Page Processing Log Functions ====================

export async function createPageProcessingLogs(logs: InsertPageProcessingLog[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  if (logs.length > 0) {
    await db.insert(pageProcessingLogs).values(logs);
  }
}

export async function getPageProcessingLogsByTask(taskId: number): Promise<PageProcessingLog[]> {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(pageProcessingLogs)
    .where(eq(pageProcessingLogs.taskId, taskId))
    .orderBy(pageProcessingLogs.pageIndex);
}

export async function updatePageProcessingLog(id: number, updates: Partial<InsertPageProcessingLog>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.update(pageProcessingLogs)
    .set(updates)
    .where(eq(pageProcessingLogs.id, id));
}

export async function getPendingPageLogs(taskId: number): Promise<PageProcessingLog[]> {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(pageProcessingLogs)
    .where(and(
      eq(pageProcessingLogs.taskId, taskId),
      eq(pageProcessingLogs.status, "pending")
    ))
    .orderBy(pageProcessingLogs.pageIndex);
}

export async function getFailedPageLogs(taskId: number): Promise<PageProcessingLog[]> {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(pageProcessingLogs)
    .where(and(
      eq(pageProcessingLogs.taskId, taskId),
      eq(pageProcessingLogs.status, "failed")
    ))
    .orderBy(pageProcessingLogs.pageIndex);
}
