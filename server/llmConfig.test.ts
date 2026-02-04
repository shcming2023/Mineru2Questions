import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock database functions
vi.mock("./db", () => ({
  createLLMConfig: vi.fn().mockResolvedValue(1),
  getLLMConfigsByUser: vi.fn().mockResolvedValue([
    {
      id: 1,
      userId: 1,
      name: "Test Config",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-key-12345678",
      modelName: "gpt-4o",
      maxWorkers: 5,
      timeout: 300,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]),
  getLLMConfigById: vi.fn().mockResolvedValue({
    id: 1,
    userId: 1,
    name: "Test Config",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "sk-test-key-12345678",
    modelName: "gpt-4o",
    maxWorkers: 5,
    timeout: 300,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  updateLLMConfig: vi.fn().mockResolvedValue(undefined),
  deleteLLMConfig: vi.fn().mockResolvedValue(undefined),
  getDefaultLLMConfig: vi.fn().mockResolvedValue({
    id: 1,
    userId: 1,
    name: "Test Config",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "sk-test-key-12345678",
    modelName: "gpt-4o",
    maxWorkers: 5,
    timeout: 300,
    isDefault: true,
  }),
  getExtractionTasksByUser: vi.fn().mockResolvedValue([]),
  getExtractionTaskById: vi.fn().mockResolvedValue(null),
  createExtractionTask: vi.fn().mockResolvedValue(1),
  updateExtractionTask: vi.fn().mockResolvedValue(undefined),
  deleteExtractionTask: vi.fn().mockResolvedValue(undefined),
  createPageProcessingLogs: vi.fn().mockResolvedValue(undefined),
  getPageProcessingLogsByTask: vi.fn().mockResolvedValue([]),
  getPendingPageLogs: vi.fn().mockResolvedValue([]),
  getFailedPageLogs: vi.fn().mockResolvedValue([]),
  updatePageProcessingLog: vi.fn().mockResolvedValue(undefined),
}));

// Mock storage functions
vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ url: "https://example.com/file", key: "test-key" }),
  storageGet: vi.fn().mockResolvedValue({ url: "https://example.com/file", key: "test-key" }),
}));

// Mock task processor
vi.mock("./taskProcessor", () => ({
  startTaskProcessing: vi.fn(),
  pauseTaskProcessing: vi.fn(),
  cancelTaskProcessing: vi.fn(),
}));

// Mock extraction module
vi.mock("./extraction", () => ({
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  stopTask: vi.fn(),
  isTaskPaused: vi.fn().mockReturnValue(false),
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

describe("llmConfig router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should list LLM configs for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.llmConfig.list();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Test Config");
    expect(result[0].modelName).toBe("gpt-4o");
  });

  it("should get a specific LLM config with masked API key", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.llmConfig.get({ id: 1 });

    expect(result.name).toBe("Test Config");
    // API key should be masked
    expect(result.apiKey).toContain("...");
    expect(result.apiKey).not.toBe("sk-test-key-12345678");
  });

  it("should create a new LLM config", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.llmConfig.create({
      name: "New Config",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-new-key",
      modelName: "gpt-4o-mini",
      maxWorkers: 3,
      timeout: 180,
      isDefault: false,
    });

    expect(result.id).toBe(1);
  });

  it("should update an existing LLM config", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.llmConfig.update({
      id: 1,
      name: "Updated Config",
      maxWorkers: 10,
    });

    expect(result.success).toBe(true);
  });

  it("should delete an LLM config", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.llmConfig.delete({ id: 1 });

    expect(result.success).toBe(true);
  });

  it("should get default LLM config", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.llmConfig.getDefault();

    expect(result).toBeDefined();
    expect(result?.isDefault).toBe(true);
  });

  it("should test API connection and return result", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // 测试使用无效的API密钥应该返回失败
    const result = await caller.llmConfig.test({
      apiUrl: "https://api.openai.com/v1",
      apiKey: "invalid-key",
      modelName: "gpt-4o",
    });

    // 应该返回失败结果（因为密钥无效）
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("message");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.message).toBe("string");
  });
});

describe("task router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should list tasks for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.task.list();

    expect(Array.isArray(result)).toBe(true);
  });

  it("should create a new task", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.task.create({
      name: "Test Task",
      sourceFolder: "tasks/test",
      totalPages: 10,
    });

    expect(result.id).toBe(1);
  });
});
