// Mutable singleton bridging Lenis scroll + global pointer into the WebGL frame
// loop WITHOUT React re-renders. The canvas reads these in useFrame and lerps.

export type Flow = {
  /** 0..1 scroll progress through the whole page */
  progress: number;
  /** normalized pointer, 0..1, y up */
  mx: number;
  my: number;
  /** smoothed pointer velocity 0..~1, drives turbulence */
  vel: number;
  /** 0..1 transient pulse fired when tokensSaved ticks up */
  pulse: number;
};

export const flow: Flow = {
  progress: 0,
  mx: 0.5,
  my: 0.5,
  vel: 0,
  pulse: 0,
};
