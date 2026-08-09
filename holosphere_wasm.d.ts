/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Hand-written declarations for holosphere_wasm.js, the Emscripten glue the
 * Holosphere WASM install writes here. The glue itself is a generated install
 * output and is never type-checked (tests/tsconfig_roster.test.js), so this
 * file is what the typecheck sees for the module. It covers the surface the
 * segment pipeline drives; tests/fake_engine.js pins that method roster and
 * both enums against the real module.
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

/**
 * One entry of getParameterDefinitions(). `value` is a boolean for a toggle,
 * which carries no range; every other parameter carries `min`/`max`. `options`
 * labels an enum by value index, and `exportOptions` carries the matching
 * symbolic names when the effect declares them.
 */
export interface ParameterDefinition {
  name: string;
  value: number | boolean;
  min?: number;
  max?: number;
  options?: string[];
  exportOptions?: string[];
  animated: boolean;
  readonly: boolean;
  preset: boolean;
}

export interface HolosphereEngine {
  /** RESIZED tears the effect down; ALREADY_ACTIVE is a pure no-op; UNSUPPORTED keeps the old geometry. */
  setResolution(w: number, h: number): EnumValue;
  /** INSTALLED on success; UNKNOWN_EFFECT / UNSUPPORTED_RESOLUTION keep the prior effect. */
  setEffect(name: string): EnumValue;
  setParameter(name: string, value: number): EnumValue;
  setAnimationsPaused(paused: boolean): void;
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
}

export interface HolosphereModule {
  HolosphereEngine: new () => HolosphereEngine;
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

/** Emscripten module factory; `print`/`printErr` override the log sinks. */
export default function createHolosphereModule(options?: {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}): Promise<HolosphereModule>;
