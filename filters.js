// filters.js
import * as THREE from "three";
import { Daydream, pixelKey, keyPixel } from "./driver.js";
import { pixelToSpherical, sphericalToPixel, squareWave } from "./geometry.js";
import { wrap } from "./util.js"
import { blendAlpha } from "./color.js";

export class Filter {
  chain(nextFilter) {
    this.next = nextFilter;
    return nextFilter;
  }

  pass(pixels, x, y, color, age, alpha) {
    if (this.next === undefined) {
      x = Math.round(x);
      y = Math.round(y);
      let key = pixelKey(x, y);
      let old = 0;
      if (pixels.has(key)) {
        old = pixels.get(key);
      } else {
        old = new THREE.Color(0, 0, 0);
      }
      pixels.set(pixelKey(x, y), blendAlpha(alpha)(old, color));
    } else {
      this.next.plot(pixels, x, y, color, age, alpha);
    }
  }
}

export class FilterOrient extends Filter {
  constructor(orientation) {
    super();
    this.orientation = orientation;
  }

  plot(pixels, x, y, color, age, alpha) {
    let v = new THREE.Vector3()
      .setFromSpherical(pixelToSpherical(x, y));
    let r = sphericalToPixel(new THREE.Spherical()
      .setFromVector3(this.orientation.orient(v)));
    this.orientation.collapse();
    this.pass(pixels, r.x, r.y, color, age, alpha);
  }
}

export class FilterRaw extends Filter {
  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, color, age, alpha);
  }
}

export class FilterFn extends Filter {
  constructor(fn) {
    super();
    thi.fn = fn();
  }

  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, color, age, alpha);
  }
}


export class FilterReplicate extends Filter {
  constructor(count) {
    super();
    this.count = count;
  }

  plot(pixels, x, y, color, age, alpha) {
    for (let i = 0; i < Daydream.W; i += Daydream.W / this.count) {
      this.pass(pixels, wrap(x + Math.floor(i), Daydream.W), y, color, age, alpha);
    }
  }
}

export class FilterMirror extends Filter {
  constructor() {
    super();
  }

  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, color, age, alpha);
    this.pass(pixels, Daydream.W - x - 1, Daydream.H - y - 1, color, age, alpha);
  }
}


export const falloff = (c) => {
  return c;
}

export class FilterAntiAlias extends Filter {
  plot(pixels, x, y, color, age, alpha) {
    let xi = Math.trunc(x);
    let xm = x - xi;
    let yi = Math.trunc(y);
    let ym = y - yi;

    let cov = falloff((1 - xm) * (1 - ym));
    if (cov > 0.00001) {
      this.pass(pixels, xi, yi, color, age, cov * alpha);
    }
    cov = falloff(xm * (1 - ym));
    if (cov > 0.00001) {
      this.pass(pixels, wrap((xi + 1), Daydream.W), yi, color, age, cov * alpha);
    }

    if (yi < Daydream.H - 1) {
      cov = falloff((1 - xm) * ym);
      if (cov > 0.00001) {
        this.pass(pixels, xi, yi + 1, color, age, cov * alpha);
      }

      cov = falloff(xm * ym);
      if (cov > 0.00001) {
        this.pass(pixels, wrap((xi + 1), Daydream.W), yi + 1, color, age, cov * alpha);
      }
    }
  }
}

export class FilterSinDisplace extends Filter {
  constructor(phase, amplitudeFn, freqFn, phaseSpeedFn) {
    super();
    this.amplitudeFn = amplitudeFn;
    this.freqFn = freqFn;
    this.phaseSpeedFn = phaseSpeedFn;
    this.phase = phase;
    this.t = 0;
  }

  shift() {
    ++this.t;
    this.phase += this.phaseSpeedFn(this.t);
  }

  plot(pixels, x, y, color, age, alpha) {
    let dx = wrap(
      x + this.amplitudeFn(this.t) * Math.sin(
        this.freqFn(this.t) * (((y / (Daydream.H - 1)) * 2 * Math.PI) + this.phase)
      ), Daydream.W);
    this.pass(pixels, dx, y, color, age, alpha);
  }
}

export class FilterChromaticShift extends Filter {
  constructor(magnitudeFn) {
    super();
    this.magnitudeFn = magnitudeFn;
    this.t = 0;
  }

  plot(pixels, x, y, color, age, alpha) {
    let r = new THREE.Color(color.r, 0, 0);
    let g = new THREE.Color(0, color.g, 0);
    let b = new THREE.Color(0, 0, color.b);
    this.pass(pixels, x, y, color, age, alpha);
    this.pass(pixels, wrap(x + 1, Daydream.W), y, r, age, alpha);
    this.pass(pixels, wrap(x + 2, Daydream.W), y, g, age, alpha);
    this.pass(pixels, wrap(x + 3, Daydream.W), y, b, age, alpha);

  }
}

export class FilterColorShift extends Filter {
  constructor(colorShiftFn) {
    super();
    this.colorShiftFn = colorShiftFn;
    this.t = 0;
  }

  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, this.colorShiftFn(x, y, color), age, alpha);
  }
}

export function hashInt(n) {
  // Force to 32-bit integer for consistent behavior
  n = n | 0;

  // Mixing operations (variant of MurmurHash3 finalizer)
  n = ((n >> 16) ^ n) * 0x45d9f3b;
  n = ((n >> 16) ^ n) * 0x45d9f3b;
  n = ((n >> 16) ^ n);
  return n;
}

export class FilterTwinkle extends Filter {
  constructor(amplitude, freq) {
    super();
    this.amplitude = amplitude;
    this.freq = freq;
    this.t = 0;
  }

  twinkle() {
    ++this.t;
  }

  randomPhase(x, y) {
    // 1. Combine the two integers into a single hash input (32-bit integer mix)
    // We start with x, and then mix in y using bitwise operations and a multiplier (like 31 or 17).
    let combined = (x | 0); // Start with x

    // A simple, effective combination is using multiplication and XOR.
    // 0x9e3779b9 is a standard magic number (the golden ratio base in 32-bit) used for mixing.
    combined = (combined ^ (y | 0) + 0x9e3779b9 + (combined << 6) + (combined >> 2));

    // 2. Hash the combined 32-bit integer
    const hashedInt = hashInt(combined);

    // 3. Convert to a number in the range [0, 1)
    // The >>> 0 converts the signed 32-bit integer to an unsigned 32-bit integer [0, 2^32 - 1].
    const unsignedInt = hashedInt >>> 0;

    // Divide by 2^32 (4294967296.0) to normalize to [0, 1)
    const normalizedValue = unsignedInt / 4294967296.0;

    // 4. Scale to the desired range [0, 2 * PI)
    return normalizedValue * 2 * Math.PI;
  }

  plot(pixels, x, y, color, age, alpha) {
    let m = this.amplitude * Math.sin(
      this.randomPhase(x, y) + Math.sin((this.freq * this.t))
    ) + this.amplitude;
    let c = color;
    c.multiplyScalar(m);
    this.pass(pixels, x, y, c, age, alpha);
  }
}


export class FilterDecayTrails extends Filter {
  constructor(lifespan) {
    super();
    this.lifespan = lifespan;
    this.trails = new Map();
  }

  plot(pixels, x, y, color, age, alpha) {
    if (age >= 0) {
      let key = pixelKey(x, y);
      this.trails.set(key, Math.max(0, this.lifespan - age));
    }
    if (age <= 0) {
      this.pass(pixels, x, y, color, age, alpha);
    }
  }

  decay() {
    this.trails.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl <= 0) {
        this.trails.delete(key);
      } else {
        this.trails.set(key, ttl);
      }
    });
  }

  trail(pixels, trailFn, alpha) {
    for (const [key, ttl] of this.trails) {
      if (ttl > 0) {
        let p = keyPixel(key);
        let color = trailFn(p[0], p[1], 1 - (ttl / this.lifespan));
        //       labels.push({ position: pixelToVector(p[0], p[1]), content: `${parseFloat(p[0]).toFixed(1)}, ${parseFloat(p[1]).toFixed(1)}` });
        this.pass(pixels, p[0], p[1], color, this.lifespan - ttl, alpha);
      }
    }
  }
}
