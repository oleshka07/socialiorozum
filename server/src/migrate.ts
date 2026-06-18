import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
  // гарантуємо дефолтний workspace + блоки налаштувань
  const ws = await pool.query(
    `insert into workspace(name) values('default')
     on conflict (name) do nothing returning id`
  );
  const wsId =
    ws.rows[0]?.id ??
    (await pool.query(`select id from workspace order by created_at limit 1`)).rows[0].id;

  for (const [key, content] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `insert into settings_block(workspace_id, key, content)
       values($1,$2,$3) on conflict (workspace_id,key) do nothing`,
      [wsId, key, content]
    );
  }
  console.log("[migrate] схема застосована, workspace:", wsId);
  await pool.end();
}

main().catch((e) => {
  console.error("[migrate] помилка:", e);
  process.exit(1);
});
