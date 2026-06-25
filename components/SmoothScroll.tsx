"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap, ScrollTrigger } from "@/lib/gsap";
import { flow } from "@/lib/store";

/**
 * One RAF loop for the whole site: Lenis smooth-scroll bridged into GSAP's
 * ticker (no second loop → no jitter, correct ScrollTrigger positions). Also
 * funnels global pointer position + velocity into the shared `flow` store that
 * the WebGL current reads. Renders nothing.
 */
export default function SmoothScroll() {
  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const lenis = new Lenis({
      lerp: reduce ? 1 : 0.1,
      syncTouch: true,
      autoRaf: false,
    });

    lenis.on("scroll", (e: { progress?: number }) => {
      if (typeof e.progress === "number") flow.progress = e.progress;
      ScrollTrigger.update();
    });

    const onTick = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(onTick);
    gsap.ticker.lagSmoothing(0);

    let px = 0.5;
    let py = 0.5;
    const onMove = (ev: PointerEvent) => {
      const nx = ev.clientX / window.innerWidth;
      const ny = 1 - ev.clientY / window.innerHeight;
      flow.vel = Math.min(1, flow.vel + Math.hypot(nx - px, ny - py) * 6);
      px = nx;
      py = ny;
      flow.mx = nx;
      flow.my = ny;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    return () => {
      gsap.ticker.remove(onTick);
      lenis.destroy();
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return null;
}
