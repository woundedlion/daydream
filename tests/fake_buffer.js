/**
 * @param {number} [bytes] - Buffer size before detachment.
 * @returns {Uint16Array} A view whose backing buffer has been transferred away.
 */
export function detachedView(bytes = 8) {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint16Array(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  return view;
}
