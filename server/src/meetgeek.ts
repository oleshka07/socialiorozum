// MeetGeek API — список зустрічей + транскрипт. (Перевірити з реальним ключем.)
const BASE = "https://api.meetgeek.ai/v1";

async function mg<T = any>(key: string, path: string): Promise<T> {
  if (!key) throw new Error("MeetGeek API key не заданий");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res: Response;
  try { res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal }); }
  catch (e: any) { if (e && e.name === "AbortError") throw new Error("MeetGeek timeout 25s"); throw e; }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`MeetGeek HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json() as Promise<T>;
}

export async function listTranscripts(key: string) {
  const j = await mg<any>(key, "/meetings");
  const items: any[] = j.items || j.meetings || j.data || (Array.isArray(j) ? j : []);
  return items.slice(0, 20).map((m) => ({ id: m.id || m.meeting_id, title: m.title || m.name || "MeetGeek-зустріч", date: m.timestamp_start ? Date.parse(m.timestamp_start) : 0 }));
}

export async function getTranscript(key: string, id: string) {
  const j = await mg<any>(key, `/meetings/${id}/transcript`);
  const segs: any = j.transcript || j.sentences || j.items || j.data || j;
  let text = "";
  if (Array.isArray(segs)) text = segs.map((s: any) => `${s.speaker || "?"}: ${s.sentence || s.transcript || s.text || ""}`).join("\n");
  else if (typeof segs === "string") text = segs;
  if (!text.trim()) throw new Error("Порожній транскрипт MeetGeek");
  return { title: j.title || "MeetGeek-зустріч", text };
}
