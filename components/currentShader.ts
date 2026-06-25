// The Distillation Current — GLSL for a full-bleed fluid field.
// Left: raw, turbulent, desaturated web. A luminous membrane distills it.
// Right: calm, laminar, luminous cyan — the shared current every agent drafts.

export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0); // fullscreen quad, ignore camera
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;   // 0..1 scroll
  uniform float uPulse;      // 0..1 transient on token saved
  uniform float uVel;        // pointer velocity
  uniform vec2  uMouse;      // 0..1, y up
  uniform vec2  uAspect;     // (aspect, 1) to de-stretch noise

  // --- Ashima simplex 3D noise ---
  vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  float fbm(vec3 p){
    float s = 0.0, a = 0.5;
    for(int i = 0; i < 5; i++){ s += a * snoise(p); p *= 2.0; a *= 0.5; }
    return s;
  }

  void main(){
    vec2 uv = vUv;
    float aspect = uAspect.x;
    // flow space, de-stretched + advected rightward so the current visibly moves
    vec2 sp = vec2(uv.x * aspect, uv.y) * 2.4;
    float t = uTime * 0.05 + uSeed * 10.0;
    sp.x -= uTime * 0.05;

    // The distillation membrane breathes along Y and, as you scroll, travels
    // fully off-screen left — so the whole page comes to live *inside* the
    // distilled current rather than behind a faded-out tombstone of it.
    float line = 0.34 + 0.04 * sin(uTime * 0.12)
               + 0.018 * sin(uTime * 0.3 + uv.y * 2.1)
               - uProgress * 0.55;
    float side = smoothstep(line - 0.05, line + 0.07, uv.x); // tight knife-edge

    // Domain warp — violent/inky on the raw side, near-laminar once distilled.
    float chaos = mix(1.0, 0.10, side);
    vec2 q = vec2(fbm(vec3(sp, t)), fbm(vec3(sp + 7.3, t)));
    vec2 r = vec2(
      fbm(vec3(sp + q * chaos * 1.4 + 1.7, t)),
      fbm(vec3(sp + q * chaos * 1.4 + 9.2, t * 1.1))
    );
    float n = fbm(vec3(sp + r * chaos * 1.8, t));
    float nn = clamp(0.5 + 0.5 * n, 0.0, 1.0);

    // Distilled side resolves into clean laminar horizontal bands.
    float bands = 0.5 + 0.5 * sin(uv.y * 22.0 + n * 1.1 - uTime * 0.5);
    bands = pow(bands, 1.5);

    // Pointer injects heat -> local turbulence (bites mainly on the raw side).
    float md = distance(vec2(uv.x * aspect, uv.y),
                        vec2(uMouse.x * aspect, uMouse.y));
    float heat = smoothstep(0.30, 0.0, md) * (0.3 + uVel * 0.9);
    nn = clamp(nn + heat * (1.0 - side) * 0.5, 0.0, 1.0);

    // Palette
    vec3 deep   = vec3(0.018, 0.022, 0.042);
    vec3 ink    = vec3(0.10, 0.12, 0.17);
    vec3 cyan   = vec3(0.369, 0.918, 0.831);  // #5eead4
    vec3 indigo = vec3(0.506, 0.549, 0.972);  // #818cf8

    vec3 raw  = mix(deep, ink, smoothstep(0.25, 0.95, nn));
    vec3 dist = mix(indigo * 0.45, cyan, smoothstep(0.2, 1.0, bands)) * (0.45 + 0.7 * bands);
    vec3 col  = mix(raw, dist, side);

    // Membrane glow — a luminous knife-edge, the moment of distillation.
    float lineGlow = smoothstep(0.018, 0.0, abs(uv.x - line));
    col += cyan * lineGlow * 1.25 * (0.7 + 0.3 * sin(uTime * 1.4 + uv.y * 5.0));

    // Live save pulse: a bright wavefront sweeping the distilled side.
    float wave = smoothstep(0.05, 0.0,
      abs(uv.x - (line + fract(uTime * 0.45) * (1.0 - line))));
    col += cyan * wave * uPulse * side;

    // Heat sparkle near cursor
    col += cyan * heat * 0.2;

    // Vignette + a gentle calming (NOT a kill): the current persists across the
    // whole scroll as the distilled world, just quieter so panels stay legible.
    float vig = smoothstep(1.3, 0.3, distance(uv, vec2(0.5)));
    col *= 0.6 + 0.4 * vig;
    col *= mix(1.0, 0.55, smoothstep(0.0, 0.45, uProgress));

    gl_FragColor = vec4(col, 1.0);
  }
`;
