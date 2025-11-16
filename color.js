// color.js
import * as THREE from "three";
import { G } from "./geometry.js";

export const blendMax = (c1, c2) => {
  return new THREE.Color(
    Math.max(c1.r, c2.r),
    Math.max(c1.g, c2.g),
    Math.max(c1.b, c2.b)
  );
}

export const blendOver = (c1, c2) => {
  return c2;
}

export const blendUnder = (c1, c2) => {
  return c1;
}

export const blendAdd = (c1, c2) => {
  return new THREE.Color(
    Math.min(1, c1.r + c2.r),
    Math.min(1, c1.g + c2.g),
    Math.min(1, c1.b + c2.b)
  );
}

export const blendAlpha = (a) => {
  return (c1, c2) => {
    return new THREE.Color(
      c1.r * (1 - a) + c2.r * (a),
      c1.g * (1 - a) + c2.g * (a),
      c1.b * (1 - a) + c2.b * (a)
    );
  }
}

export const blendAccumulate = (a) => {
  return (c1, c2) => {
    // c1: existing pixel color, c2: incoming fragment color
    // Formula: C_result = C_existing + C_fragment * coverage (a)
    return new THREE.Color(
      Math.min(1, c1.r + c2.r * a),
      Math.min(1, c1.g + c2.g * a),
      Math.min(1, c1.b + c2.b * a)
    );
  }
}

export const blendOverMax = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  if (m2 == 0) {
    return c1;
  }
  let s = Math.max(m1, m2) / m2;
  return new THREE.Color(
    c2.r * s,
    c2.g * s,
    c2.b * s
  );
}

export const blendOverMin = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  let s = 0;
  if (m2 > 0) {
    s = Math.min(m1, m2) / m2;
  }
  return new THREE.Color(
    c2.r * s,
    c2.g * s,
    c2.b * s
  );
}

export const blendMean = (c1, c2) => {
  return new THREE.Color(
    (c1.r + c2.r) / 2,
    (c1.g + c2.g) / 2,
    (c1.b + c2.b) / 2
  );
}

///////////////////////////////////////////////////////////////////////////////

export class Gradient {
  constructor(size, points) {
    let lastPoint = [0, 0x000000];
    this.colors = points.reduce((r, nextPoint) => {
      let s = Math.floor(nextPoint[0] * size) - Math.floor(lastPoint[0] * size);
      for (let i = 0; i < s; i++) {
        r.push(new THREE.Color(lastPoint[1]).lerp(
          new THREE.Color(nextPoint[1]),
          i / s));
      }
      lastPoint = nextPoint;
      return r;
    }, []);
  }

  get(a) {
    return this.colors[Math.floor(a * (this.colors.length - 1))].clone().convertSRGBToLinear();
  }
};

export function randomBetween(a, b) {
  return Math.random() * (b - a) + a;
}

export const hsvToHsl = (h, s, v) => {
  const l = v * (1 - s / 2);
  const s_hsl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, s_hsl, l];
}

export class reversePalette {
  constructor(palette) {
    this.palette = palette;
  }

  get(t) {
    return this.palette.get(1 - t);
  }
}

export class GenerativePalette {
  static seed = Math.random();

  static calcHues(baseHue, type) {
    let hA = baseHue;
    let hB, hC;
    const normalize = (h) => (h % 1 + 1) % 1;

    switch (type) {
      case 'triadic':
        // Three equidistant hues (120 degrees apart, or 1/3 of the wheel)
        hB = normalize(hA + 1 / 3);
        hC = normalize(hA + 2 / 3);
        break;

      case 'split-complementary':
        // HueA, and two hues adjacent to its complement
        const complement = normalize(hA + 0.5);
        // Offset by 1/12 (30 degrees)
        hB = normalize(complement - 1 / 12);
        hC = normalize(complement + 1 / 12);
        break;

      case 'complementary':
        // HueA and its direct opposite (hA, complement, a slight variant of hA)
        hB = normalize(hA + 0.5);
        // Introduce a subtle third hue for the blend, slightly offset from hA
        hC = normalize(hA + randomBetween(-1 / 36, 1 / 36));
        break;

      case 'analogous':
      default:
        // Analogous (Current behavior: closely spaced hues)
        let dir = Math.random() < 0.5 ? 1 : -1;
        hB = normalize(hA + dir * randomBetween(1 / 6, 3 / 12));
        hC = normalize(hB + dir * randomBetween(1 / 6, 3 / 12));
        break;
    }

    return [hA, hB, hC];
  }

  constructor(shape = 'straight', harmonyType = 'analagous', brightnessProfile = 'ascending') {
    this.shapeSpec = shape;
    this.harmonyType = harmonyType;

    let hueA = GenerativePalette.seed;
    GenerativePalette.seed = (GenerativePalette.seed + G) % 1;
    const [hA, hB, hC] = GenerativePalette.calcHues(hueA, harmonyType);

    let sat1 = randomBetween(0.4, 0.8);
    let sat2 = randomBetween(0.4, 0.8);
    let sat3 = randomBetween(0.4, 0.8);

    let v1, v2, v3;
    switch (brightnessProfile) {
      case 'ascending':
        v1 = randomBetween(0.1, 0.3);
        v2 = randomBetween(0.5, 0.7);
        v3 = randomBetween(0.8, 1.0);
        break;
      case 'descending':
        v1 = randomBetween(0.8, 1.0);
        v2 = randomBetween(0.5, 0.7);
        v3 = randomBetween(0.1, 0.3);
        break;
      case 'flat':
        v1 = 1.0;
        v2 = 1.0;
        v3 = 1.0;
        break;
      case 'bell':
        v1 = randomBetween(0.2, 0.5);
        v2 = randomBetween(0.7, 1.0);
        v3 = v1;
        break;
    }

    this.a = new THREE.Color().setHSL(...hsvToHsl(hA, sat1, v1));
    this.b = new THREE.Color().setHSL(...hsvToHsl(hB, sat2, v2));
    this.c = new THREE.Color().setHSL(...hsvToHsl(hC, sat3, v3));
  }

  get(t) {
    let colors;
    let shape;
    const vignetteColor = new THREE.Color(0, 0, 0);
    switch (this.shapeSpec) {
      case 'vignette':
        shape = [0, 0.1, 0.5, 0.9, 1];
        colors = [vignetteColor, this.a, this.b, this.c, vignetteColor];
        break;
      case 'straight':
        shape = [0, 0.5, 1];
        colors = [this.a, this.b, this.c];
        break;
      case 'circular':
        shape = [0, 0.33, 0.66, 1];
        colors = [this.a, this.b, this.c, this.a];
        break;
      case 'faloff':
        shape = [0, 0.33, 0.66, 0.9, 1];
        colors = [this.a, this.b, this.c, vignetteColor];
        break;
    }

    let segIndex = -1;
    for (let i = 0; i < shape.length - 1; i++) {
      if (t >= shape[i] && t < shape[i + 1]) {
        segIndex = i;
        break;
      }
    }
    if (segIndex < 0) {
      segIndex = shape[shape.length - 1];
    }

    const start = shape[segIndex];
    const end = shape[segIndex + 1];
    const c1 = colors[segIndex];
    const c2 = colors[segIndex + 1];

    return new THREE.Color().lerpColors(c1, c2, (t - start) / (end - start)).convertSRGBToLinear();
  }
}

export class ProceduralPalette {
  constructor(a, b, c, d) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }

  get(t) {
    return new THREE.Color(
      this.a[0] + this.b[0] * Math.cos(2 * Math.PI * (this.c[0] * t + this.d[0])),
      this.a[1] + this.b[1] * Math.cos(2 * Math.PI * (this.c[1] * t + this.d[1])),
      this.a[2] + this.b[2] * Math.cos(2 * Math.PI * (this.c[2] * t + this.d[2]))
    ).convertSRGBToLinear();
  }
};

export class MutatingPalette {
  constructor(a1, b1, c1, d1, a2, b2, c2, d2) {
    this.a1 = new THREE.Vector3(a1[0], a1[1], a1[2]);
    this.b1 = new THREE.Vector3(b1[0], b1[1], b1[2]);
    this.c1 = new THREE.Vector3(c1[0], c1[1], c1[2]);
    this.d1 = new THREE.Vector3(d1[0], d1[1], d1[2]);
    this.a2 = new THREE.Vector3(a2[0], a2[1], a2[2]);
    this.b2 = new THREE.Vector3(b2[0], b2[1], b2[2]);
    this.c2 = new THREE.Vector3(c2[0], c2[1], c2[2]);
    this.d2 = new THREE.Vector3(d2[0], d2[1], d2[2]);
    this.mutate(0);
  }

  mutate(t) {
    this.a = new THREE.Vector3().lerpVectors(this.a1, this.a2, t);
    this.b = new THREE.Vector3().lerpVectors(this.b1, this.b2, t);
    this.c = new THREE.Vector3().lerpVectors(this.c1, this.c2, t);
    this.d = new THREE.Vector3().lerpVectors(this.d1, this.d2, t);
  }

  get(p) {
    // a + b * cos(2 * PI * (c * t + d));
    return new THREE.Color(
      this.a.x + this.b.x * Math.cos(2 * Math.PI * (this.c.x * p + this.d.x)),
      this.a.y + this.b.y * Math.cos(2 * Math.PI * (this.c.y * p + this.d.y)),
      this.a.z + this.b.z * Math.cos(2 * Math.PI * (this.c.z * p + this.d.z))
    ).convertSRGBToLinear();
  }
}

export let rainbow = new Gradient(256, [
  [0, 0xFF0000],
  [1 / 16, 0xD52A00],
  [2 / 16, 0xAB5500],
  [3 / 16, 0xAB7F00],
  [4 / 16, 0xABAB00],
  [5 / 16, 0x56D500],
  [6 / 16, 0x00FF00],
  [7 / 16, 0x00D52A],
  [8 / 16, 0x00AB55],
  [9 / 16, 0x0056AA],
  [10 / 16, 0x0000FF],
  [11 / 16, 0x2A00D5],
  [12 / 16, 0x5500AB],
  [13 / 16, 0x7F0081],
  [14 / 16, 0xAB0055],
  [15 / 16, 0xD5002B],
  [16 / 16, 0xD5002B]
]);

export let rainbowStripes = new Gradient(256, [
  [0, 0xFF0000],
  [1 / 16, 0x000000],
  [2 / 16, 0xAB5500],
  [3 / 16, 0x000000],
  [4 / 16, 0xABAB00],
  [5 / 16, 0x000000],
  [6 / 16, 0x00FF00],
  [7 / 16, 0x000000],
  [8 / 16, 0x00AB55],
  [9 / 16, 0x000000],
  [10 / 16, 0x0000FF],
  [11 / 16, 0x000000],
  [12 / 16, 0x5500AB],
  [13 / 16, 0x000000],
  [14 / 16, 0xAB0055],
  [15 / 16, 0x000000],
  [16 / 16, 0xFF0000]
]);

export let rainbowThinStripes = new Gradient(256, [
  [0, 0xFF0000], //
  [1 / 32, 0x000000],
  [3 / 32, 0x000000],
  [4 / 32, 0xAB5500], //
  [5 / 32, 0x000000],
  [7 / 32, 0x000000],
  [8 / 32, 0xABAB00], //
  [9 / 32, 0x000000],
  [11 / 32, 0x000000],
  [12 / 32, 0x00FF00], //
  [13 / 32, 0x000000],
  [15 / 32, 0x000000],
  [16 / 32, 0x00AB55], //
  [17 / 32, 0x000000],
  [19 / 32, 0x000000],
  [20 / 32, 0x0000FF], //
  [21 / 32, 0x000000],
  [23 / 32, 0x000000],
  [24 / 32, 0x5500AB], //
  [25 / 32, 0x000000],
  [27 / 32, 0x000000],
  [28 / 32, 0xAB0055], //
  [29 / 32, 0x000000],
  [32 / 32, 0x000000] //
]);

export let grayToBlack = new Gradient(16384, [
  [0, 0x888888],
  [1, 0x000000]
]);

export let blueToBlack = new Gradient(256, [
  [0, 0xee00ee],
  [1, 0x000000]
]);

export let g1 = new Gradient(256, [
  [0, 0xffaa00],
  [1, 0xff0000],
]);

export let g2 = new Gradient(256, [
  [0, 0x0000ff],
  [1, 0x660099],
]);

export let g3 = new Gradient(256, [
  //  [0, 0xaaaaaa],
  [0, 0xffff00],
  [0.3, 0xfc7200],
  [0.8, 0x06042f],
  [1, 0x000000]
]);

export let g4 = new Gradient(256, [
  //  [0, 0xaaaaaa],
  [0, 0x0000ff],
  [1, 0x000000]
]);

///////////////////////////////////////////////////////////////////////////////

export function vignette(palette) {
  let vignetteColor = new THREE.Color(0, 0, 0);
  return (t) => {
    if (t < 0.2) {
      return new THREE.Color().lerpColors(vignetteColor, palette.get(0), t / 0.2);
    } else if (t >= 0.8) {
      return new THREE.Color().lerpColors(palette.get(1), vignetteColor, (t - 0.8) / 0.2);
    } else {
      return palette.get((t - 0.2) / 0.6);
    }
  };
}


export const darkRainbow = new ProceduralPalette(
  [0.367, 0.367, 0.367], // A
  [0.500, 0.500, 0.500], // B
  [1.000, 1.000, 1.000], // C
  [0.000, 0.330, 0.670]  // D
);

export const emeraldForest = new Gradient(16384, [
  [0.0, 0x004E64],
  [0.2, 0x0B6E4F],
  [0.4, 0x08A045],
  [0.6, 0x6BBF59],
  [0.8, 0x138086],
  //  [0.8, 0xEB9C35],
  [1, 0x000000]
]);

export const bloodStream = new ProceduralPalette(
  [0.169, 0.169, 0.169], // A
  [0.313, 0.313, 0.313], // B
  [0.231, 0.231, 0.231], // C
  [0.036, 0.366, 0.706]  // D
);

export const vintageSunset = new ProceduralPalette(
  [0.256, 0.256, 0.256], // A
  [0.500, 0.080, 0.500], // B
  [0.277, 0.277, 0.277], // C
  [0.000, 0.330, 0.670]  // D
);

export const richSunset = new ProceduralPalette(
  [0.309, 0.500, 0.500], // A
  [1.000, 1.000, 0.500], // B
  [0.149, 0.148, 0.149], // C
  [0.132, 0.222, 0.521]  // D
);

export const underSea = new ProceduralPalette(
  [0.000, 0.000, 0.000], // A
  [0.500, 0.276, 0.423], // B
  [0.296, 0.296, 0.296], // C
  [0.374, 0.941, 0.000]  // D);
);

export const lateSunset = new ProceduralPalette(
  [0.337, 0.500, 0.096], // A
  [0.500, 1.000, 0.176], // B
  [0.261, 0.261, 0.261], // C
  [0.153, 0.483, 0.773]  // D
);

export const mangoPeel = new ProceduralPalette(
  [0.500, 0.500, 0.500], // A
  [0.500, 0.080, 0.500], // B
  [0.431, 0.431, 0.431], // C
  [0.566, 0.896, 0.236]  // D
);

export const iceMelt = new ProceduralPalette(
  [0.500, 0.500, 0.500], // A
  [0.500, 0.500, 0.500], // B
  [0.083, 0.147, 0.082], // C
  [0.579, 0.353, 0.244]  // D
);

export const lemonLime = new ProceduralPalette(
  [0.455, 0.455, 0.455], // A
  [0.571, 0.151, 0.571], // B
  [0.320, 0.320, 0.320], // C
  [0.087, 0.979, 0.319]  // D
);

export const algae = new ProceduralPalette(
  [0.210, 0.210, 0.210], // A
  [0.500, 1.000, 0.021], // B
  [0.086, 0.086, 0.075], // C
  [0.419, 0.213, 0.436]  // D
);

export const embers = new ProceduralPalette(
  [0.500, 0.500, 0.500], // A
  [0.500, 0.500, 0.500], // B
  [0.265, 0.285, 0.198], // C
  [0.577, 0.440, 0.358]  // D
);
export const paletteFalloff = function (color, size, t) {
  if (t >= (1 - size)) {
    t = (t - (1 - size)) / size;
    return color.clone().lerpColors(color, new THREE.Color(0, 0, 0), t);
  }
  return color;
}