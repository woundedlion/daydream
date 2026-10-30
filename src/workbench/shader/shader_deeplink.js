/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// @ts-check

import { replaceUrl } from '../../shared/url.js';

/** Absolute URL of the installed shader document compiler. */
export const COMPILER_URL = new URL('../../../generated/shader/shader_workbench.mjs', import.meta.url).href;
const PREFIX = '#shader=v2.';
const MAX_PAYLOAD_CHARS = 65536;
const MAX_STATE_BYTES = 524288;

/** Chain snapshot schema the engine's ChainSnapshot encodes and accepts. */
export const CHAIN_SNAPSHOT_SCHEMA_VERSION = 4;

/** @param {*} snapshot @returns {*} Snapshot with independent color modulation nodes. */
export function migrateLegacyChainSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 3 || !Array.isArray(snapshot.chain)
      || !Array.isArray(snapshot.parameters) || !Array.isArray(snapshot.modulation)) return snapshot;
  if (snapshot.chain.some((/** @type {*} */ entry) => !entry || typeof entry.instance !== 'string'
      || typeof entry.operator !== 'string')
      || snapshot.parameters.some((/** @type {*} */ entry) => !entry || typeof entry.name !== 'string'
        || typeof entry.value !== 'number' || !Number.isFinite(Math.fround(entry.value)))
      || snapshot.modulation.some((/** @type {*} */ entry) => !entry || typeof entry.instance !== 'string')) return snapshot;
  if (new Set(snapshot.parameters.map((/** @type {*} */ entry) => entry.name)).size
      !== snapshot.parameters.length) return snapshot;
  const result = structuredClone(snapshot);
  const used = new Set(result.chain.map((/** @type {*} */ entry) => entry.instance));
  if (result.parameters.some((/** @type {*} */ parameter) =>
    !used.has(parameter.name.slice(0, parameter.name.indexOf('.'))))) return snapshot;
  if (result.runtime !== undefined && (!Array.isArray(result.runtime)
      || result.runtime.some((/** @type {*} */ entry) => !entry || !used.has(entry.instance)))) return snapshot;
  /** @param {string} stem @returns {string} */
  const label = (stem) => {
    let next = stem;
    for (let index = 2; used.has(next); index += 1) next = `${stem}-${index}`;
    used.add(next);
    return next;
  };
  const recipes = new Map(result.modulation.map((/** @type {*} */ entry) => [entry.instance, entry.recipe]));
  if (recipes.size !== result.modulation.length) return snapshot;
  /** @param {boolean} enabled @param {number} amount @returns {*} */
  const displacement = (enabled, amount) => {
    const sine = () => ({axis: [0, 1, 0], frequency: 1, offset: 0, speed: 0});
    const pair = () => ({...sine(), axisB: [1, 0, 0], frequencyB: 1, offsetB: 0});
    return {enabled, source: 4, version: 1, evaluation: 0, seed: 6047,
      noise: {scale: 1, speed: 0, contrast: 0, basis: 0, variant: 0},
      sine: sine(), interference: pair(), grid: pair(), mechanic: {kind: 0, amount}};
  };
  const chain = [];
  const modulation = [];
  const runtime = [];
  const removed = new Set();
  for (const entry of result.chain) {
    const color = entry.operator === 'colorize.generated-palette.v3';
    const field = entry.operator === 'modulate.field.v1';
    const hue = entry.operator === 'modulate.hue-shift.v1';
    const clocks = result.runtime?.filter((/** @type {*} */ clock) => clock.instance === entry.instance) ?? [];
    if (!color && !field && !hue) {
      chain.push(entry);
      runtime.push(...clocks);
      continue;
    }
    const parameters = result.parameters.filter((/** @type {*} */ parameter) => parameter.name.startsWith(`${entry.instance}.`));
    const fields = new Map(parameters.map((/** @type {*} */ parameter) =>
      [parameter.name.slice(entry.instance.length + 1), Math.fround(parameter.value)]));
    const mode = fields.get('hue-shift-mode') ?? (hue ? 1 : 0);
    const amount = fields.get('hue-shift-amount') ?? 0;
    if ((color || hue) && (![0, 1].includes(mode) || amount < -4 || amount > 4)) return snapshot;
    if (field && parameters.length > 0) return snapshot;
    if (hue && (parameters.some((/** @type {*} */ parameter) =>
      !['hue-shift-mode', 'hue-shift-amount'].includes(parameter.name.slice(entry.instance.length + 1)))
      || clocks.length > 0 || recipes.has(entry.instance))) return snapshot;
    if (color || field) {
      const recipe = recipes.get(entry.instance);
      if (!recipe || !Number.isInteger(recipe.source) || recipe.source < 0 || recipe.source > 3) return snapshot;
      if (result.runtime !== undefined && (clocks.length !== 1 || clocks[0].kind !== 'color-clock-v2'
          || !clocks[0].state || !clocks[0].state.modulation
          || typeof clocks[0].state.oscillationPhase !== 'number'
          || !Number.isFinite(Math.fround(clocks[0].state.oscillationPhase))
          || !Number.isInteger(clocks[0].state.modulation.source)
          || clocks[0].state.modulation.source < 0 || clocks[0].state.modulation.source > 3)) return snapshot;
      const path = color ? label('displacement') : null;
      const spatial = color ? label('modulation') : entry.instance;
      if (color) {
        chain.push({...entry, operator: 'colorize.generated-palette.v4'},
          {instance: path, operator: 'color.modulate.v1'});
        modulation.push({instance: path, recipe: displacement(mode === 1, amount)});
        if (result.runtime !== undefined) runtime.push({...clocks[0], kind: 'color-clock-v3',
          state: {oscillationPhase: clocks[0].state.oscillationPhase}},
        {instance: path, kind: 'modulation-clock-v1',
          state: {source: 4, version: 1, phaseTurns: 0, initialized: true}});
      }
      chain.push({instance: spatial, operator: 'color.modulate.v1'});
      modulation.push({instance: spatial, recipe});
      if (result.runtime !== undefined) runtime.push({instance: spatial,
        kind: 'modulation-clock-v1', state: clocks[0].state.modulation});
      recipes.delete(entry.instance);
    } else {
      chain.push({instance: entry.instance, operator: 'color.modulate.v1'});
      modulation.push({instance: entry.instance, recipe: displacement(mode === 1, amount)});
      if (result.runtime !== undefined) runtime.push({instance: entry.instance, kind: 'modulation-clock-v1',
        state: {source: 4, version: 1, phaseTurns: 0, initialized: true}});
    }
    for (const parameter of parameters)
      if (hue || ['hue-shift-mode', 'hue-shift-amount'].includes(parameter.name.slice(entry.instance.length + 1)))
        removed.add(parameter.name);
  }
  if (recipes.size > 0) return snapshot;
  return {...result, schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION, chain, modulation,
    parameters: result.parameters.filter((/** @type {*} */ parameter) => !removed.has(parameter.name)),
    ...(result.runtime === undefined ? {} : {runtime})};
}

/** @param {*} value @returns {*} */
function normalizedState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.document === null || typeof value.document !== 'object'
      || Array.isArray(value.document) || typeof value.preset !== 'string'
      || value.preset.length === 0 || !Array.isArray(value.bypassed)
      || value.bypassed.length > (value.document.descriptor?.chain?.length ?? 0)
      || value.bypassed.some((/** @type {*} */ label) => typeof label !== 'string')
      || new Set(value.bypassed).size !== value.bypassed.length
      || typeof value.paused !== 'boolean') {
    throw new Error('invalid shader link state');
  }
  const snapshot = migrateLegacyChainSnapshot(value.chainSnapshot);
  if (snapshot !== undefined
      && (!snapshot || typeof snapshot !== 'object'
        || snapshot.schemaVersion !== CHAIN_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.chain)
        || !Array.isArray(snapshot.parameters)
        || !Array.isArray(snapshot.modulation)
        || snapshot.modulation.some((/** @type {*} */ entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
        || snapshot.chain.some((/** @type {*} */ entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
        || snapshot.parameters.some((/** @type {*} */ entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string')))
    throw new Error('invalid shader link snapshot');
  return {
    document: value.document,
    preset: value.preset,
    bypassed: [...value.bypassed],
    paused: value.paused,
    ...(snapshot === undefined ? {} : {chainSnapshot: snapshot}),
  };
}

/** @param {Uint8Array} bytes @returns {string} */
function base64Url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @param {string} encoded @returns {Uint8Array} */
function base64UrlBytes(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid shader link payload');
  const standard = encoded.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** @param {ReadableStream<Uint8Array>} stream @param {number} limit */
async function readBytes(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error('shader link state is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** @param {Uint8Array} bytes @param {'compress'|'decompress'} operation */
async function transform(bytes, operation) {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const stream = new Blob([input]).stream().pipeThrough(operation === 'compress'
    ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return readBytes(stream, MAX_STATE_BYTES);
}

/**
 * Encodes complete authoring state as a compressed versioned hash.
 * @param {*} state - Document, preset, bypasses, pause and optional runtime snapshot.
 * @returns {Promise<string>} The shader hash.
 * @throws {Error} If state is invalid or its encoded size exceeds the link limits.
 */
export async function encodeShaderStateHash(state) {
  const value = normalizedState(state);
  const compact = {
    d: value.document,
    p: value.preset,
    b: value.bypassed,
    a: value.paused,
    ...(value.chainSnapshot === undefined ? {} : {s: value.chainSnapshot}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  if (bytes.length > MAX_STATE_BYTES) throw new Error('shader link state is too large');
  const compressed = await transform(bytes, 'compress');
  const payload = base64Url(compressed);
  if (payload.length > MAX_PAYLOAD_CHARS) throw new Error('shader link is too large');
  return `${PREFIX}${payload}`;
}

/**
 * Decodes a shader hash and validates its authoring-state shape.
 * @param {string} hash - The URL fragment.
 * @returns {Promise<*|null>} Authoring state, or null for an unrelated fragment.
 * @throws {Error} For an unsupported shader version, invalid payload/state or oversized state.
 */
export async function decodeShaderStateHash(hash) {
  if (!hash.startsWith(PREFIX)) {
    if (hash.startsWith('#shader=')) throw new Error('unsupported shader link version');
    return null;
  }
  const payload = hash.slice(PREFIX.length);
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS)
    throw new Error('invalid shader link payload');
  let compact;
  try {
    const bytes = await transform(base64UrlBytes(payload), 'decompress');
    const { parseShaderDocument, DEFAULT_LIMITS } =
      await import(COMPILER_URL);
    compact = parseShaderDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
      bytes: MAX_STATE_BYTES,
      depth: DEFAULT_LIMITS.depth + 1,
      stringLength: MAX_STATE_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'shader link state is too large')
      throw error;
    throw new Error('invalid shader link payload', { cause: error });
  }
  return normalizedState({
    document: compact?.d,
    preset: compact?.p,
    bypassed: compact?.b,
    paused: compact?.a,
    ...(compact?.s === undefined ? {} : {chainSnapshot: compact.s}),
  });
}

/**
 * Replaces the current shader fragment while preserving path and query.
 * @param {string} hash - The encoded shader fragment.
 * @param {*} [win] - Browser location and history host.
 * @returns {boolean} Whether the URL was replaced; false when history is unavailable or refuses.
 */
export function replaceShaderStateHash(hash, win = globalThis) {
  if (!win.location || !win.history?.replaceState) return false;
  const path = `${win.location.pathname}${win.location.search}${hash}`;
  return replaceUrl(path, win);
}
