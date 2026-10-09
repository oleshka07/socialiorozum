// 🔤 Мовні версії відео при публікації: мережа хоче субтитри своєю мовою (свій вибір поста в
// channels.<мережа>.sub_lang, інакше «Стиль відео» бренду) - беремо версію цією мовою, яку зробив монтаж.
// Версії нема (фото, відео без тексту, змонтоване до того, як мову обрали) - іде оригінал, і людина
// бачить про це примітку, а не дізнається з мережі.
import { q } from "./db.js";
import { getSettingText } from "./settings.js";
import * as P from "./montage-plan.js";
import type { PostMedia } from "./slides.js";

/** Мова субтитрів кожної мережі зі «Стилю відео» бренду. */
export async function styleSubLangs(ws: string): Promise<Record<string, string>> {
  try { return P.normMontageStyle(JSON.parse((await getSettingText(ws, "montage_style")) || "null")).langs; }
  catch { return {}; }
}

export type SubPick = { frames: PostMedia[]; lang: string | null; note: string };
const by = (l: string | null | undefined) => (l ? P.SUB_LANGS[l]?.by || l : "");

/**
 * Хто вибирає версії для однієї публікації: пам'ятає вже знайдені версії (кілька акаунтів однієї мережі,
 * кілька мереж з однією мовою - один запит на мову).
 */
export async function subPicker(ws: string, ch: any, langs?: Record<string, string>) {
  const style = langs ?? await styleSubLangs(ws);
  const memo = new Map<string, Map<string, PostMedia>>();
  const variantsOf = async (ids: string[], lang: string): Promise<Map<string, PostMedia>> => {
    const key = lang + "|" + ids.join(",");
    let m = memo.get(key);
    if (!m) {
      const rows = ids.length ? await q<PostMedia & { variant_of: string }>(
        `select id, filename, kind, source, size, duration, width, height, alt_text, sub_lang, variant_of from media_asset
          where workspace_id=$1 and variant_of = any($2::uuid[]) and sub_lang=$3`, [ws, ids, lang]) : [];
      m = new Map(rows.map((r) => [r.variant_of, r]));
      memo.set(key, m);
    }
    return m;
  };
  return {
    /** Якою мовою мережа хоче субтитри (null - як говорять, тобто оригінал). */
    langFor: (net: string) => P.subLangFor(ch, style, net),
    /** Кадри для мережі: кожен відео-кадр із субтитрами - у версії потрібною мовою, якщо вона є. */
    async frames(list: PostMedia[], net: string): Promise<SubPick> {
      const want = P.subLangFor(ch, style, net);
      if (!want) return { frames: list, lang: null, note: "" };
      // субтитрів нема зовсім (фото, своє відео без монтажу) - і мови в них нема
      if (!list.some((f) => f.kind === "video" && f.sub_lang)) return { frames: list, lang: null, note: "" };
      const need = list.filter((f) => f.kind === "video" && f.sub_lang && f.sub_lang !== want);
      if (!need.length) return { frames: list, lang: want, note: "" };
      const vars = await variantsOf(need.map((f) => f.id), want);
      const missing = need.filter((f) => !vars.has(f.id));
      const out = list.map((f) => vars.get(f.id) || f);
      const orig = missing[0]?.sub_lang || null;
      return {
        // мова, якою кадри справді підуть (версії бракує - мова оригіналу)
        frames: out, lang: missing.length ? orig : want,
        note: missing.length ? `версії з субтитрами ${by(want)} нема - пішли субтитри ${by(orig)} (щоб була, змонтуй ще раз: мови - в «Стилі відео»)` : "",
      };
    },
  };
}
