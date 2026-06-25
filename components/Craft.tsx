"use client";

import { useEffect } from "react";
import { gsap, SplitText } from "@/lib/gsap";

/**
 * The craft layer that makes the page feel hand-made: a custom difference-blend
 * cursor, the canonical SplitText line-mask hero reveal, and magnetic CTAs.
 * All gated off for reduced-motion / coarse pointers. Renders nothing.
 */
export default function Craft() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const cleanups: Array<() => void> = [];

    // --- Hero headline: line-mask slide-up (not an opacity fade) ---
    if (!reduce) {
      const h1 = document.querySelector("h1");
      if (h1) {
        const split = SplitText.create(h1, {
          type: "lines",
          mask: "lines",
          autoSplit: true,
        });
        const tween = gsap.from(split.lines, {
          yPercent: 115,
          opacity: 0,
          duration: 1.1,
          ease: "expo.out",
          stagger: 0.09,
          delay: 0.08,
        });
        cleanups.push(() => {
          tween.kill();
          split.revert();
        });
      }
    }

    // --- Custom cursor ---
    if (!coarse && !reduce) {
      const dot = document.createElement("div");
      dot.className = "cursor-dot";
      const ring = document.createElement("div");
      ring.className = "cursor-ring";
      document.body.append(dot, ring);
      document.body.classList.add("has-cursor");

      const dx = gsap.quickTo(dot, "x", { duration: 0.12, ease: "power3" });
      const dy = gsap.quickTo(dot, "y", { duration: 0.12, ease: "power3" });
      const rx = gsap.quickTo(ring, "x", { duration: 0.5, ease: "power3" });
      const ry = gsap.quickTo(ring, "y", { duration: 0.5, ease: "power3" });
      const move = (e: PointerEvent) => {
        dx(e.clientX);
        dy(e.clientY);
        rx(e.clientX);
        ry(e.clientY);
      };
      const over = (e: PointerEvent) => {
        if ((e.target as HTMLElement)?.closest("a,button,summary,.tab"))
          gsap.to(ring, { scale: 1.9, duration: 0.3, ease: "expo.out" });
      };
      const out = (e: PointerEvent) => {
        if ((e.target as HTMLElement)?.closest("a,button,summary,.tab"))
          gsap.to(ring, { scale: 1, duration: 0.3, ease: "expo.out" });
      };
      window.addEventListener("pointermove", move, { passive: true });
      document.addEventListener("pointerover", over);
      document.addEventListener("pointerout", out);
      cleanups.push(() => {
        window.removeEventListener("pointermove", move);
        document.removeEventListener("pointerover", over);
        document.removeEventListener("pointerout", out);
        document.body.classList.remove("has-cursor");
        dot.remove();
        ring.remove();
      });
    }

    // --- Magnetic CTAs ---
    if (!coarse && !reduce) {
      document.querySelectorAll<HTMLElement>(".magnetic").forEach((el) => {
        const move = (e: PointerEvent) => {
          const r = el.getBoundingClientRect();
          gsap.to(el, {
            x: (e.clientX - (r.left + r.width / 2)) * 0.3,
            y: (e.clientY - (r.top + r.height / 2)) * 0.3,
            duration: 0.3,
            ease: "power3.out",
          });
        };
        const leave = () =>
          gsap.to(el, { x: 0, y: 0, duration: 0.7, ease: "elastic.out(1,0.3)" });
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerleave", leave);
        cleanups.push(() => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerleave", leave);
        });
      });
    }

    return () => cleanups.forEach((c) => c());
  }, []);

  return null;
}
