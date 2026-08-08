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

export interface HolosphereEngine {
  /** @returns false when the resolution is rejected, leaving the old geometry. */
  setResolution(w: number, h: number): boolean;
  /** @returns false when no effect of that name exists. */
  setEffect(name: string): boolean;
  setParameter(name: string, value: number): EnumValue;
  setAnimationsPaused(paused: boolean): void;
  setPoleLod(value: number): void;
  /** Restrict rendering to [x0,x1) x [y0,y1); reset by a setEffect rebuild. */
  setClip(x0: number, x1: number, y0: number, y1: number): EnumValue;
  drawFrame(): void;
  /** RGB16 canvas buffer, W*H*3, as a view over the module's memory. */
  getPixels(): Uint16Array;
  getArenaMetrics(): ArenaMetrics;
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
}

/** Emscripten module factory; `print`/`printErr` override the log sinks. */
export default function createHolosphereModule(options?: {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}): Promise<HolosphereModule>;
