// 🎬 YouTube і TikTok у пості: що обрала людина (channels.youtube / channels.tiktok) і як це сказати.
// Чисті функції - їх ділять публікатор, композер (через API), конектор Claude і бот.
//
// channels.youtube = { on, text (опис), title, privacy: public|unlisted|private, kids, ai }
// channels.tiktok  = { on, text (підпис), mode: direct|draft, privacy, comment, duet, stitch, your_brand, branded, ai }
// TikTok вимагає, щоб «Хто бачить» обирала людина (типового значення нема), а коментарі/Duet/Stitch
// були вимкнені, поки їх не ввімкнуть. Без обраного «Хто бачить» відео йде в чернетки TikTok - туди
// його можна надіслати завжди, решту людина обере в самому застосунку.
import { PRIVACY, PRIVACY_UA, type TtPost } from "./tiktok.js";
import { YT_PRIVACY, YT_PRIVACY_UA, type YtPrivacy, cleanTitle } from "./youtube.js";

export const VIDEO_NETS = ["youtube", "tiktok"];   // приймають лише відео

export type YtOpts = { title: string; privacy: YtPrivacy; kids: boolean; ai: boolean };
export function ytOpts(c: any): YtOpts {
  const o = c && typeof c === "object" ? c : {};
  return {
    title: cleanTitle(String(o.title || "")),
    privacy: (YT_PRIVACY as string[]).includes(o.privacy) ? o.privacy : "public",
    kids: o.kids === true, ai: o.ai === true,
  };
}

export type TtOpts = { mode: "direct" | "draft"; privacy: string; comment: boolean; duet: boolean; stitch: boolean; yourBrand: boolean; branded: boolean; ai: boolean };
export function ttOpts(c: any): TtOpts {
  const o = c && typeof c === "object" ? c : {};
  const privacy = (PRIVACY as readonly string[]).includes(o.privacy) ? String(o.privacy) : "";
  const mode = o.mode === "draft" ? "draft" : o.mode === "direct" ? "direct" : privacy ? "direct" : "draft";
  return {
    mode, privacy,
    comment: o.comment === true, duet: o.duet === true, stitch: o.stitch === true,
    yourBrand: o.your_brand === true, branded: o.branded === true, ai: o.ai === true,
  };
}
export const ttPost = (o: TtOpts, title: string): TtPost => ({
  title, privacy: o.privacy,
  allowComment: o.comment, allowDuet: o.duet, allowStitch: o.stitch,
  yourBrand: o.yourBrand, brandedContent: o.branded, aigc: o.ai,
});

// Один рядок для людини: що станеться з постом у мережі.
export function ytLine(o: YtOpts, fallbackTitle = ""): string {
  const t = o.title || fallbackTitle;
  return [t ? `«${t}»` : "назва - перший рядок тексту", `бачать: ${YT_PRIVACY_UA[o.privacy]}`, o.kids ? "для дітей" : "не для дітей", ...(o.ai ? ["позначка «AI-вміст»"] : [])].join(" · ");
}
export function ttLine(o: TtOpts): string {
  if (o.mode === "draft") return "у чернетки TikTok - опублікуєш у застосунку TikTok (підпис туди вставиш сам)";
  if (!o.privacy) return "одразу, але не обрано «Хто бачить» - TikTok вимагає обрати";
  const allow = [o.comment && "коментарі", o.duet && "Duet", o.stitch && "Stitch"].filter(Boolean) as string[];
  return [`одразу · бачать: ${PRIVACY_UA[o.privacy] || o.privacy}`, allow.length ? `дозволено: ${allow.join(", ")}` : "коментарі, Duet і Stitch вимкнені",
    ...(o.branded ? ["позначка «Paid partnership»"] : o.yourBrand ? ["позначка «Promotional content»"] : []), ...(o.ai ? ["позначка «AI-вміст»"] : [])].join(" · ");
}

// Вхід від конектора/бота (людські назви теж) → поле channels.tiktok. prev - що вже було на пості.
const PRIV_ALIASES: Record<string, string> = {
  public: "PUBLIC_TO_EVERYONE", everyone: "PUBLIC_TO_EVERYONE", all: "PUBLIC_TO_EVERYONE", "усі": "PUBLIC_TO_EVERYONE", "всі": "PUBLIC_TO_EVERYONE",
  friends: "MUTUAL_FOLLOW_FRIENDS", "друзі": "MUTUAL_FOLLOW_FRIENDS",
  followers: "FOLLOWER_OF_CREATOR", "підписники": "FOLLOWER_OF_CREATOR",
  private: "SELF_ONLY", me: "SELF_ONLY", self: "SELF_ONLY", "я": "SELF_ONLY", "лише я": "SELF_ONLY",
};
export function ttPrivacyOf(v: unknown): string {
  const s = String(v ?? "").trim();
  if ((PRIVACY as readonly string[]).includes(s.toUpperCase())) return s.toUpperCase();
  return PRIV_ALIASES[s.toLowerCase()] || "";
}
export function mergeTt(prev: any, input: any): { value: any; error?: string } {
  const out: any = { ...(prev && typeof prev === "object" ? prev : {}) };
  if (!input || typeof input !== "object") return { value: out };
  if (input.privacy !== undefined) {
    if (input.privacy === null || input.privacy === "") delete out.privacy;
    else {
      const p = ttPrivacyOf(input.privacy);
      if (!p) return { value: out, error: `невідоме «Хто бачить» для TikTok: ${String(input.privacy)} (можна: public, friends, followers, private)` };
      out.privacy = p;
      if (input.mode === undefined) out.mode = "direct";
    }
  }
  if (input.mode !== undefined) {
    if (!["direct", "draft"].includes(String(input.mode))) return { value: out, error: "TikTok mode: direct (одразу) або draft (у чернетки)" };
    out.mode = String(input.mode);
  }
  for (const [k, key] of [["allow_comments", "comment"], ["allow_duet", "duet"], ["allow_stitch", "stitch"], ["your_brand", "your_brand"], ["branded_content", "branded"], ["ai_generated", "ai"]] as const)
    if (input[k] !== undefined) out[key] = input[k] === true;
  if (out.branded && out.privacy === "SELF_ONLY") return { value: out, error: "TikTok: брендований контент не може бути видно «Лише мені» - обери інше «Хто бачить»" };
  return { value: out };
}
export function mergeYt(prev: any, input: any): { value: any; error?: string } {
  const out: any = { ...(prev && typeof prev === "object" ? prev : {}) };
  if (!input || typeof input !== "object") return { value: out };
  if (input.title !== undefined) { const t = cleanTitle(String(input.title || "")); if (t) out.title = t; else delete out.title; }
  if (input.privacy !== undefined) {
    const raw = String(input.privacy || "").toLowerCase();
    const p = raw === "unlisted" || raw === "за посиланням" ? "unlisted" : raw === "private" || raw === "лише я" ? "private" : raw === "public" || raw === "усі" || raw === "всі" ? "public" : "";
    if (!p) return { value: out, error: `невідома видимість YouTube: ${String(input.privacy)} (можна: public, unlisted, private)` };
    out.privacy = p;
  }
  if (input.made_for_kids !== undefined) out.kids = input.made_for_kids === true;
  if (input.ai_generated !== undefined) out.ai = input.ai_generated === true;
  return { value: out };
}
