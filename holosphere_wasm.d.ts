/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Hand-written declarations for holosphere_wasm.js, the Emscripten glue the
 * Holosphere WASM install writes here. The glue itself is a generated install
 * output and is never type-checked (tests/tsconfig_roster.test.js), so this
 * file is what the typecheck sees for the module. It covers the surface the
 * segment pipeline drives; tests/fake_engine.js pins that method roster and all
 * four result enums — ParamSetResult, ClipSetResult, ResolutionSetResult,
 * EffectSetResult — against the real module, and
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

/** Usage snapshot of a single arena, in bytes. */
export interface ArenaUsage {
  usage: number;
  high_water_mark: number;
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
  selectPreset(index: number): boolean;
  /** Adopts an index a segment worker already advanced to, without engaging the animation pause. */
  synchronizePreset(index: number): boolean;
  nextPreset(): boolean;
  previousPreset(): boolean;
  setPoleLod(value: number): void;
  /** Restrict rendering to [x0,x1) x [y0,y1); reset by a setEffect rebuild. */
  setClip(x0: number, x1: number, y0: number, y1: number): EnumValue;
  drawFrame(): void;
  /** RGB16 canvas buffer, W*H*3, as a view over the module's memory. */
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
  /** Current values of the bound effect's parameters, in definition order. */
  getParamValues(): ArrayLike<number> & Iterable<number>;
  /**
   * Identity token joining a getParameterDefinitions() snapshot to a later
   * getParamValues() read: it changes on every effect replacement and schema
   * rebind. Parameter counts repeat even when names and order do not, so pin
   * this beside a snapshot and rebuild the definitions when it moves.
   */
  getParamGeneration(): number;
  /** Complete ShaderBall state, independent of the visible parameter schema. */
  getFullConfigSnapshot?(): FullConfigSnapshot | null;
  /** Atomically restore accepted, requested, pending, and optional runtime state. */
  restoreFullConfigSnapshot?(snapshot: FullConfigSnapshot): EnumValue;
  getFullConfigFieldDefinitions?(): FullConfigFieldDefinition[];
  getConfigImportNotice?(): string;
  clearConfigImportNotice?(): void;
  /**
   * True when the effect strobes each POV column to black after it is shown
   * (discrete columns with dark gaps), false when columns persist and smear
   * into the next. False with no effect set.
   */
  strobeColumns(): boolean;
  /** Effect name to hint size at the active resolution; empty at an unsupported one. */
  getEffectSizes(): Record<string, number>;
}

export interface HolosphereModule {
  HolosphereEngine: {
    new (): HolosphereEngine;
    /** Buildable [w, h] rows; the app narrows its resolution presets to these. */
    getSupportedResolutions(): Array<[number, number]>;
  };
  ClipSetResult: {
    APPLIED: EnumValue;
    NO_EFFECT: EnumValue;
    INVALID_BOUNDS: EnumValue;
    FULL_FRAME_KEPT: EnumValue;
  };
  ParamSetResult: {
    APPLIED: EnumValue;
    NO_EFFECT: EnumValue;
    UNKNOWN_PARAM: EnumValue;
    READONLY: EnumValue;
    NON_FINITE: EnumValue;
  };
  FullConfigRestoreResult?: {
    APPLIED: EnumValue;
    NOT_SHADERBALL: EnumValue;
    UNSUPPORTED_VERSION: EnumValue;
    INVALID_LENGTH: EnumValue;
    INVALID_VALUE: EnumValue;
    INVALID_ACCEPTED: EnumValue;
    INVALID_PENDING: EnumValue;
  };
  ResolutionSetResult: {
    RESIZED: EnumValue;
    ALREADY_ACTIVE: EnumValue;
    UNSUPPORTED: EnumValue;
  };
  EffectSetResult: {
    INSTALLED: EnumValue;
    UNKNOWN_EFFECT: EnumValue;
    UNSUPPORTED_RESOLUTION: EnumValue;
  };
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
