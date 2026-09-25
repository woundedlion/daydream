/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Hand-written declarations for holosphere_wasm.js, the Emscripten glue the
 * Holosphere WASM install writes here. The glue itself is a generated install
 * output and is never type-checked (tests/tsconfig_roster.test.js), so this
 * file is what the typecheck sees for the module. It covers the surface the
 * segment pipeline drives plus the MeshOps and PaletteOps bridges the
 * standalone tools run on; tests/helpers/fake_engine.js pins that method roster and all
 * six result enums — ParamSetResult, ClipSetResult, ResolutionSetResult,
 * EffectSetResult, FullConfigRestoreResult, ChainStatus — against the real module, and
 * tests/engine_contract_wasm.test.js pins the declarations below against both.
 */

/**
 * An embind enum instance. Every value is a distinct truthy object, so results
 * are compared by identity against the module's enum members, never by
 * truthiness.
 */
export interface EnumValue {
  readonly value: number;
}

/**
 * Usage snapshot of a single arena, in bytes. `high_water_mark` is the peak
 * since the last resplit_arenas(); `lifetime_high_water_mark` is the peak over
 * the module's whole life, which no resplit clears and which may exceed the
 * current `capacity`. Size a budget against the lifetime figure; a fill bar or
 * an overrun check reads the windowed one, which shares capacity's split.
 */
export interface ArenaUsage {
  usage: number;
  high_water_mark: number;
  lifetime_high_water_mark: number;
  capacity: number;
}

/**
 * Usage snapshot of the WASM stack, in bytes. No running usage: the depth at
 * the read is outside any render. `high_water_mark` is the canary's live
 * reading, which a repaint resets; `init_high_water_mark` is the latched
 * effect-construction peak, which no repaint erases.
 */
export interface StackUsage {
  high_water_mark: number;
  init_high_water_mark: number;
  capacity: number;
}

/** The engine's arena usage snapshot. */
export interface ArenaMetrics {
  scratch_arena_a: ArenaUsage;
  scratch_arena_b: ArenaUsage;
  persistent_arena: ArenaUsage;
  stack: StackUsage;
}

/** The fields every getParameterDefinitions() entry carries, toggle or not. */
export interface ParameterDefinitionBase {
  /** Parameter name, as setParameter() takes it. */
  name: string;
  /**
   * True while the engine animates the value. An accepted setParameter() write
   * to an animated param engages the engine's animation pause.
   */
  animated: boolean;
  /** True for engine-written telemetry; setParameter() answers it READONLY. */
  readonly: boolean;
  /** True when a preset export carries this parameter. */
  preset: boolean;
  /** Actionable reason the requested value cannot currently be rendered. */
  warning?: string;
}

/** A toggle. Its value is a JS boolean and it carries no range or options. */
export interface BooleanParameterDefinition extends ParameterDefinitionBase {
  /** Current rendered value shown by the GUI. */
  value: boolean;
  /** Writable target copied when another renderer is initialized. */
  requestedValue: boolean;
  /** Last value admitted for rendering. */
  acceptedValue: boolean;
}

/**
 * Every non-toggle parameter: sliders and enums alike carry `min`/`max`, so
 * neither is optional here. `step` is 1 on a whole-number target — an enum or
 * an integer count — and absent on a float one. `options` labels an enum by
 * value index — the value is the selected index — and `exportOptions` carries
 * the matching C++ enum literals, present only when the effect declares them;
 * an integer count carries its range instead and exports as a numeric literal.
 */
export interface NumericParameterDefinition extends ParameterDefinitionBase {
  /** Current rendered value shown by the GUI. */
  value: number;
  /** Writable target copied when another renderer is initialized. */
  requestedValue: number;
  /** Last value admitted for rendering. */
  acceptedValue: number;
  min: number;
  max: number;
  step?: number;
  options?: string[];
  exportOptions?: string[];
}

/**
 * One entry of getParameterDefinitions(). Narrow on `typeof value === 'boolean'`
 * to tell a toggle, which carries no range, from a ranged parameter.
 */
export type ParameterDefinition =
  | BooleanParameterDefinition
  | NumericParameterDefinition;

export interface FullConfigSnapshot {
  schemaVersion: number;
  accepted: number[];
  requested: number[];
  pendingFieldIds: number[];
  hasRuntime: boolean;
  runtime: number[];
}

export interface FullConfigFieldDefinition {
  id: number;
  name: string;
}

export interface HolosphereEngine {
  /** RESIZED tears the effect down; ALREADY_ACTIVE is a pure no-op; UNSUPPORTED keeps the old geometry. */
  setResolution(w: number, h: number): EnumValue;
  /** INSTALLED on success; UNKNOWN_EFFECT / UNSUPPORTED_RESOLUTION keep the prior effect. */
  setEffect(name: string): EnumValue;
  setParameter(name: string, value: number): EnumValue;
  setAnimationsPaused(paused: boolean): void;
  /** The pause state both the panel toggle and an animated-parameter write engage. */
  getAnimationsPaused(): boolean;
  getPresetCount(): number;
  getPresetIndex(): number;
  getPresetIds(): string[];
  selectPreset(index: number): boolean;
  selectPresetById(id: string): boolean;
  /** Adopts an index a segment worker already advanced to, without engaging the animation pause. */
  synchronizePreset(index: number): boolean;
  nextPreset(): boolean;
  previousPreset(): boolean;
  setPoleLod(value: number): void;
  /** Clamped value of the last setPoleLod() on this engine, else the build default. */
  getPoleLod(): number;
  /**
   * Restrict rendering to [x0,x1) x [y0,y1); reset by a setEffect rebuild.
   * Bounds must be integral and in range, or the answer is INVALID_BOUNDS.
   *
   * APPLIED and FULL_FRAME_KEPT are both successes, but only APPLIED means the
   * band is in force: an effect reporting needs_full_frame() or persists_pixels() keeps the full
   * canvas, so a segment pool has to tell the two apart to know whether a
   * worker rendered its band or recomputed the whole frame. NO_EFFECT is the
   * ordinary answer between a resolution change and the setEffect that follows
   * it, so a caller that faults on a rejection faults on INVALID_BOUNDS alone.
   */
  setClip(x0: number, x1: number, y0: number, y1: number): EnumValue;
  drawFrame(): void;
  /**
   * RGB16 canvas buffer, W*H*3, as a view over the module's memory. A render
   * narrowed by setClip writes the band only: every pixel outside it holds
   * whatever the buffer last did, at whatever age, so a reader under a
   * narrowed clip must take the band alone.
   */
  getPixels(): Uint16Array;
  /**
   * Element count of the active getPixels() view (w*h*3). A resolution change
   * moves this without detaching a held view, so a held view of a different
   * length spans a prior resolution.
   */
  getBufferLength(): number;
  getArenaMetrics(): ArenaMetrics;
  /** The bound effect's parameter descriptors, in declaration order; empty with no effect set. */
  getParameterDefinitions(): ParameterDefinition[];
  /**
   * Current values of the bound effect's parameters, in definition order, as a
   * zero-copy view over the module's memory, on the same lifetime contract as
   * getPixels(): consume it before the next call into the module, since heap
   * growth detaches it. The backing store is pre-reserved and never
   * reallocates here, so this call detaches no other outstanding view.
   */
  getParamValues(): ArrayLike<number> & Iterable<number>;
  /**
   * Identity token joining a getParameterDefinitions() snapshot to a later
   * getParamValues() read: it changes on every effect replacement and schema
   * rebind. Parameter counts repeat even when names and order do not, so pin
   * this beside a snapshot and rebuild the definitions when it moves.
   */
  getParamGeneration(): number;
  /** Complete Shader workbench state, independent of the visible parameter schema. */
  getFullConfigSnapshot(): FullConfigSnapshot | null;
  /** Atomically restore accepted, requested, pending, and optional runtime state. */
  restoreFullConfigSnapshot(snapshot: FullConfigSnapshot): EnumValue;
  /** Stable field ids and names in ConfigFieldId order; null with no Shader workbench loaded. */
  getFullConfigFieldDefinitions(): FullConfigFieldDefinition[] | null;
  /**
   * True when the effect strobes each POV column to black after it is shown
   * (discrete columns with dark gaps), false when columns persist and smear
   * into the next. False with no effect set.
   */
  strobeColumns(): boolean;
  /** Effect name to hint size at the active resolution; empty at an unsupported one. */
  getEffectSizes(): Record<string, number>;
  /** Effect name to authored preset count at the active resolution. */
  getEffectPresetCounts(): Record<string, number>;
  /**
   * The status compares by identity against HolosphereModule.ChainStatus.
   * Programs the ShaderChain effect with an ordered operator chain. APPLIED
   * rebuilds the parameter definitions (named `instance.field`) and bumps the
   * param generation before returning; any other code refuses transactionally,
   * with entryIndex naming the offending entry (-1 = the whole chain).
   */
  setShaderChain(
    entries: Array<{ instance: string; operator: string }>,
  ): { status: EnumValue; code: string; entryIndex: number };
  /** Atomically admits chain parameter values; returns a ParamSetResult member. */
  setShaderChainParameters(entries: Array<{ name: string; value: number }>): EnumValue;
  /** Embind destructor: releases the C++ instance the handle points at. */
  delete(): void;
}

/** Usage snapshot of MeshOps' arenas, in bytes; the tooling arenas are its own. */
export interface MeshArenaMetrics {
  scratch_arena_a: ArenaUsage;
  scratch_arena_b: ArenaUsage;
  persistent_arena: ArenaUsage;
  tooling_arena: ArenaUsage;
  tooling_scratch_a: ArenaUsage;
  tooling_scratch_b: ArenaUsage;
}

/** One row of the solid registry. */
export interface SolidRegistryEntry {
  /** Name fromSolidName() and getRecipe() take. */
  name: string;
  /** `Simple` for a registry seed, `Complex` for a recipe-built solid. */
  category: string;
}

/** One step of an authored chain, in the engine's own argument units. */
export interface SolidRecipeStep {
  op: string;
  param: number;
  twist: number;
}

/** A Complex solid's authored chain: a Simple seed plus the ops applied to it. */
export interface SolidRecipe {
  seed: string;
  ops: SolidRecipeStep[];
}

/**
 * Flat face storage: face `i` reads `counts[i]` entries from `indices`,
 * continuing where face `i - 1` stopped.
 */
export interface MeshFaces {
  indices: Uint16Array;
  counts: Uint8Array;
}

/**
 * A live mesh in the tooling arenas. Every operator answers a new handle or
 * null, with the reason in MeshOps.getLastResult(); a handle held across
 * clearToolingMemory() aliases reclaimed storage and is refused as
 * STALE_WRAPPER.
 */
export interface MeshHandle {
  /**
   * Flat x/y/z per vertex, copied out of module memory: the array stays valid
   * after delete() and clearToolingMemory().
   */
  getVertices(): Float32Array | null;
  /** Copied out of module memory, on the same terms as getVertices(). */
  getFaces(): MeshFaces | null;
  /**
   * One classification code per face, copied out of module memory on the same
   * terms as getVertices().
   */
  classifyFaces(): Int32Array | null;
  kis(): MeshHandle | null;
  ambo(): MeshHandle | null;
  gyro(): MeshHandle | null;
  dual(): MeshHandle | null;
  meta(): MeshHandle | null;
  needle(): MeshHandle | null;
  zip(): MeshHandle | null;
  truncate(t: number): MeshHandle | null;
  bevel(t: number): MeshHandle | null;
  chamfer(t: number): MeshHandle | null;
  expand(t: number): MeshHandle | null;
  snub(t: number, twist: number): MeshHandle | null;
  /** Takes the Hankin angle in radians. */
  hankin(angle: number): MeshHandle | null;
  relax(iterations: number): MeshHandle | null;
  /** Embind destructor: releases the C++ instance the handle points at. */
  delete(): void;
}

/** The MeshOps class object: solid construction and tooling-arena lifetime. */
export interface MeshOpsStatics {
  /** Available only in builds with HS_WASM_DEV_BINDINGS enabled. */
  getMaxBounds?(): {
    max_v: number; v_name: string;
    max_f: number; f_name: string;
    max_i: number; i_name: string;
  } | null;
  /** Builds a registered solid; null when the registry carries no such name. */
  fromSolidName(name: string): MeshHandle | null;
  /** Every registered solid, the Simple ones first in seed-index order. Preserves the last result and adjustment flags. */
  getRegistry(): SolidRegistryEntry[];
  /** A Complex solid's chain; null for a name that carries none. */
  getRecipe(name: string): SolidRecipe | null;
  /** Result of the last mesh operation; getRegistry() preserves the previous result. */
  getLastResult(): EnumValue;
  /** Whether the last call clamped an out-of-domain argument. */
  getLastAdjusted(): boolean;
  /** Reclaims the tooling arenas, staling every outstanding MeshHandle. */
  clearToolingMemory(): void;
  getArenaMetrics(): MeshArenaMetrics;
}

/** What setShaderChain().status answers, compared by identity against the member. */
export type ChainStatusEnum = {
  OK: EnumValue;
  NOT_CHAIN_EFFECT: EnumValue;
  MALFORMED_PAYLOAD: EnumValue;
  EMPTY: EnumValue;
  TOO_LONG: EnumValue;
  UNKNOWN_OPERATOR: EnumValue;
  DUPLICATE_INSTANCE: EnumValue;
  MALFORMED_INSTANCE: EnumValue;
  ENTRY_FAMILY: EnumValue;
  EXIT_FAMILY: EnumValue;
  CARRIER_MISMATCH: EnumValue;
  ARENA_OVERFLOW: EnumValue;
  PARAM_OVERFLOW: EnumValue;
  MIGRATE_FAILED: EnumValue;
};

/** What setClip() answers, compared by identity against the member. */
export type ClipSetResultEnum = {
  APPLIED: EnumValue;
  NO_EFFECT: EnumValue;
  INVALID_BOUNDS: EnumValue;
  FULL_FRAME_KEPT: EnumValue;
};

/** What setParameter() answers, compared by identity against the member. */
export type ParamSetResultEnum = {
  APPLIED: EnumValue;
  NO_EFFECT: EnumValue;
  UNKNOWN_PARAM: EnumValue;
  READONLY: EnumValue;
  NON_FINITE: EnumValue;
  INADMISSIBLE: EnumValue;
  MALFORMED_PAYLOAD: EnumValue;
  TOO_LONG: EnumValue;
};

/** What restoreFullConfigSnapshot() answers, compared by identity against the member. */
export type FullConfigRestoreResultEnum = {
  APPLIED: EnumValue;
  NOT_SHADER_WORKBENCH: EnumValue;
  UNSUPPORTED_VERSION: EnumValue;
  INVALID_LENGTH: EnumValue;
  INVALID_VALUE: EnumValue;
  INVALID_ACCEPTED: EnumValue;
  INVALID_PENDING: EnumValue;
};

/** What setResolution() answers, compared by identity against the member. */
export type ResolutionSetResultEnum = {
  RESIZED: EnumValue;
  ALREADY_ACTIVE: EnumValue;
  UNSUPPORTED: EnumValue;
};

/** What setEffect() answers, compared by identity against the member. */
export type EffectSetResultEnum = {
  INSTALLED: EnumValue;
  UNKNOWN_EFFECT: EnumValue;
  UNSUPPORTED_RESOLUTION: EnumValue;
};

/** Why a MeshOps call answered null, compared by identity against the member. */
export interface MeshOpResultEnum {
  OK: EnumValue;
  UNKNOWN_NAME: EnumValue;
  CONNECTIVITY_OVERFLOW: EnumValue;
  FACE_DEGREE_OVERFLOW: EnumValue;
  ARENA_EXHAUSTED: EnumValue;
  NON_FINITE_ARG: EnumValue;
  ANGLE_OUT_OF_DOMAIN: EnumValue;
  STALE_WRAPPER: EnumValue;
  ARENA_UNAVAILABLE: EnumValue;
}

export interface PaletteCompileCodeEnum {
  OK: EnumValue;
  INVALID_SCHEMA: EnumValue;
  NON_FINITE: EnumValue;
  INVALID_ENUM: EnumValue;
  HUE_LIMIT: EnumValue;
  NON_INTEGER_LOOP_SWEEP: EnumValue;
  INVALID_FALLOFF_START: EnumValue;
  INCOMPATIBLE_OPTIONS: EnumValue;
}

export interface PaletteRecipeFieldEnum {
  NONE: EnumValue;
  PALETTE_DOMAIN: EnumValue;
  EASING: EnumValue;
  COLOR_PATH: EnumValue;
  HUE_MODE: EnumValue;
  HARMONY: EnumValue;
  HUE_DIRECTION: EnumValue;
  BASE_TURNS: EnumValue;
  SPREAD_TURNS: EnumValue;
  SWEEP_TURNS: EnumValue;
  CUSTOM_TURNS_0: EnumValue;
  CUSTOM_TURNS_1: EnumValue;
  CUSTOM_TURNS_2: EnumValue;
  CUSTOM_TURNS_3: EnumValue;
  LIGHTNESS_CURVE: EnumValue;
  LIGHTNESS_CENTER: EnumValue;
  LIGHTNESS_RANGE: EnumValue;
  LIGHTNESS_CUSTOM_0: EnumValue;
  LIGHTNESS_CUSTOM_1: EnumValue;
  LIGHTNESS_CUSTOM_2: EnumValue;
  LIGHTNESS_CUSTOM_3: EnumValue;
  CHROMA_CURVE: EnumValue;
  CHROMA_BASIS: EnumValue;
  CHROMA_CENTER: EnumValue;
  CHROMA_RANGE: EnumValue;
  CHROMA_CUSTOM_0: EnumValue;
  CHROMA_CUSTOM_1: EnumValue;
  CHROMA_CUSTOM_2: EnumValue;
  CHROMA_CUSTOM_3: EnumValue;
  CHROMA_HEADROOM: EnumValue;
  HUE_TORSION: EnumValue;
  FALLOFF_START: EnumValue;
  SCHEMA_VERSION: EnumValue;
  INPUT_OFFSET: EnumValue;
  INPUT_SPAN: EnumValue;
  COUNT: EnumValue;
}

/** How one V4 palette compile went; `code` PaletteCompileCode.OK is success. */
export interface PaletteCompileStatus {
  code: EnumValue;
  /** Which recipe field an error names. */
  field: EnumValue;
  /** Bitmask over the recipe fields the compiler wrapped into range. */
  wrappedFields: number;
  /** The fields it clamped, in the same bit positions. */
  clampedFields: number;
  /** The fields it rewrote into canonical form, in the same bit positions. */
  canonicalizedFields: number;
}

/**
 * One compile and bake. The buffers are absent when the recipe did not compile,
 * and `diagnostics`/`fallback` also when the bake skipped them. All three alias
 * the module's memory rather than copying it: the next call into any PaletteOps
 * rebakes them in place, and heap growth detaches them.
 */
export interface PaletteCompileResult {
  status: PaletteCompileStatus;
  /** The recipe as the compiler normalized it. */
  canonicalRecipe?: object;
  /** 256 sRGB triples. */
  lut?: Uint8Array;
  /** Six values per entry: L, C, q, Cmax, hPath, hFinal. */
  diagnostics?: Float32Array;
  /** Per entry, non-zero where the color was mapped back into gamut. */
  fallback?: Uint8Array;
}

/** One effect-owned recipe the palette tool offers as a starting point. */
export interface PaletteEffectPreset {
  name: string;
  /** True where the effect randomizes the base hue at runtime. */
  randomHue: boolean;
  recipe: object;
}

/** The engine's V4 palette recipe compiler, as tools/palette_math.js drives it. */
export interface PaletteOps {
  compileAndBakeV4(recipe: object): PaletteCompileResult;
  /** compileAndBakeV4 plus the per-entry diagnostics and gamut-fallback flags. */
  inspectV4(recipe: object): PaletteCompileResult;
  effectPresetsV4(): PaletteEffectPreset[];
  /** Embind destructor: releases the C++ instance the handle points at. */
  delete(): void;
}

export interface HolosphereModule {
  PaletteCompileCode: PaletteCompileCodeEnum;
  PaletteRecipeField: PaletteRecipeFieldEnum;
  H_OFFSET: number;
  srgb_to_linear_float(s: number): number;
  linear_to_srgb_float(l: number): number;
  srgb_to_linear_interp(s: number): number;
  linear_rgb_to_oklab(r: number, g: number, b: number): { L: number; a: number; b: number };
  oklab_to_linear_rgb(L: number, a: number, b: number): { r: number; g: number; b: number };
  /** First sRGB gamut-exit chroma at lightness L along the unit OKLab direction (a,b), including the engine's numerical margin. Returns NaN for non-finite inputs. */
  gamut_max_chroma(L: number, a: number, b: number): number;
  /** Returns sRGB channels in the 8-bit range [0, 255]. */
  hsv_to_rgb(h: number, s: number, v: number): { r: number; g: number; b: number };
  /** Returns linear RGB channels in the 16-bit range [0, 65535]. */
  procedural_palette_linear(
    a0: number, a1: number, a2: number, b0: number, b1: number, b2: number,
    c0: number, c1: number, c2: number, d0: number, d1: number, d2: number,
    t: number,
  ): { r: number; g: number; b: number };
  named_procedural_palettes(): Array<{
    name: string;
    a: [number, number, number]; b: [number, number, number];
    c: [number, number, number]; d: [number, number, number];
  }>;
  lissajous(m1: number, m2: number, a: number, t: number): { x: number; y: number; z: number };
  mobius_transform(
    x: number, y: number, z: number, ar: number, ai: number, br: number,
    bi: number, cr: number, ci: number, dr: number, di: number,
  ): { x: number; y: number; z: number };
  HolosphereEngine: {
    new (): HolosphereEngine;
    /** Whether the module already owns its single live engine instance. */
    isLive(): boolean;
    /** Buildable [w, h] rows; the app narrows its resolution presets to these. */
    getSupportedResolutions(): Array<[number, number]>;
    /**
     * The engine's operator catalog as one JSON string, byte-identical (plus
     * the committed trailing newline) to the shader/engine_catalog.json pin.
     */
    getShaderChainCatalog(): string;
  };
  ChainStatus: ChainStatusEnum;
  ClipSetResult: ClipSetResultEnum;
  ParamSetResult: ParamSetResultEnum;
  FullConfigRestoreResult: FullConfigRestoreResultEnum;
  ResolutionSetResult: ResolutionSetResultEnum;
  EffectSetResult: EffectSetResultEnum;
  MeshOps: MeshOpsStatics;
  MeshOpResult: MeshOpResultEnum;
  PaletteOps: { new (): PaletteOps };
  /**
   * Set by HS_CHECK immediately before its trap, and absent until then. The
   * trap is terminal for the whole module: no later call recovers, so a
   * caller that sees this must discard the instance.
   */
  HS_MODULE_DEAD?: boolean;
}

/**
 * Emscripten module factory; `print`/`printErr` override the log sinks.
 * `instantiateWasm` replaces the glue's own fetch+compile of the binary: it is
 * handed the import object and calls back with an instance, so a caller holding
 * an already-compiled module supplies one without a second compilation. Async is
 * allowed — the glue awaits the callback — and the returned object is ignored.
 */
export default function createHolosphereModule(options?: {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    onInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object;
}): Promise<HolosphereModule>;
