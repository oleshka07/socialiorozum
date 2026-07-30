// Remotion-рендер рілса («Motion»): React-композиція server/remotion → headless Chromium → mp4.
// Бандл вебпаком будується ОДИН раз на процес і кешується; медіа Chromium тягне з нашого ж
// /media через 127.0.0.1 (на беті /media відкритий без PIN). Ліцензія: безкоштовно до 3 людей
// у компанії; при рості - тариф Automators ($0.01/рендер, мін. $100/міс).
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ReelSeg = { text: string; dur: number; audio?: string; video?: string; image?: string; label?: string };
export type ReelProps = { segments: ReelSeg[]; accent?: string; handle?: string };

// шлях до браузера: env REMOTION_CHROME → системний chromium (alpine) → headless shell Playwright (dev)
function chromePath(): string | undefined {
  const candidates = [
    process.env.REMOTION_CHROME,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined; // Remotion сам завантажить headless shell (потрібен інтернет)
}

let bundleP: Promise<string> | null = null;
function getBundle(): Promise<string> {
  if (!bundleP) {
    bundleP = (async () => {
      const { bundle } = await import("@remotion/bundler");
      const entry = join(__dirname, "..", "remotion", "index.tsx");
      return bundle({ entryPoint: entry, onProgress: () => {} });
    })().catch((e) => { bundleP = null; throw e; }); // невдалий бандл не «застрягає» в кеші
  }
  return bundleP;
}

export async function renderReelRemotion(props: ReelProps, outputLocation: string): Promise<void> {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const serveUrl = await getBundle();
  const browserExecutable = chromePath();
  const composition = await selectComposition({ serveUrl, id: "Reel", inputProps: props as any, browserExecutable });
  await renderMedia({
    composition,
    serveUrl,
    inputProps: props as any,
    codec: "h264",
    outputLocation,
    browserExecutable,
    concurrency: 1,               // сервер маленький: один потік рендера, щоб не зʼїсти памʼять
    timeoutInMilliseconds: 8 * 60 * 1000,
    chromiumOptions: { gl: "swangle" },
  });
}
