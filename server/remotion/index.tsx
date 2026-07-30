// Точка входу Remotion-бандла (компілюється вебпаком @remotion/bundler, НЕ нашим tsc).
import React from "react";
import { Composition, registerRoot } from "remotion";
import { Reel, ReelProps } from "./Reel";

const FPS = 30;

const Root: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel as React.FC<any>}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={FPS * 10}
    defaultProps={{ segments: [{ text: "Тест", dur: 3, label: "ХУК" }], accent: "#F6C444" } as ReelProps as any}
    calculateMetadata={({ props }) => {
      const p = props as any as ReelProps;
      const total = (p.segments || []).reduce((s, x) => s + Math.max(0.5, Number(x.dur) || 0), 0);
      return { durationInFrames: Math.max(FPS, Math.round(total * FPS)) };
    }}
  />
);

registerRoot(Root);
