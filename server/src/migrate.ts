import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db.js";

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

  const defaults: Record<string, string> = {
    marketing_context:
      "Аудиторія: люди, які цікавляться особистісним ростом і психологією. Давати конкретну користь, без води й кліше.",
    tone_of_voice:
      "Голос спокійний, дружній, на «ти». Короткі речення. Без канцеляриту.",
    deai_rules:
      "Прибрати ознаки AI: довге тире замінити, прибрати штампи й надмірну симетрію. Зберегти зміст.",
    content_strategy:
      "3-4 пости на тиждень, рівномірно. Чергувати типи. З сильного матеріалу — серія 2-3 пости.",
  };
  for (const [key, content] of Object.entries(defaults)) {
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
