export const env = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? "",
  appBaseUrl: (process.env.APP_BASE_URL ?? "https://socialio.rozum.one").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me",
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    referer: process.env.OPENROUTER_REFERER ?? "",
    title: process.env.OPENROUTER_TITLE ?? "KontentGrov",
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM ?? "socialio <onboarding@resend.dev>",
  },
};

if (!env.databaseUrl) console.warn("[env] DATABASE_URL не заданий");
if (!env.openrouter.apiKey) console.warn("[env] OPENROUTER_API_KEY не заданий — кроки LLM не працюватимуть");
if (!env.resend.apiKey) console.warn("[env] RESEND_API_KEY не заданий — лист верифікації/скидання не надсилатимуться");
if (env.sessionSecret === "dev-insecure-secret-change-me") console.warn("[env] SESSION_SECRET дефолтний — задай свій у .env");
