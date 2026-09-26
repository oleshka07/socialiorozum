// ⬆ Заливка частинами: великий файл (відео з телефона на 100-500 МБ) одним запитом крізь nginx не
// пролазить (client_max_body_size 20m на беті, і прод не краще), тож клієнт ріже файл на шматки до
// 16 МБ, а сервер дописує їх у тимчасовий файл і, коли все зібрано, кладе в медіатеку.
//
// Стан живе НА ДИСКУ (частина + json поруч), а не в памʼяті процесу: деплой посеред заливки не губить
// уже залите - клієнт продовжує з того байта, який назве сервер. Повтор шматка (відповідь загубилась
// у мережі, а клієнт надіслав ще раз) нічого не псує: вже записані байти просто пропускаються.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, readFile, writeFile, stat, unlink, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_DIR } from "./media.js";

export const CHUNK_DIR = join(MEDIA_DIR, "tmp");
mkdirSync(CHUNK_DIR, { recursive: true });

export const CHUNK_MAX = 16 * 1024 * 1024;                       // один шматок: nginx пропускає 20 МБ тіла
export const UPLOAD_MAX_MB = Math.max(20, Number(process.env.UPLOAD_MAX_MB) || 500);
const MIN_FREE = 3 * 1024 ** 3;                                  // стільки диска лишаємо вільним завжди
const MAX_OPEN = 6;                                              // незавершених заливок на кабінет/посилання

export const isUid = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(s);

export class ChunkError extends Error {
  constructor(message: string, public status = 400, public received?: number) { super(message); }
}

type Meta = { name: string; size: number; created: number };
export type ChunkState<T> = { done: false; received: number; size: number } | { done: true; received: number; size: number; result: T };

const h16 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
// ключ = «чиє» + «який файл»: префікс дає порахувати незавершені заливки одного кабінету чи посилання
const keyOf = (scope: string, uid: string) => `${h16(scope)}-${h16(uid)}`;

// шматки одного файлу - строго по черзі (паралельний повтор інакше дописав би ті самі байти двічі)
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

// завершені заливки памʼятаємо 10 хв: повтор ОСТАННЬОГО шматка після обриву має отримати той самий
// результат, а не «почни спочатку» (файл уже в медіатеці, а тимчасових частин більше нема)
const finished = new Map<string, { at: number; result: unknown }>();
function rememberFinished(key: string, result: unknown) {
  const now = Date.now();
  for (const [k, v] of finished) if (now - v.at > 10 * 60_000) finished.delete(k);
  finished.set(key, { at: now, result });
}

async function freeBytes(): Promise<number> {
  try { const s = await statfs(CHUNK_DIR); return Number(s.bavail) * Number(s.bsize); }
  catch { return Number.MAX_SAFE_INTEGER; } // не змогли виміряти - не блокуємо
}

/**
 * Дописати шматок. offset - з якого байта цей шматок; сервер приймає рівно наступні байти, повтор
 * уже записаних пропускає, а «дірку» відхиляє з 409 і каже, скільки в нього є (received).
 * finalize викликається один раз, коли файл зібрано; його помилка = відмова для людини.
 */
export async function putChunk<T>(
  scope: string, uid: string, name: string, size: number, offset: number, body: Buffer,
  finalize: (path: string, meta: Meta) => Promise<T>
): Promise<ChunkState<T>> {
  if (!isUid(uid)) throw new ChunkError("uid: 6-64 символи з латиниці, цифр, _ і -");
  if (!Number.isSafeInteger(size) || size < 1) throw new ChunkError("size: розмір файлу в байтах");
  if (size > UPLOAD_MAX_MB * 1024 * 1024) throw new ChunkError(`файл більший за ${UPLOAD_MAX_MB} МБ - стисни або вріж його`, 413);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ChunkError("offset: з якого байта цей шматок");
  if (body.length > CHUNK_MAX) throw new ChunkError(`шматок до ${CHUNK_MAX / 1024 / 1024} МБ`, 413);
  const key = keyOf(scope, uid);
  return withLock(key, async () => {
    const fin = finished.get(key);
    if (fin) return { done: true as const, received: size, size, result: fin.result as T };
    const part = join(CHUNK_DIR, key + ".part"), metaFile = join(CHUNK_DIR, key + ".json");
    let meta: Meta | null = null;
    try { meta = JSON.parse(await readFile(metaFile, "utf8")); } catch { /* нова заливка */ }
    if (!meta) {
      if (offset !== 0) throw new ChunkError("цієї заливки на сервері нема - почни файл спочатку", 409, 0);
      const prefix = key.split("-")[0] + "-";
      const open = (await readdir(CHUNK_DIR).catch(() => [] as string[])).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).length;
      if (open >= MAX_OPEN) throw new ChunkError(`одночасно - до ${MAX_OPEN} файлів; дочекайся, поки заллються попередні`, 429);
      if ((await freeBytes()) - size < MIN_FREE) throw new ChunkError("на сервері закінчується місце - спробуй пізніше або менший файл", 507);
      meta = { name: String(name || "").slice(0, 200), size, created: Date.now() };
      await writeFile(part, Buffer.alloc(0));
      await writeFile(metaFile, JSON.stringify(meta));
    } else if (meta.size !== size) {
      throw new ChunkError(`розмір файлу змінився (було ${meta.size}, тепер ${size}) - почни з новим uid`, 409);
    }
    let received = 0;
    try { received = (await stat(part)).size; } catch { /* частину прибрав сторож - рахуємо з нуля */ }
    if (offset > received) throw new ChunkError(`бракує даних: сервер має ${received} байт - продовжуй з цього місця`, 409, received);
    const skip = received - offset;                  // повтор уже записаних байтів - пропускаємо їх
    if (skip < body.length) {
      const tail = body.subarray(skip);
      if (received + tail.length > size) throw new ChunkError("надіслано більше, ніж заявлено в size", 400, received);
      const fh = await open(part, "a");
      try { await fh.write(tail); } finally { await fh.close(); }
      received += tail.length;
    }
    if (received < size) return { done: false as const, received, size };
    try {
      const result = await finalize(part, meta);
      rememberFinished(key, result);
      return { done: true as const, received, size, result };
    } finally {
      await unlink(part).catch(() => {});             // відео finalize уже переніс - тоді тут нічого
      await unlink(metaFile).catch(() => {});
    }
  });
}

/** Недолиті частини старші за добу - геть (lifecycle). */
export async function sweepChunks(maxAgeMs = 24 * 3600_000): Promise<number> {
  let n = 0;
  for (const f of await readdir(CHUNK_DIR).catch(() => [] as string[])) {
    const p = join(CHUNK_DIR, f);
    try { if (Date.now() - (await stat(p)).mtimeMs > maxAgeMs) { await unlink(p); n++; } } catch { /* уже нема */ }
  }
  return n;
}

/**
 * Імʼя файлу з заголовка X-File-Name: браузер шле його через encodeURIComponent, а curl - сирими
 * байтами UTF-8, які Node читає як latin1. Приймаємо обидва.
 */
export function headerFileName(v: unknown): string {
  const raw = String(Array.isArray(v) ? v[0] : v || "").slice(0, 600);
  if (!raw) return "";
  let s = raw;
  if (/%[0-9a-f]{2}/i.test(raw)) { try { s = decodeURIComponent(raw); } catch { /* не percent - лишаємо */ } }
  else if (/[\u0080-ÿ]/.test(raw)) s = Buffer.from(raw, "latin1").toString("utf8");
  return s.replace(/[\u0000-\u001f\\/]/g, "").slice(0, 200);
}
