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
  // Модель для дешевих/неважливих кроків (метчинг, теми плану, ідеї, хештеги, інсайти).
  // За замовч. gpt-4o-mini; постав CHEAP_MODEL=google/gemini-2.5-flash у .env → підуть на Gemini (безкоштовний тариф).
  cheapModel: process.env.CHEAP_MODEL || "openai/gpt-4o-mini",
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",   // прямий OpenAI для Lite (дешевше за наценку OpenRouter) + gpt-image-1
  },
  fal: {
    apiKey: process.env.FAL_KEY ?? "",           // FLUX schnell (найдешевші зображення)
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",    // Gemini 2.5 Flash Image (Nano Banana)
  },
  telegram: {                                     // СПІЛЬНИЙ бот (користувач не створює свій)
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "",
    webhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.SESSION_SECRET || "tgwh").slice(0, 48),
  },
  beta: {
    pin: process.env.BETA_PIN ?? "",              // задано -> інстанс є БЕТОЮ: PIN-гейт на вході (прод не задає)
    telegramWebhookOff: process.env.TELEGRAM_WEBHOOK_OFF === "1", // бета НЕ реєструє webhook (не краде його в прода)
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM ?? "socialio <onboarding@resend.dev>",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    apiKey: process.env.GOOGLE_API_KEY ?? "",   // browser key для Google Picker
  },
  threads: {
    appId: process.env.THREADS_APP_ID ?? "",
    appSecret: process.env.THREADS_APP_SECRET ?? "",
  },
  meta: {
    appId: process.env.META_APP_ID ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
  },
  adminEmails: (process.env.ADMIN_EMAILS ?? "o.stepeniev@swipescape.eu,stepenievgroup@gmail.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
};

if (!env.databaseUrl) console.warn("[env] DATABASE_URL не заданий");
if (!env.openrouter.apiKey) console.warn("[env] OPENROUTER_API_KEY не заданий — кроки LLM не працюватимуть");
if (!env.resend.apiKey) console.warn("[env] RESEND_API_KEY не заданий — лист верифікації/скидання не надсилатимуться");
if (env.sessionSecret === "dev-insecure-secret-change-me") console.warn("[env] SESSION_SECRET дефолтний — задай свій у .env");
