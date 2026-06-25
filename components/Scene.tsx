"use client";

import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useEffect, useState } from "react";
import DistillationCurrent from "./DistillationCurrent";

/** Capability gate — fall back to the static DOM hero when WebGL/perf is unfit. */
function useCanRender() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    setOk(!!gl && !reduce && window.innerWidth >= 768 && mem >= 2);
  }, []);
  return ok;
}

/**
 * The persistent global canvas for the signature moment. Fixed, behind the DOM,
 * never eats pointer events (the shared `flow` store carries pointer in). DOM
 * text stays real HTML above it for SEO/a11y.
 */
export default function Scene() {
  const can = useCanRender();
  if (!can) return null;
  return (
    <div className="scene-canvas" aria-hidden="true">
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance", alpha: true }}
        style={{ position: "fixed", inset: 0 }}
      >
        <DistillationCurrent />
        <EffectComposer>
          <Bloom
            luminanceThreshold={0.85}
            luminanceSmoothing={0.05}
            intensity={0.6}
            mipmapBlur
          />
        </EffectComposer>
      </Canvas>
      {/* Legibility scrim: darkens the text column, lets the current glow right,
          fades the canvas into the page below the hero. */}
      <div className="scene-scrim" />
    </div>
  );
}
