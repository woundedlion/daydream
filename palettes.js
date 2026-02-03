/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { Gradient, ProceduralPalette, GenerativePalette } from "./color.js";
import * as THREE from "three";

export const Palettes = {
    /** @type {Gradient} A pre-defined full spectrum rainbow gradient. */
    rainbow: new Gradient(256, [
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
    ]),

    /** @type {Gradient} A pre-defined rainbow gradient with black stripes. */
    rainbowStripes: new Gradient(256, [
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
    ]),

    /** @type {Gradient} A pre-defined rainbow gradient with thinner black stripes. */
    rainbowThinStripes: new Gradient(256, [
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
    ]),

    /** @type {Gradient} A gray-to-black gradient. */
    grayToBlack: new Gradient(16384, [
        [0, 0x888888],
        [1, 0x000000]
    ]),

    /** @type {Gradient} A blue-to-black gradient. */
    blueToBlack: new Gradient(256, [
        [0, 0xee00ee],
        [1, 0x000000]
    ]),

    /** @type {Gradient} Generic Gradient 1 (Orange/Red). */
    g1: new Gradient(256, [
        [0, 0xffaa00],
        [1, 0xff0000],
    ]),

    /** @type {Gradient} Generic Gradient 2 (Blue/Purple). */
    g2: new Gradient(256, [
        [0, 0x0000ff],
        [1, 0x660099],
    ]),

    /** @type {Gradient} Generic Gradient 3 (Yellow/Orange to Dark Blue/Black). */
    g3: new Gradient(256, [
        //  [0, 0xaaaaaa],
        [0, 0xffff00],
        [0.3, 0xfc7200],
        [0.8, 0x06042f],
        [1, 0x000000]
    ]),

    /** @type {Gradient} Generic Gradient 4 (Blue to Black). */
    g4: new Gradient(256, [
        //  [0, 0xaaaaaa],
        [0, 0x0000ff],
        [1, 0x000000]
    ]),

    /** @type {ProceduralPalette} A dark, saturated rainbow palette. */
    darkRainbow: new ProceduralPalette(
        [0.367, 0.367, 0.367], // A
        [0.500, 0.500, 0.500], // B
        [1.000, 1.000, 1.000], // C
        [0.000, 0.330, 0.670]  // D
    ),

    /** @type {Gradient} A lush green/blue/gold gradient. */
    emeraldForest: new Gradient(16384, [
        [0.0, 0x004E64],
        [0.2, 0x0B6E4F],
        [0.4, 0x08A045],
        [0.6, 0x6BBF59],
        [0.8, 0x138086],
        //  [0.8, 0xEB9C35],
        [1, 0x000000]
    ]),

    /** @type {ProceduralPalette} A pulsating red/black palette. */
    bloodStream: new ProceduralPalette(
        [0.169, 0.169, 0.169], // A
        [0.313, 0.313, 0.313], // B
        [0.231, 0.231, 0.231], // C
        [0.036, 0.366, 0.706]  // D
    ),

    /** @type {ProceduralPalette} A warm, faded sunset palette. */
    vintageSunset: new ProceduralPalette(
        [0.256, 0.256, 0.256], // A
        [0.500, 0.080, 0.500], // B
        [0.277, 0.277, 0.277], // C
        [0.000, 0.330, 0.670]  // D
    ),

    /** @type {ProceduralPalette} A vibrant, rich sunset palette. */
    richSunset: new ProceduralPalette(
        [0.309, 0.500, 0.500], // A
        [1.000, 1.000, 0.500], // B
        [0.149, 0.148, 0.149], // C
        [0.132, 0.222, 0.521]  // D
    ),

    /** @type {ProceduralPalette} A cool, deep ocean palette. */
    underSea: new ProceduralPalette(
        [0.000, 0.000, 0.000], // A
        [0.500, 0.276, 0.423], // B
        [0.296, 0.296, 0.296], // C
        [0.374, 0.941, 0.000]  // D);
    ),

    /** @type {ProceduralPalette} A warm late sunset palette with reds and yellows. */
    lateSunset: new ProceduralPalette(
        [0.337, 0.500, 0.096], // A
        [0.500, 1.000, 0.176], // B
        [0.261, 0.261, 0.261], // C
        [0.153, 0.483, 0.773]  // D
    ),

    /** @type {ProceduralPalette} A palette with yellow, orange, and green tones. */
    mangoPeel: new ProceduralPalette(
        [0.500, 0.500, 0.500], // A
        [0.500, 0.080, 0.500], // B
        [0.431, 0.431, 0.431], // C
        [0.566, 0.896, 0.236]  // D
    ),

    /** @type {ProceduralPalette} A cool, desaturated blue/gray palette. */
    iceMelt: new ProceduralPalette(
        [0.500, 0.500, 0.500], // A
        [0.500, 0.500, 0.500], // B
        [0.083, 0.147, 0.082], // C
        [0.579, 0.353, 0.244]  // D
    ),

    /** @type {ProceduralPalette} A vivid green and yellow-green palette. */
    lemonLime: new ProceduralPalette(
        [0.455, 0.455, 0.455], // A
        [0.571, 0.151, 0.571], // B
        [0.320, 0.320, 0.320], // C
        [0.087, 0.979, 0.319]  // D
    ),

    /** @type {ProceduralPalette} A dull green/brown, murky water palette. */
    algae: new ProceduralPalette(
        [0.210, 0.210, 0.210], // A
        [0.500, 1.000, 0.021], // B
        [0.086, 0.086, 0.075], // C
        [0.419, 0.213, 0.436]  // D
    ),

    /** @type {ProceduralPalette} A warm, fiery red/orange/black palette. */
    embers: new ProceduralPalette(
        [0.500, 0.500, 0.500], // A
        [0.500, 0.500, 0.500], // B
        [0.265, 0.285, 0.198], // C
        [0.577, 0.440, 0.358]  // D
    ),

    /** @type {ProceduralPalette} A cool, desaturated blue/gray palette. */
    lavenderLake: new ProceduralPalette(
        [0.473, 0.473, 0.473], // A
        [0.500, 0.500, 0.500], // B
        [0.364, 0.124, 0.528], // C
        [0.142, 0.378, 0.876]  // D
    )
};
