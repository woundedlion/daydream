// noise.js
///////////////////////////////////////////////////////////////////////////////

/**
 * Efficient PerlinNoise1D Class
 * Generates 1D Perlin Noise optimized for speed.
 * The core concept remains: smooth interpolation between random gradients.
 */
export class PerlinNoise1D {
  constructor() {
    // --- Initialization ---

    // The permutation table (0-255). This defines the "random" hash lookup.
    // It's duplicated (0-511) to avoid explicit modulo operations in the noise function.
    this.p = new Array(512);
    this.perm = new Array(256);

    // 1. Fill the permutation array with unique random values (0 to 255)
    for (let i = 0; i < 256; i++) {
      this.perm[i] = i;
    }

    // 2. Shuffle the array using the Fisher-Yates algorithm for true randomness
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.perm[i], this.perm[j]] = [this.perm[j], this.perm[i]];
    }

    // 3. Duplicate the array for faster lookups (index & 255 is avoided)
    for (let i = 0; i < 256; i++) {
      this.p[i] = this.perm[i];
      this.p[i + 256] = this.perm[i];
    }

    // 1D gradients are simply -1 or 1, encoded here as array indices
    this.gradients = [1, -1];
  }

  /**
   * The Perlin smootherstep function: 6t^5 - 15t^4 + 10t^3.
   * Guarantees zero derivative at t=0 and t=1 for smooth transitions.
   * @param {number} t - The fractional part of the coordinate [0, 1].
   */
  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * Standard Linear Interpolation.
   */
  lerp(a, b, t) {
    return a + t * (b - a);
  }

  /**
   * Calculates the dot product of the distance vector and the gradient vector.
   * In 1D, this is just grad * distance.
   * @param {number} hash - The hash value from the permutation table.
   * @param {number} x - The distance from the grid point (e.g., x or x-1).
   */
  grad(hash, x) {
    // Using hash & 1 is a fast way to get hash % 2
    // If hash is even, index 0 (+1); if odd, index 1 (-1).
    const grad = this.gradients[hash & 1];
    return grad * x;
  }

  /**
   * The main 1D Perlin Noise calculation.
   * @param {number} x - The input coordinate (position or time).
   * @returns {number} The noise value in the range [-1, 1].
   */
  noise(x) {
    // 1. Find the integer unit grid cell (X) and the fractional part (x_frac)
    let X = Math.floor(x);
    const x_frac = x - X;

    // Use bitwise AND to wrap X around 255, minimizing lookups
    X = X & 255;

    // 2. Compute the fade curve for the fractional part
    const u = this.fade(x_frac);

    // 3. Calculate hash values (A and B) for the two endpoints (X and X+1)
    // Since P is 512 long, we can use X+1 directly without a boundary check.
    const A = this.p[X];
    const B = this.p[X + 1];

    // 4. Calculate the influence (dot product) from the two endpoint gradients
    const res0 = this.grad(A, x_frac);     // Influence from the left grid point (distance x_frac)
    const res1 = this.grad(B, x_frac - 1); // Influence from the right grid point (distance x_frac - 1)

    // 5. Interpolate the results
    return this.lerp(res0, res1, u);
  }
}

/**
 * Efficient PerlinNoise3D Class
 * Generates 3D Perlin Noise, following the same efficient hashing
 * structure as the provided PerllinNoise1D class.
 */
export class PerlinNoise3D {
  constructor() {
    // --- Initialization ---

    // The permutation table (0-255).
    // This is identical to your PerlinNoise1D setup.
    this.p = new Array(512);
    this.perm = new Array(256);

    // 1. Fill the permutation array with unique random values (0 to 255)
    for (let i = 0; i < 256; i++) {
      this.perm[i] = i;
    }

    // 2. Shuffle the array using the Fisher-Yates algorithm
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.perm[i], this.perm[j]] = [this.perm[j], this.perm[i]];
    }

    // 3. Duplicate the array to avoid modulo operations
    for (let i = 0; i < 256; i++) {
      this.p[i] = this.perm[i];
      this.p[i + 256] = this.perm[i];
    }
  }

  /**
   * The Perlin smootherstep function: 6t^5 - 15t^4 + 10t^3.
   * Copied directly from your PerlinNoise1D.
   */
  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * Standard Linear Interpolation.
   * Copied directly from your PerlinNoise1D.
   */
  lerp(a, b, t) {
    return a + t * (b - a);
  }

  /**
   * Calculates the 3D gradient dot product.
   * This is the 3D equivalent of your 1D grad function.
   * It's a fast, bitwise implementation from Ken Perlin's "Improved Noise".
   *
   * @param {number} hash - The hash value (0-255).
   * @param {number} x - The fractional distance from the grid point in X.
   * @param {number} y - The fractional distance from the grid point in Y.
   * @param {number} z - The fractional distance from the grid point in Z.
   */
  grad(hash, x, y, z) {
    const h = hash & 15; // Get the 4 low-order bits

    // Use the 4 bits to select one of 12 gradient directions
    // without a lookup table.
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    const w = h < 2 ? z : (h === 10 || h === 12 ? y : x);

    // Use the bits to determine +/- signs
    return ((h & 1) === 0 ? u : -u) +
      ((h & 2) === 0 ? v : -v) +
      ((h & 4) === 0 ? w : -w);
  }

  /**
   * The main 3D Perlin Noise calculation.
   *
   * @param {number} x - The input coordinate (position or time).
   * @param {number} y - The input coordinate.
   * @param {number} z - The input coordinate.
   * @returns {number} The noise value in the range [-1, 1].
   */
  noise(x, y, z) {
    // 1. Find the integer unit grid cell (X,Y,Z)
    let X = Math.floor(x);
    let Y = Math.floor(y);
    let Z = Math.floor(z);

    // Find the fractional part (x_frac, y_frac, z_frac)
    const x_frac = x - X;
    const y_frac = y - Y;
    const z_frac = z - Z;

    // 2. Use bitwise AND to wrap X,Y,Z (just like in 1D)
    X = X & 255;
    Y = Y & 255;
    Z = Z & 255;

    // 3. Compute the fade curves for each fractional part
    const u = this.fade(x_frac);
    const v = this.fade(y_frac);
    const w = this.fade(z_frac);

    // 4. Calculate hash values for the 8 corners of the cube.
    // This is the 3D equivalent of getting A and B in your 1D code.
    // We chain the hashes to get a unique hash for each 3D corner.
    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;

    // 5. Calculate the influence (dot product) from the 8 corner gradients
    // and trilinearly interpolate them.

    // First, lerp along X axis
    const res0 = this.lerp(
      this.grad(this.p[AA], x_frac, y_frac, z_frac),
      this.grad(this.p[BA], x_frac - 1, y_frac, z_frac),
      u
    );
    const res1 = this.lerp(
      this.grad(this.p[AB], x_frac, y_frac - 1, z_frac),
      this.grad(this.p[BB], x_frac - 1, y_frac - 1, z_frac),
      u
    );
    const res2 = this.lerp(
      this.grad(this.p[AA + 1], x_frac, y_frac, z_frac - 1),
      this.grad(this.p[BA + 1], x_frac - 1, y_frac, z_frac - 1),
      u
    );
    const res3 = this.lerp(
      this.grad(this.p[AB + 1], x_frac, y_frac - 1, z_frac - 1),
      this.grad(this.p[BB + 1], x_frac - 1, y_frac - 1, z_frac - 1),
      u
    );

    // Next, lerp the results along Y axis
    const res4 = this.lerp(res0, res1, v);
    const res5 = this.lerp(res2, res3, v);

    // Finally, lerp those results along Z axis
    const result = this.lerp(res4, res5, w);

    return result;
  }
}

/**
 * Efficient PerlinNoise4D Class
 * Generates 4D Perlin Noise, following the same efficient hashing
 * structure as your PerlinNoise1D class.
 */
export class PerlinNoise4D {
  constructor() {
    // --- Initialization (Identical to 1D) ---
    this.p = new Array(512);
    this.perm = new Array(256);
    for (let i = 0; i < 256; i++) {
      this.perm[i] = i;
    }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.perm[i], this.perm[j]] = [this.perm[j], this.perm[i]];
    }
    for (let i = 0; i < 256; i++) {
      this.p[i] = this.perm[i];
      this.p[i + 256] = this.perm[i];
    }
  }

  /**
   * The Perlin smootherstep function: 6t^5 - 15t^4 + 10t^3.
   *
   */
  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * Standard Linear Interpolation.
   *
   */
  lerp(a, b, t) {
    return a + t * (b - a);
  }

  /**
   * Calculates the 4D gradient dot product.
   * Uses the 32 gradient vectors that point from the center
   * of a 4D hypercube to the centers of its 3D "faces".
   */
  grad(hash, x, y, z, w) {
    const h = hash & 31; // Use 5 bits to select one of 32 directions
    const u = h < 24 ? x : y;
    const v = h < 16 ? y : z;
    const t = h < 8 ? z : w;

    // Use the 5 bits to determine +/- signs
    return ((h & 1) === 0 ? u : -u) +
      ((h & 2) === 0 ? v : -v) +
      ((h & 4) === 0 ? t : -t);
  }

  /**
   * The main 4D Perlin Noise calculation.
   */
  noise(x, y, z, w) {
    // 1. Find the integer unit grid cell (X,Y,Z,W)
    let X = Math.floor(x);
    let Y = Math.floor(y);
    let Z = Math.floor(z);
    let W = Math.floor(w);

    // Find the fractional part
    const x_frac = x - X;
    const y_frac = y - Y;
    const z_frac = z - Z;
    const w_frac = w - W;

    // 2. Use bitwise AND to wrap
    X = X & 255;
    Y = Y & 255;
    Z = Z & 255;
    W = W & 255;

    // 3. Compute the fade curves
    const u = this.fade(x_frac);
    const v = this.fade(y_frac);
    const s = this.fade(z_frac);
    const t = this.fade(w_frac);

    // 4. Calculate hash values for the 16 corners of the hypercube.
    // (This is the corrected version that passes the hash, not p[hash])
    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;

    const AAA = this.p[AA] + W;
    const AAB = this.p[AA + 1] + W;
    const ABA = this.p[AB] + W;
    const ABB = this.p[AB + 1] + W;
    const BAA = this.p[BA] + W;
    const BAB = this.p[BA + 1] + W;
    const BBA = this.p[BB] + W;
    const BBB = this.p[BB + 1] + W;

    // 5. "Quad"-linearly interpolate the 16 corner gradients

    // *** --- FIX WAS APPLIED HERE --- ***
    // All calls to this.grad() are now wrapped in this.p[... & 255]
    // to correctly look up the gradient from the permutation table.

    // Lerp along W (time)
    const res0 = this.lerp(this.grad(this.p[AAA & 255], x_frac, y_frac, z_frac, w_frac), this.grad(this.p[AAA + 1 & 255], x_frac, y_frac, z_frac, w_frac - 1), t);
    const res1 = this.lerp(this.grad(this.p[BAA & 255], x_frac - 1, y_frac, z_frac, w_frac), this.grad(this.p[BAA + 1 & 255], x_frac - 1, y_frac, z_frac, w_frac - 1), t);
    const res2 = this.lerp(this.grad(this.p[ABA & 255], x_frac, y_frac - 1, z_frac, w_frac), this.grad(this.p[ABA + 1 & 255], x_frac, y_frac - 1, z_frac, w_frac - 1), t);
    const res3 = this.lerp(this.grad(this.p[BBA & 255], x_frac - 1, y_frac - 1, z_frac, w_frac), this.grad(this.p[BBA + 1 & 255], x_frac - 1, y_frac - 1, z_frac, w_frac - 1), t);
    const res4 = this.lerp(this.grad(this.p[AAB & 255], x_frac, y_frac, z_frac - 1, w_frac), this.grad(this.p[AAB + 1 & 255], x_frac, y_frac, z_frac - 1, w_frac - 1), t);
    const res5 = this.lerp(this.grad(this.p[BAB & 255], x_frac - 1, y_frac, z_frac - 1, w_frac), this.grad(this.p[BAB + 1 & 255], x_frac - 1, y_frac, z_frac - 1, w_frac - 1), t);
    const res6 = this.lerp(this.grad(this.p[ABB & 255], x_frac, y_frac - 1, z_frac - 1, w_frac), this.grad(this.p[ABB + 1 & 255], x_frac, y_frac - 1, z_frac - 1, w_frac - 1), t);
    const res7 = this.lerp(this.grad(this.p[BBB & 255], x_frac - 1, y_frac - 1, z_frac - 1, w_frac), this.grad(this.p[BBB + 1 & 255], x_frac - 1, y_frac - 1, z_frac - 1, w_frac - 1), t);

    // Lerp along Z
    const res8 = this.lerp(res0, res4, s);
    const res9 = this.lerp(res1, res5, s);
    const res10 = this.lerp(res2, res6, s);
    const res11 = this.lerp(res3, res7, s);

    // Lerp along Y
    const res12 = this.lerp(res8, res10, v);
    const res13 = this.lerp(res9, res11, v);

    // Finally, lerp along X
    return this.lerp(res12, res13, u);
  }
}