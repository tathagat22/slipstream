"use client";

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { flow } from "@/lib/store";
import { vertexShader, fragmentShader } from "./currentShader";

/**
 * Full-bleed fluid current rendered as a single fullscreen-quad shader.
 * Uniforms are driven from the shared `flow` store (scroll, pointer, pulse) —
 * lerped here, never via React state, so it stays a pure GPU loop.
 */
export default function DistillationCurrent() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const { size } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSeed: { value: Math.random() },
      uProgress: { value: 0 },
      uPulse: { value: 0 },
      uVel: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uAspect: { value: new THREE.Vector2(1, 1) },
    }),
    [],
  );

  // smoothed values
  const sm = useRef({ progress: 0, mx: 0.5, my: 0.5, vel: 0, pulse: 0 });

  useFrame((_, dt) => {
    const u = matRef.current?.uniforms;
    if (!u) return;
    const k = Math.min(1, dt * 3);
    const s = sm.current;
    s.progress += (flow.progress - s.progress) * k;
    s.mx += (flow.mx - s.mx) * k;
    s.my += (flow.my - s.my) * k;
    s.vel += (flow.vel - s.vel) * Math.min(1, dt * 5);
    s.pulse += (flow.pulse - s.pulse) * Math.min(1, dt * 4);

    flow.vel *= 0.9; // decay raw velocity
    flow.pulse *= 0.94; // decay pulse

    u.uTime.value += dt;
    u.uProgress.value = s.progress;
    u.uVel.value = s.vel;
    u.uPulse.value = s.pulse;
    (u.uMouse.value as THREE.Vector2).set(s.mx, s.my);
    (u.uAspect.value as THREE.Vector2).set(size.width / size.height, 1);
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}
