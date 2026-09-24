/**
 * Recording stand-in for a CanvasRenderingContext2D. Every drawing call lands in
 * `ops` in order, and every state assignment is a plain property.
 * @returns {Object} The context double.
 */
export function fakeContext() {
  const ops = [];
  return {
    ops,
    rasters: 0,
    canvasFor: null,
    clearRect: (...a) => ops.push(['clearRect', ...a]),
    setLineDash: (a) => ops.push(['setLineDash', a.join(',')]),
    drawImage: (...a) => ops.push(['drawImage', ...a]),
    createImageData(width, height) {
      this.rasters++;
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData: function putImageData(image) { this.painted = image; },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...a) => ops.push(['moveTo', ...a]),
    lineTo: (...a) => ops.push(['lineTo', ...a]),
    arc: (...a) => ops.push(['arc', ...a]),
    fill: function fill() { ops.push(['fill', this.fillStyle]); },
    stroke: function stroke() { ops.push(['stroke', this.strokeStyle, this.lineWidth]); },
    fillRect: (...a) => ops.push(['fillRect', ...a]),
    strokeRect: (...a) => ops.push(['strokeRect', ...a]),
    fillText: (...a) => ops.push(['fillText', ...a]),
  };
}
