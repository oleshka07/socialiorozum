// Grain public API — список записів + транскрипт. (Перевірити з реальним токеном.)
const BASE = "https://api.grain.com/_/public-api";

async function gf<T = any>(key: string, path: string): Promise<T> {
  if (!key) throw new Error("Grain access token не заданий");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res: Response;
  try { res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal }); }
  catch (e: any) { if (e && e.name === "AbortError") throw new Error("Grain timeout 25s"); throw e; }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`Grain HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json() as Promise<T>;
}

export async function listTranscripts(key: string) {
  const j = await gf<any>(key, "/recordings");
  const recs: any[] = j.recordings || j.data || (Array.isArray(j) ? j : []);
  return recs.slice(0, 20).map((r) => ({ id: r.id, title: r.title || "Grain-запис", date: r.start_datetime ? Date.parse(r.start_datetime) : 0 }));
}

export async function getTranscript(key: string, id: string) {
  const j = await gf<any>(key, `/recordings/${id}?transcript_format=json`);
  let text = "";
  if (Array.isArray(j.transcript_json)) text = j.transcript_json.map((s: any) => `${s.speaker || "?"}: ${s.text || ""}`).join("\n");
  else if (Array.isArray(j.transcript)) text = j.transcript.map((s: any) => `${s.speaker || "?"}: ${s.text || s.transcript || ""}`).join("\n");
  else if (typeof j.transcript === "string") text = j.transcript;
  if (!text.trim()) throw new Error("Порожній транскрипт Grain");
  return { title: j.title || "Grain-запис", text };
}
