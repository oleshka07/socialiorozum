export const env = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? "",
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    referer: process.env.OPENROUTER_REFERER ?? "",
    title: process.env.OPENROUTER_TITLE ?? "KontentGrov",
  },
};

if (!env.databaseUrl) console.warn("[env] DATABASE_URL не заданий");
if (!env.openrouter.apiKey) console.warn("[env] OPENROUTER_API_KEY не заданий — кроки LLM не працюватимуть");
