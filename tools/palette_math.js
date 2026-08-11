/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// ProceduralPalette mirrors the engine's cosine approximation. GenerativePalette
// samples engine-compiled 8-bit sRGB LUTs and interpolates them in linear light.
// The device evaluates its native palette at 16-bit precision, so the browser
// preview can differ most in dark tones.

import { srgbToLinearFloat, linearToSrgbFloat } from './color.js';
import { formatFloatCpp } from './cpp_format.js';

const TWO_PI = 2 * Math.PI;

// Mirror of the engine's fast_cosf (core/math/3dmath.h): a Bhaskara I sine
// approximation, range-reduced to [0, 2π). ProceduralPalette::get evaluates its
// cosine this way on the per-sample path, so the browser preview must use the
// same approximation (not Math.cos) to predict device colors.
function fastSin(x) {
  x -= Math.floor(x / TWO_PI) * TWO_PI;
  let sign = 1;
  if (x > Math.PI) { x -= Math.PI; sign = -1; }
  const xpi = x * (Math.PI - x);
  return (sign * 16 * xpi) / (5 * Math.PI * Math.PI - 4 * xpi);
}
function fastCos(x) { return fastSin(x + Math.PI * 0.5); }

// --- WASM color-math bridge -------------------------------------------------
let paletteOps = null;

/**
 * Installs the module-lifetime PaletteOps instance every generative-palette
 * call compiles through. The page installs it once the WASM module is up, and
 * passes null to drop it.
 * @param {{compileAndBakeV4:Function, inspectV4:Function}|null} ops - The engine bridge, or null to clear it.
 * @returns {void}
 */
export function setPaletteOps(ops) {
  paletteOps = ops;
}

/**
 * The core procedural palette, defined by C(t) = A + B * cos(TWO_PI * (C * t + D)).
 */
export class ProceduralPalette {
  /**
   * Stores the four cosine-formula coefficient vectors.
   * @param {number[]} a - [r, g, b] vec3 of A (DC offset) coefficients.
   * @param {number[]} b - [r, g, b] vec3 of B (amplitude) coefficients.
   * @param {number[]} c - [r, g, b] vec3 of C (frequency) coefficients.
   * @param {number[]} d - [r, g, b] vec3 of D (phase) coefficients.
   */
  constructor(a, b, c, d) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }

  /**
   * Calculates the linearized color vector (R, G, B) for a time parameter t.
   * @param {number} t - Time parameter in [0, 1].
   * @returns {number[]} Linear [R, G, B] float values in [0, 1], approximating
   *   the C++ pipeline: the cosine uses the engine's fast_cosf approximation
   *   and is linearized with an exact pow, so the result can differ from the
   *   device's interpolated 16-bit-linear LUT by up to ~1 LSB per channel.
   */
  get(t) {
    const r = Math.max(0, Math.min(1, this.a[0] + this.b[0] * fastCos(TWO_PI * (this.c[0] * t + this.d[0]))));
    const g = Math.max(0, Math.min(1, this.a[1] + this.b[1] * fastCos(TWO_PI * (this.c[1] * t + this.d[1]))));
    const b = Math.max(0, Math.min(1, this.a[2] + this.b[2] * fastCos(TWO_PI * (this.c[2] * t + this.d[2]))));

    return [srgbToLinearFloat(r), srgbToLinearFloat(g), srgbToLinearFloat(b)];
  }

  /**
   * Raw (unclamped, sRGB) cosine values for all three channels at t, used to
   * plot the underlying curves where over/undershoot past [0, 1] is visible.
   * @param {number} t - Time parameter in [0, 1].
   * @returns {number[]} Unclamped sRGB cosine values as [R, G, B].
   */
  getChannelValues(t) {
    return [
      this.a[0] + this.b[0] * fastCos(TWO_PI * (this.c[0] * t + this.d[0])),
      this.a[1] + this.b[1] * fastCos(TWO_PI * (this.c[1] * t + this.d[1])),
      this.a[2] + this.b[2] * fastCos(TWO_PI * (this.c[2] * t + this.d[2])),
    ];
  }

  /**
   * One channel of the raw (unclamped, sRGB) cosine sample at t.
   * @param {number} t - Time parameter in [0, 1].
   * @param {number} channelIndex - Channel to sample (0=R, 1=G, 2=B).
   * @returns {number} Unclamped sRGB cosine value for the channel.
   */
  getChannelValue(t, channelIndex) {
    return this.getChannelValues(t)[channelIndex];
  }
}

/**
 * The named procedural palettes shipped by the engine, mirrored from
 * HS_PROCEDURAL_PALETTE_LIST in core/color/palettes.h. Each entry's a/b/c/d are
 * the cosine-formula coefficient vec3s in that macro's order, so a gallery
 * preview and its exported code match the on-device palette.
 * @type {{name:string, a:number[], b:number[], c:number[], d:number[]}[]}
 */
export const NAMED_PROCEDURAL_PALETTES = [
  { name: 'DARK_RAINBOW', a: [0.367, 0.367, 0.367], b: [0.500, 0.500, 0.500], c: [1.000, 1.000, 1.000], d: [0.000, 0.330, 0.670] },
  { name: 'BLOOD_STREAM', a: [0.169, 0.169, 0.169], b: [0.313, 0.313, 0.313], c: [0.231, 0.231, 0.231], d: [0.036, 0.366, 0.706] },
  { name: 'VINTAGE_SUNSET', a: [0.256, 0.256, 0.256], b: [0.500, 0.080, 0.500], c: [0.277, 0.277, 0.277], d: [0.000, 0.330, 0.670] },
  { name: 'RICH_SUNSET', a: [0.309, 0.500, 0.500], b: [1.000, 1.000, 0.500], c: [0.149, 0.148, 0.149], d: [0.132, 0.222, 0.521] },
  { name: 'UNDERSEA', a: [0.000, 0.000, 0.000], b: [0.500, 0.276, 0.423], c: [0.296, 0.296, 0.296], d: [0.374, 0.941, 0.000] },
  { name: 'LATE_SUNSET', a: [0.337, 0.500, 0.096], b: [0.500, 1.000, 0.176], c: [0.261, 0.261, 0.261], d: [0.153, 0.483, 0.773] },
  { name: 'MANGO_PEEL', a: [0.500, 0.500, 0.500], b: [0.500, 0.080, 0.500], c: [0.431, 0.431, 0.431], d: [0.566, 0.896, 0.236] },
  { name: 'ICE_MELT', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.083, 0.147, 0.082], d: [0.579, 0.353, 0.244] },
  { name: 'LEMON_LIME', a: [0.455, 0.455, 0.455], b: [0.571, 0.151, 0.571], c: [0.320, 0.320, 0.320], d: [0.087, 0.979, 0.319] },
  { name: 'ALGAE', a: [0.210, 0.210, 0.210], b: [0.500, 1.000, 0.021], c: [0.086, 0.086, 0.075], d: [0.419, 0.213, 0.436] },
  { name: 'EMBERS', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.265, 0.285, 0.198], d: [0.577, 0.440, 0.358] },
  { name: 'FIRE_GLOW', a: [0.000, 0.000, 0.000], b: [0.560, 0.560, 0.560], c: [0.216, 0.346, 0.174], d: [0.756, 0.542, 0.279] },
  { name: 'DARK_PRIMARY', a: [0.500, 0.500, 0.500], b: [0.500, 0.610, 0.500], c: [0.746, 0.347, 0.000], d: [0.187, 0.417, 0.670] },
  { name: 'MAUVE_FADE', a: [0.583, 0.000, 0.583], b: [1.000, 0.000, 1.000], c: [0.191, 0.348, 0.191], d: [0.175, 0.045, 0.150] },
  { name: 'LAVENDER_LAKE', a: [0.473, 0.473, 0.473], b: [0.500, 0.500, 0.500], c: [0.364, 0.124, 0.528], d: [0.142, 0.378, 0.876] },
  { name: 'DESERT_ROSE', a: [0.500, 0.500, 0.500], b: [0.500, 0.270, 0.442], c: [0.303, 1.012, 0.585], d: [0.985, 0.720, 0.212] },
  { name: 'BRUISED_MOSS', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.142, 0.252, 0.000], d: [0.492, 0.200, 0.670] },
  { name: 'BRUISED_BANANA', a: [0.175, 0.470, 0.171], b: [1.000, 0.622, 0.000], c: [0.191, 0.191, 0.191], d: [0.629, -0.417, 0.444] },
  { name: 'BRIGHT_SUNRISE', a: [0.620, 0.620, 0.620], b: [0.742, 0.742, 0.742], c: [0.162, 0.286, 0.012], d: [0.090, 0.205, 0.688] },
  { name: 'FIRE_AND_ICE', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.955, 1.004, 0.910], d: [0.167, 0.018, 0.930] },
  { name: 'PEACH_POP', a: [1.000, 0.144, 0.175], b: [0.543, 0.543, 0.543], c: [0.507, 0.409, 0.507], d: [0.001, 0.002, 0.620] },
  { name: 'POPPED_PEACH', a: [1.000, 0.144, 0.175], b: [0.543, 0.543, 0.543], c: [-0.507, -0.409, -0.507], d: [0.508, 0.411, 1.127] },
  { name: 'BLUE_LAGOON', a: [0.253, 0.500, 1.000], b: [0.500, 0.844, 1.000], c: [0.232086, 0.232086, 0.232086], d: [0.279882, 0.609882, 0.949882] },
  { name: 'ORANGE_CRUSH', a: [0.575, 0.168, 0.464], b: [0.406, 0.697, 0.357], c: [0.000, -0.10051, -0.042778], d: [0.141, 0.25551, 0.579778] },
  { name: 'PLUM_SUNRISE', a: [0.407, 0.000, 0.296], b: [0.332, 0.592, 0.029], c: [0.358961, 0.331145, 0.274519], d: [0.500342, 0.505109, 0.278634] },
  { name: 'CORAL_BLUE', a: [0.4, 0.347, 0.801], b: [0.5, 0.303, 0.5], c: [0.75363518, -0.20031623, 0.0110030736], d: [0.9144297, -0.16868377, 0.40006184] },
  { name: 'BRUISED_MANGO', a: [0.385, 0.470, 0.171], b: [1.000, 0.518, 0.000], c: [0.191, 0.191, 5.000], d: [0.619, -0.427, 0.887] },
];

/**
 * Flattens a palette's a/b/c/d coefficient vec3s into the tool's 12-key
 * `parameters` object (A_R..D_B) the sliders and the C++ export read.
 * @param {{a:number[], b:number[], c:number[], d:number[]}} palette - A {a,b,c,d} coefficient set (e.g. a NAMED_PROCEDURAL_PALETTES entry).
 * @returns {{A_R:number,A_G:number,A_B:number,B_R:number,B_G:number,B_B:number,C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} The flattened coefficients.
 */
export function proceduralPaletteParams({ a, b, c, d }) {
  return {
    A_R: a[0], A_G: a[1], A_B: a[2],
    B_R: b[0], B_G: b[1], B_B: b[2],
    C_R: c[0], C_G: c[1], C_B: c[2],
    D_R: d[0], D_G: d[1], D_B: d[2],
  };
}

/**
 * Re-parameterizes a procedural palette so t in [0, 1] covers only the
 * viewport's window of the original: each channel's frequency scales by the
 * window's span and its phase absorbs the window's start. A zoomed strip then
 * plots the same colors at full width without the caller remapping t.
 * @param {{A_R:number,A_G:number,A_B:number,B_R:number,B_G:number,B_B:number,C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} parameters - The 12 cosine coefficients.
 * @param {{start:number, end:number}} viewport - The visible window, in the palette's own 0..1 phase.
 * @returns {Object} The same 12 keys, with C and D rewritten for the window.
 */
export function proceduralParamsForViewport(parameters, viewport) {
  const span = viewport.end - viewport.start;
  return {
    ...parameters,
    C_R: parameters.C_R * span,
    D_R: (parameters.D_R + parameters.C_R * viewport.start) % 1.0,
    C_G: parameters.C_G * span,
    D_G: (parameters.D_G + parameters.C_G * viewport.start) % 1.0,
    C_B: parameters.C_B * span,
    D_B: (parameters.D_B + parameters.C_B * viewport.start) % 1.0,
  };
}

// --- Generative Palette V4 --------------------------------------------------

/**
 * Compiles a recipe with the engine and copies its aliased module buffers. The
 * bridge returns views onto WASM memory, which the next call reuses, so the
 * results are copied out before they can be overwritten.
 * @param {Object} recipe - A V4 palette recipe.
 * @param {boolean} [inspect=true] - Whether to also bake the per-sample diagnostics the tool plots; false bakes the LUT alone.
 * @returns {{status:Object, canonicalRecipe:(Object|undefined), lut:(Uint8Array|undefined), diagnostics:(Float32Array|undefined), fallback:(Uint8Array|undefined)}} The detached compile result; `status.code` is 0 on success.
 * @throws {Error} When no PaletteOps bridge has been installed.
 */
export function compilePaletteRecipe(recipe, inspect = true) {
  if (!paletteOps) {
    throw new Error('PaletteOps bridge is not initialized');
  }
  const result = inspect
    ? paletteOps.inspectV4(recipe)
    : paletteOps.compileAndBakeV4(recipe);
  const copied = {
    status: { ...result.status },
    canonicalRecipe: result.canonicalRecipe
      ? structuredClone(result.canonicalRecipe)
      : undefined,
  };
  if (result.lut) copied.lut = Uint8Array.from(result.lut);
  if (result.diagnostics) copied.diagnostics = Float32Array.from(result.diagnostics);
  if (result.fallback) copied.fallback = Uint8Array.from(result.fallback);
  return copied;
}

/**
 * A compiled V4 palette: the engine's own 256-entry sRGB LUT, sampled the way
 * the device samples it. Interchangeable with ProceduralPalette at the
 * get/getChannelValue(s) surface the previews draw through.
 */
export class GenerativePalette {
  /**
   * Compiles the recipe and keeps the baked LUT and diagnostics.
   * @param {Object} recipe - A V4 palette recipe.
   * @throws {Error} When the recipe does not compile, carrying the status code and field.
   */
  constructor(recipe) {
    const result = compilePaletteRecipe(recipe, true);
    if (result.status.code !== 0) {
      throw new Error(
        `Palette recipe error ${result.status.code} at field ${result.status.field}`);
    }
    this.canonicalRecipe = result.canonicalRecipe;
    this.lut = result.lut;
    this.diagnostics = result.diagnostics;
    this.fallback = result.fallback;
  }

  /**
   * The linearized color at a phase, interpolated between LUT entries.
   * @param {number} t - Phase in [0, 1]; outside it the ends hold, and NaN reads the last entry.
   * @returns {number[]} Linear [R, G, B] in [0, 1].
   */
  get(t) {
    const index = Math.max(0, Math.min(255, Number.isNaN(t) ? 255 : t * 255));
    const left = Math.floor(index);
    const right = Math.min(255, left + 1);
    const weight = index - left;
    const color = [];
    for (let channel = 0; channel < 3; channel += 1) {
      const a = srgbToLinearFloat(this.lut[left * 3 + channel] / 255);
      const b = srgbToLinearFloat(this.lut[right * 3 + channel] / 255);
      color.push(a + (b - a) * weight);
    }
    return color;
  }

  /**
   * All three channels at a phase, in sRGB, as the wave graph plots them.
   * @param {number} t - Phase in [0, 1].
   * @returns {number[]} sRGB [R, G, B].
   */
  getChannelValues(t) {
    return this.get(t).map(linearToSrgbFloat);
  }

  /**
   * One channel of the sRGB sample at a phase.
   * @param {number} t - Phase in [0, 1].
   * @param {number} channelIndex - Channel to read (0=R, 1=G, 2=B).
   * @returns {number} The channel's sRGB value.
   */
  getChannelValue(t, channelIndex) {
    return this.getChannelValues(t)[channelIndex];
  }

  /**
   * The compiler's own account of the nearest LUT entry to a phase, for the
   * inspector: where the color sat in OKLCH, how much chroma the gamut allowed
   * there, and whether it had to be mapped back into gamut.
   * @param {number} t - Phase in [0, 1]; the nearest of the 256 entries answers.
   * @returns {{t:number, rgb:number[], L:number, C:number, q:number, Cmax:number, hPath:number, hFinal:number, fallbackMapped:boolean}}
   *   The entry's phase and 8-bit sRGB triple, the OKLCH lightness and chroma it
   *   resolved to, the chroma control `q` as a fraction of the boundary, the
   *   gamut's chroma ceiling `Cmax` at that lightness and hue, the hue the color
   *   path asked for and the hue torsion left it at, and whether the color fell
   *   out of gamut and was mapped back in.
   */
  diagnosticAt(t) {
    const index = Math.max(0, Math.min(255, Math.round(t * 255)));
    const offset = index * 6;
    return {
      t: index / 255,
      rgb: Array.from(this.lut.slice(index * 3, index * 3 + 3)),
      L: this.diagnostics[offset],
      C: this.diagnostics[offset + 1],
      q: this.diagnostics[offset + 2],
      Cmax: this.diagnostics[offset + 3],
      hPath: this.diagnostics[offset + 4],
      hFinal: this.diagnostics[offset + 5],
      fallbackMapped: this.fallback[index] !== 0,
    };
  }
}

/**
 * Linearly remaps a value from the [fromMin, fromMax] range onto [toMin, toMax].
 * Not clamped: inputs outside the source range extrapolate past the target range.
 * @param {number} value - Input value to remap.
 * @param {number} fromMin - Lower bound of the source range.
 * @param {number} fromMax - Upper bound of the source range.
 * @param {number} toMin - Lower bound of the target range.
 * @param {number} toMax - Upper bound of the target range.
 * @returns {number} The remapped value.
 */
export function mapValue(value, fromMin, fromMax, toMin, toMax) {
  if (fromMax === fromMin) return toMin;
  return (value - fromMin) * (toMax - toMin) / (fromMax - fromMin) + toMin;
}

/**
 * The value range the RGB wave graph plots. Wider than the [0, 1] output range
 * so a channel's out-of-range excursions — which the device clamps — stay
 * visible rather than flattening against the top or bottom of the canvas.
 * @type {{min: number, max: number}}
 */
export const WAVE_GRAPH_VALUE_RANGE = { min: -0.5, max: 1.5 };

/**
 * Maps WAVE_GRAPH_VALUE_RANGE onto a wave-graph canvas of the given height: the
 * band between 10% and 90% of the height, value increasing upward. The 10%
 * margins leave the range-boundary lines drawable inside the canvas.
 * @param {number} height - Canvas height in pixels.
 * @returns {{yTop: number, yBottom: number, toY: function(number): number}} The band's canvas-y edges (yTop is the max-value edge) and the value-to-canvas-y map.
 */
export function waveGraphBand(height) {
  const yTop = height * 0.1;
  const yBottom = height * 0.9;
  const { min, max } = WAVE_GRAPH_VALUE_RANGE;
  return { yTop, yBottom, toY: (value) => mapValue(value, min, max, yBottom, yTop) };
}

/**
 * Emit the C++ initializer the engine actually consumes —
 * `ProceduralPalette name({r,g,b}f, ...)` — not bare JS arrays. Brace-init
 * each vec3 with `f`-suffixed floats so the output pastes straight into
 * palettes.h beside the named instances, matching the generative tab.
 * @param {{A_R:number,A_G:number,A_B:number,B_R:number,B_G:number,B_B:number,C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} parameters - The 12 cosine-formula coefficients (A/B/C/D per R/G/B channel).
 * @returns {string} The C++ ProceduralPalette initializer source.
 */
export function proceduralPaletteCpp(parameters) {
  const f = (n) => formatFloatCpp(n, 6);
  const v = (r, g, b) => `{${f(r)}, ${f(g)}, ${f(b)}}`;
  return `ProceduralPalette palette(${v(parameters.A_R, parameters.A_G, parameters.A_B)},  // A
                          ${v(parameters.B_R, parameters.B_G, parameters.B_B)},  // B
                          ${v(parameters.C_R, parameters.C_G, parameters.C_B)},  // C
                          ${v(parameters.D_R, parameters.D_G, parameters.D_B)}); // D`;
}

/**
 * The C++ enumerator each V4 recipe enum value serializes as, indexed by value.
 * The inverse of palette_controls.js's PaletteV4; engine_source_parity.test.js
 * pins both to the `enum class` rosters in core/color/color.h.
 */
export const ENUM_NAMES = Object.freeze({
  domain: ['STRAIGHT', 'MIRROR', 'VIGNETTE', 'FALLOFF', 'LOOP'],
  easing: ['LINEAR', 'COSINE', 'SMOOTHSTEP'],
  colorPath: ['OKLCH_ARC', 'OKLAB_CARTESIAN'],
  hueMode: ['HARMONY', 'SWEEP', 'CUSTOM'],
  harmony: [
    'MONOCHROMATIC',
    'ANALOGOUS',
    'ACCENTED_ANALOGOUS',
    'COMPLEMENTARY',
    'SPLIT_COMPLEMENTARY',
    'TRIADIC',
    'TETRADIC',
    'SQUARE',
  ],
  direction: ['SHORTEST', 'CLOCKWISE', 'COUNTERCLOCKWISE'],
  curve: ['CONSTANT', 'ASCENDING', 'DESCENDING', 'BELL', 'CUP', 'CUSTOM'],
  chromaBasis: ['LOCAL_GAMUT', 'PATH_MINIMUM', 'ABSOLUTE'],
});

function enumName(group, value) {
  const name = ENUM_NAMES[group]?.[value];
  if (!name) throw new Error(`unknown ${group} enum value ${value}`);
  return name;
}

function cppFloatArray(values) {
  return `{${values.map((value) => formatFloatCpp(value, 6)).join(', ')}}`;
}

/**
 * Serializes a complete canonical V4 recipe as the C++ that rebuilds it: every
 * field assigned, then the try_compile call and the assert the engine's callers
 * carry.
 * @param {Object} recipe - A canonical V4 recipe, as the compiler returned it.
 * @returns {string} The C++ source, ready to paste.
 * @throws {Error} When a field holds an enum ordinal the engine has no name for.
 */
export function generativePaletteCpp(recipe) {
  const f = (value) => formatFloatCpp(value, 6);
  return `PaletteRecipe recipe;
recipe.schema_version = ${recipe.schemaVersion};
recipe.input.offset = ${f(recipe.input.offset)};
recipe.input.span = ${f(recipe.input.span)};
recipe.domain = PaletteDomain::${enumName('domain', recipe.domain)};
recipe.easing = SegmentEase::${enumName('easing', recipe.easing)};
recipe.color_path = ColorPath::${enumName('colorPath', recipe.colorPath)};
recipe.hue.mode = HueMode::${enumName('hueMode', recipe.hue.mode)};
recipe.hue.harmony = PaletteHarmony::${enumName('harmony', recipe.hue.harmony)};
recipe.hue.direction = HueDirection::${enumName('direction', recipe.hue.direction)};
recipe.hue.base_turns = ${f(recipe.hue.baseTurns)};
recipe.hue.spread_turns = ${f(recipe.hue.spreadTurns)};
recipe.hue.sweep_turns = ${f(recipe.hue.sweepTurns)};
recipe.hue.custom_turns = ${cppFloatArray(recipe.hue.customTurns)};
recipe.lightness.curve = AxisCurve::${enumName('curve', recipe.lightness.curve)};
recipe.lightness.center = ${f(recipe.lightness.center)};
recipe.lightness.range = ${f(recipe.lightness.range)};
recipe.lightness.custom = ${cppFloatArray(recipe.lightness.custom)};
recipe.chroma.curve = AxisCurve::${enumName('curve', recipe.chroma.curve)};
recipe.chroma.basis = ChromaBasis::${enumName('chromaBasis', recipe.chroma.basis)};
recipe.chroma.center = ${f(recipe.chroma.center)};
recipe.chroma.range = ${f(recipe.chroma.range)};
recipe.chroma.headroom = ${f(recipe.chroma.headroom)};
recipe.chroma.custom = ${cppFloatArray(recipe.chroma.custom)};
recipe.hue_torsion = ${f(recipe.hueTorsion)};
recipe.falloff_start = ${f(recipe.falloffStart)};
GenerativePalette palette;
PaletteRecipe canonical;
PaletteCompileStatus status;
HS_CHECK(GenerativePalette::try_compile(recipe, palette, canonical, status),
         "Palette recipe error %d at field %d", static_cast<int>(status.code),
         static_cast<int>(status.field));`;
}
