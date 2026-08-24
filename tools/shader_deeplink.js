/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// @ts-check

const PREFIX = '#shader=v1.';
const MAX_PAYLOAD_CHARS = 65536;
const MAX_STATE_BYTES = 524288;

/** @param {*} value @returns {*} */
function normalizedState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.document === null || typeof value.document !== 'object'
      || Array.isArray(value.document) || typeof value.preset !== 'string'
      || value.preset.length === 0 || !Array.isArray(value.bypassed)
      || value.bypassed.length > 32
      || value.bypassed.some((/** @type {*} */ label) => typeof label !== 'string')
      || new Set(value.bypassed).size !== value.bypassed.length
      || typeof value.paused !== 'boolean') {
    throw new Error('invalid shader link state');
  }
  return {
    document: value.document,
    preset: value.preset,
    bypassed: [...value.bypassed],
    paused: value.paused,
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

/** @param {*} state @returns {Promise<string>} */
export async function encodeShaderStateHash(state) {
  const value = normalizedState(state);
  const compact = {
    d: value.document,
    p: value.preset,
    b: value.bypassed,
    a: value.paused,
  };
  const compressed = await transform(
    new TextEncoder().encode(JSON.stringify(compact)), 'compress');
  const payload = base64Url(compressed);
  if (payload.length > MAX_PAYLOAD_CHARS) throw new Error('shader link is too large');
  return `${PREFIX}${payload}`;
}

/** @param {string} hash @returns {Promise<*|null>} */
export async function decodeShaderStateHash(hash) {
  if (!hash.startsWith(PREFIX)) return null;
  const payload = hash.slice(PREFIX.length);
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS)
    throw new Error('invalid shader link payload');
  let compact;
  try {
    const bytes = await transform(base64UrlBytes(payload), 'decompress');
    compact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
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
  });
}

/** @param {string} hash @param {*} [win] */
export function replaceShaderStateHash(hash, win = globalThis) {
  if (!win.location || !win.history?.replaceState) return false;
  const path = `${win.location.pathname}${win.location.search}${hash}`;
  win.history.replaceState({}, '', path);
  return true;
}
