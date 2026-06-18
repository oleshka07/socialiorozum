// Fireflies.ai GraphQL — підтягування транскриптів зустрічей.
const URL = "https://api.fireflies.ai/graphql";

async function gql<T = any>(key: string, query: string, variables?: any): Promise<T> {
  if (!key) throw new Error("Fireflies API key не заданий");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ query, variables }),
    });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("Fireflies timeout 25s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const j: any = await res.json().catch(() => ({}));
  if (j.errors && j.errors.length) throw new Error(j.errors[0]?.message || "Fireflies помилка");
  if (!res.ok) throw new Error(`Fireflies HTTP ${res.status}`);
  return j.data as T;
}

export async function listTranscripts(key: string) {
  const d = await gql<{ transcripts: { id: string; title: string; date: number }[] }>(
    key, `query { transcripts(limit: 20, mine: true) { id title date } }`
  );
  return d.transcripts || [];
}

export async function getTranscript(key: string, id: string) {
  const d = await gql<{ transcript: { title: string; sentences: { speaker_name: string; text: string }[] } }>(
    key, `query($id:String!){ transcript(id:$id){ title sentences { speaker_name text } } }`, { id }
  );
  const t = d.transcript;
  if (!t) throw new Error("Транскрипт не знайдено");
  const text = (t.sentences || []).map((s) => `${s.speaker_name || "?"}: ${s.text}`).join("\n");
  return { title: t.title || "Fireflies-транскрипт", text };
}
