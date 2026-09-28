import pg from "pg";
import { env } from "./env.js";

export const pool = new pg.Pool({ connectionString: env.databaseUrl });

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Кілька запитів однією транзакцією (усе або нічого). Колбек отримує свої q/one - на тому самому
 *  зʼєднанні; звичайні q/one всередині пішли б повз транзакцію. */
export async function tx<T>(work: (c: { q: typeof q; one: typeof one }) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const cq = async <R = any>(text: string, params: any[] = []): Promise<R[]> => (await client.query(text, params)).rows as R[];
  const cone = async <R = any>(text: string, params: any[] = []): Promise<R | null> => (await cq<R>(text, params))[0] ?? null;
  try {
    await client.query("begin");
    const r = await work({ q: cq, one: cone });
    await client.query("commit");
    return r;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* зʼєднання вже мертве - віддаємо першу помилку */ }
    throw e;
  } finally { client.release(); }
}
