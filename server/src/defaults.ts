// Дефолтні блоки налаштувань - сід для кожного нового workspace (і для міграції).
export const DEFAULT_SETTINGS: Record<string, string> = {
  // ніша/аудиторія, голос і контент-стратегія НЕ хардкодимо - заповнюються в онбордингу
  // або автоматично виводяться з постів Instagram (deriveBrandFromText).
  marketing_context: "",
  tone_of_voice: "",
  deai_rules:
    "Прибрати ознаки AI: довге тире замінити, прибрати штампи й надмірну симетрію. Зберегти зміст.",
  content_strategy: "",
  output_language: "Українська",
  voice_examples: "",
};

// Дефолтні рубрики (контент-мікс) для нового workspace.
export const DEFAULT_RUBRICS = [
  { name: "Освітнє", emoji: "📚", description: "Гайди, поради, туторіали, галузеві знання", share: 35 },
  { name: "Промо", emoji: "🛍️", description: "Запуски продуктів, пропозиції, послуги, заклики до дії", share: 20 },
  { name: "Розважальне", emoji: "🎭", description: "Меми, життєвий контент, тренди, гумор", share: 15 },
  { name: "Спільнота", emoji: "🤝", description: "Історії користувачів, Q&A, опитування, пости для залучення", share: 20 },
  { name: "За лаштунками", emoji: "🏢", description: "Команда, процеси, культура, будні компанії", share: 10 },
];
