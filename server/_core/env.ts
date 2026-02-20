export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // 保留 forgeApiUrl/forgeApiKey 供其他 _core 模块使用 (dataApi, imageGeneration, llm, notification, voiceTranscription, storage)
  // 这些是 Manus WebDev 模板的遗留代码,与 Mineru2Questions 项目无关,但不影响运行
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
