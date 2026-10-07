// 👤 Хто зараз діє: людина й її роль у бренді - для коду, далекого від запиту (вставка поста,
// монтаж у фоні, конектор Claude). Інакше кожну функцію довелось би протягувати з userId і роллю.
//
// Кабінет ставить контекст у preHandler (callback-стилем: обробник маршруту й усе, що він запустить,
// виконується всередині run), бот - на кожен апдейт, конектор - на кожен виклик інструмента.
// Фонові воркери (автопостер, вічнозелене) діють без людини: actorId() = null.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Role } from "./roles.js";

export type Actor = { userId: string | null; role: Role | null };
const store = new AsyncLocalStorage<Actor>();

export function runAs<T>(a: Actor, fn: () => T): T { return store.run({ ...a }, fn); }
export const actor = (): Actor | null => store.getStore() || null;
export const actorId = (): string | null => store.getStore()?.userId || null;
export const actorRole = (): Role | null => store.getStore()?.role || null;
/** Уточнити контекст на льоту (бот дізнається роль, коли вже знає бренд кнопки). */
export function setActor(patch: Partial<Actor>): void {
  const s = store.getStore();
  if (s) Object.assign(s, patch);
}
/** Пост, створений автором, не стає затвердженим сам (монтаж, конектор з approve) - його затверджує редактор. */
export const mayAutoApprove = (): boolean => actorRole() !== "author" && actorRole() !== "viewer";
