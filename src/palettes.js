// Mood anchors on the valence/arousal circumplex.
//
// Colours are linear-ish floats (0..1) for three gradient stops: deep, mid, high.
// `motion` feeds the renderer directly, so a palette change also changes how the
// field moves — a calm mood must look calm even with the colour channels tied.
//
// Deliberately dim: this runs full-screen on an OLED. Highlights are rolled off
// in the shader, but anchors that lean on 1.0 whites defeat that.

export const MOOD_ANCHORS = [
  {
    name: 'Euphoric',
    valence: 0.88, arousal: 0.86,
    colors: [[0.62, 0.08, 0.34], [0.86, 0.42, 0.06], [0.95, 0.82, 0.55]],
    motion: { flow: 0.30, turbulence: 1.35, contrast: 1.18, pulseGain: 1.00, glow: 1.00, grain: 0.016 },
  },
  {
    name: 'Radiant',
    valence: 0.80, arousal: 0.52,
    colors: [[0.10, 0.34, 0.38], [0.72, 0.44, 0.14], [0.92, 0.80, 0.52]],
    motion: { flow: 0.20, turbulence: 0.95, contrast: 1.06, pulseGain: 0.70, glow: 0.90, grain: 0.014 },
  },
  {
    name: 'Dreamy',
    valence: 0.66, arousal: 0.30,
    colors: [[0.14, 0.12, 0.34], [0.36, 0.30, 0.66], [0.66, 0.78, 0.86]],
    motion: { flow: 0.10, turbulence: 0.65, contrast: 0.92, pulseGain: 0.35, glow: 0.80, grain: 0.012 },
  },
  {
    name: 'Serene',
    valence: 0.62, arousal: 0.10,
    colors: [[0.05, 0.16, 0.17], [0.20, 0.44, 0.40], [0.62, 0.74, 0.62]],
    motion: { flow: 0.05, turbulence: 0.42, contrast: 0.86, pulseGain: 0.18, glow: 0.60, grain: 0.010 },
  },
  {
    name: 'Solemn',
    valence: 0.36, arousal: 0.08,
    colors: [[0.04, 0.05, 0.13], [0.20, 0.11, 0.24], [0.52, 0.38, 0.22]],
    motion: { flow: 0.045, turbulence: 0.36, contrast: 0.94, pulseGain: 0.22, glow: 0.55, grain: 0.012 },
  },
  {
    name: 'Melancholic',
    valence: 0.26, arousal: 0.26,
    colors: [[0.03, 0.06, 0.16], [0.12, 0.20, 0.40], [0.44, 0.58, 0.70]],
    motion: { flow: 0.07, turbulence: 0.55, contrast: 0.98, pulseGain: 0.28, glow: 0.50, grain: 0.012 },
  },
  {
    name: 'Mysterious',
    valence: 0.44, arousal: 0.46,
    colors: [[0.08, 0.04, 0.18], [0.26, 0.16, 0.44], [0.30, 0.62, 0.62]],
    motion: { flow: 0.13, turbulence: 0.85, contrast: 1.04, pulseGain: 0.55, glow: 0.70, grain: 0.014 },
  },
  {
    name: 'Tense',
    valence: 0.22, arousal: 0.66,
    colors: [[0.05, 0.10, 0.06], [0.34, 0.40, 0.08], [0.66, 0.24, 0.12]],
    motion: { flow: 0.24, turbulence: 1.20, contrast: 1.22, pulseGain: 0.85, glow: 0.55, grain: 0.018 },
  },
  {
    name: 'Fierce',
    valence: 0.12, arousal: 0.90,
    colors: [[0.12, 0.01, 0.04], [0.58, 0.06, 0.10], [0.34, 0.14, 0.52]],
    motion: { flow: 0.38, turbulence: 1.55, contrast: 1.30, pulseGain: 1.10, glow: 0.85, grain: 0.022 },
  },
  {
    name: 'Ambient',
    valence: 0.50, arousal: 0.50,
    colors: [[0.06, 0.07, 0.12], [0.24, 0.24, 0.36], [0.52, 0.54, 0.62]],
    motion: { flow: 0.12, turbulence: 0.70, contrast: 0.95, pulseGain: 0.40, glow: 0.65, grain: 0.012 },
  },
];

const SIGMA_SQ = 2 * 0.26 * 0.26;

/**
 * Blend every anchor by squared distance in the circumplex, so the mapping is
 * continuous: a mood drifting from Dreamy to Radiant slides through everything
 * in between instead of snapping between eight presets.
 * @returns {{name: string, colors: number[][], motion: Object}}
 */
export function blendMood(valence, arousal) {
  let weightSum = 0;
  const colors = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const motion = {};
  let nearest = MOOD_ANCHORS[0];
  let nearestGap = Infinity;

  for (const anchor of MOOD_ANCHORS) {
    const dv = valence - anchor.valence;
    const da = arousal - anchor.arousal;
    const weight = Math.exp(-(dv * dv + da * da) / SIGMA_SQ);
    weightSum += weight;
    for (let stop = 0; stop < 3; stop++) {
      for (let channel = 0; channel < 3; channel++) {
        colors[stop][channel] += weight * anchor.colors[stop][channel];
      }
    }
    for (const [key, value] of Object.entries(anchor.motion)) {
      motion[key] = (motion[key] ?? 0) + weight * value;
    }
    const gap = dv * dv + da * da;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = anchor;
    }
  }

  if (weightSum < 1e-4) return { name: nearest.name, colors: nearest.colors, motion: nearest.motion };

  for (let stop = 0; stop < 3; stop++) {
    for (let channel = 0; channel < 3; channel++) colors[stop][channel] /= weightSum;
  }
  for (const key of Object.keys(motion)) motion[key] /= weightSum;

  return { name: nearest.name, colors, motion };
}
