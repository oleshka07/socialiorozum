// Композиція рілса «Motion» (Remotion): фонові кліпи з нашого конвеєра (вже обрізані під сегменти)
// + анімований хук-заголовок + караоке-титри (слово, що звучить, підсвічене) + прогрес-бар + CTA-плашка.
// Пословні тайминги наближені: слова сегмента розкладаються рівномірно по тривалості озвучки.
import React from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export type Seg = { text: string; dur: number; audio?: string; video?: string; image?: string; label?: string };
export type ReelProps = { segments: Seg[]; accent?: string; handle?: string };

const FONT = "'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif";
const INK = "#0b0e13";

const wordWindows = (text: string, frames: number) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const per = frames / Math.max(1, words.length);
  return words.map((w, i) => ({ w, from: i * per, to: (i + 1) * per }));
};

// караоке-титри: слово, що звучить, — на акцентній плашці; сказане — біле; майбутнє — пригашене
const Captions: React.FC<{ text: string; frames: number; accent: string }> = ({ text, frames, accent }) => {
  const frame = useCurrentFrame();
  const win = wordWindows(text, frames);
  return (
    <div style={{ position: "absolute", left: 64, right: 64, bottom: 280, textAlign: "center" }}>
      <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 58, lineHeight: 1.5, color: "#fff", textShadow: "0 2px 18px rgba(0,0,0,.85)" }}>
        {win.map((x, i) => {
          const active = frame >= x.from && frame < x.to;
          const seen = frame >= x.to;
          return (
            // пробіл-текстовий вузол ПІСЛЯ спана обовʼязковий: без нього рядок не має точок переносу
            <React.Fragment key={i}>
              <span
                style={{
                  backgroundColor: active ? accent : "transparent",
                  color: active ? INK : seen ? "#fff" : "rgba(255,255,255,.55)",
                  borderRadius: 12,
                  padding: "1px 10px",
                  boxDecorationBreak: "clone" as any,
                  WebkitBoxDecorationBreak: "clone" as any,
                }}
              >
                {x.w}
              </span>{" "}
            </React.Fragment>
          );
        })}
      </span>
    </div>
  );
};

// хук: великий заголовок по центру, слова вистрибують пружинкою одне за одним + акцентна риска
const Hook: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const barW = interpolate(spring({ frame: frame - words.length * 3 - 4, fps, config: { damping: 200 } }), [0, 1], [0, 220]);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 70px" }}>
      <div style={{ textAlign: "center" }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - i * 3, fps, config: { damping: 14, mass: 0.6 } });
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                fontFamily: FONT,
                fontWeight: 800,
                fontSize: 84,
                lineHeight: 1.22,
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "#fff",
                textShadow: "0 4px 26px rgba(0,0,0,.9)",
                marginRight: 20,
                opacity: Math.min(1, s * 1.4),
                transform: `translateY(${(1 - s) * 60}px) scale(${0.7 + s * 0.3})`,
              }}
            >
              {w}
            </span>
          );
        })}
        <div style={{ width: barW, height: 12, background: accent, borderRadius: 7, margin: "26px auto 0" }} />
      </div>
    </AbsoluteFill>
  );
};

const Background: React.FC<{ seg: Seg; frames: number }> = ({ seg, frames }) => {
  const frame = useCurrentFrame();
  const cover: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  return (
    <AbsoluteFill style={{ background: "linear-gradient(160deg,#14141c,#1e2530)" }}>
      {seg.video ? (
        <OffthreadVideo src={seg.video} muted style={cover} />
      ) : seg.image ? (
        <Img src={seg.image} style={{ ...cover, transform: `scale(${1 + (frame / Math.max(1, frames)) * 0.09})` }} />
      ) : null}
      {/* затемнення, щоб титри читались на будь-якому кадрі */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg,rgba(6,8,12,.32) 0%,rgba(6,8,12,.14) 40%,rgba(6,8,12,.74) 100%)" }} />
    </AbsoluteFill>
  );
};

export const Reel: React.FC<ReelProps> = ({ segments, accent = "#F6C444", handle }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  let cursor = 0;
  const seqs = (segments || []).map((seg) => {
    const from = cursor;
    const frames = Math.max(1, Math.round(seg.dur * fps));
    cursor += frames;
    return { seg, from, frames };
  });
  const progress = interpolate(frame, [0, durationInFrames], [0, 1]);
  return (
    <AbsoluteFill style={{ background: "#0b0e13" }}>
      {seqs.map(({ seg, from, frames }, i) => {
        const isHook = i === 0 && /хук/i.test(seg.label || "");
        const isCta = /cta/i.test(seg.label || "");
        return (
          <Sequence key={i} from={from} durationInFrames={frames}>
            <Background seg={seg} frames={frames} />
            {seg.audio ? <Audio src={seg.audio} /> : null}
            {isHook ? <Hook text={seg.text} accent={accent} /> : <Captions text={seg.text} frames={frames} accent={accent} />}
            {isCta && handle ? (
              <div style={{ position: "absolute", bottom: 120, left: 0, right: 0, textAlign: "center" }}>
                <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 42, color: INK, background: accent, borderRadius: 999, padding: "12px 34px" }}>{handle}</span>
              </div>
            ) : null}
          </Sequence>
        );
      })}
      {/* тонкий прогрес-бар угорі - глядач бачить, що ролик короткий */}
      <div style={{ position: "absolute", top: 0, left: 0, height: 10, width: `${progress * 100}%`, background: accent, borderRadius: "0 6px 6px 0" }} />
    </AbsoluteFill>
  );
};
