/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/mobius.html.
 */
import * as THREE from 'three';
import { initScene, bootstrapTool, wireCopyBlock } from './shared.js';
import { onPageTeardown } from './page_lifecycle.js';
import { createPointerDrag, innerRect } from './pointer_drag.js';
import {
  elliptic, hyperbolic, loxodromic, parabolic,
  inversion, tumble, cayley, snapComplex,
  glslComplexFunctions, glslProjectionFunctions, mobiusCodeString,
} from './mobius_transforms.js';

const config = {
  A: { re: 1.0, im: 0.0 },
  B: { re: 0.0, im: 0.0 },
  C: { re: 0.0, im: 0.0 },
  D: { re: 1.0, im: 0.0 },
  MAX_EXTENT: 2.0,
};

const uiUpdaters = {};
let isAnimating = false;
let activePreset = null;
let animationTime = 0;
// Timestamp (ms) of the previous animated frame; 0 means "seed on next
// frame". Used to advance animationTime by real elapsed time so preset
// flow speed is independent of the display refresh rate.
let lastAnimTime = 0;

let scene, sphereMesh, wireMesh;

const vertexShader = `
    varying vec3 vPosition;
    void main() {
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

const fragmentShader = `
    ${glslComplexFunctions}
    ${glslProjectionFunctions}
    uniform CNum u_a;
    uniform CNum u_b;
    uniform CNum u_c;
    uniform CNum u_d;
    varying vec3 vPosition;

    const float GRID_SCALE_R = 1.5;
    const float GRID_SCALE_THETA = 12.0;

    float pattern(float val, float thickness) {
      float fw = fwidth(val);
      float dist = abs(fract(val + 0.5) - 0.5);
      return 1.0 - smoothstep(0.0, fw * thickness, dist);
    }

    void main() {
      vec3 p = normalize(vPosition);
      // stereo() and project_div() are the engine's own maps, constants
      // included: the pole cap keeps its azimuth at the sentinel magnitude
      // and the divide guard is relative.
      CNum w = stereo(p);
      CNum num = cadd(cmult(u_a, w), u_b);
      CNum den = cadd(cmult(u_c, w), u_d);
      CNum w_prime = project_div(num, den);

      float r = length(vec2(w_prime.re, w_prime.im));
      float theta = atan(w_prime.im, w_prime.re);
      float log_r = log(r + 0.0001);
      float u = log_r * GRID_SCALE_R;
      float v = (theta / 3.14159) * GRID_SCALE_THETA;

      float gridR = pattern(u, 1.5);
      float gridTheta = pattern(v, 1.5);
      float grid = max(gridR, gridTheta);

      vec3 colorBg = vec3(0.059, 0.09, 0.165);
      vec3 colorLine = vec3(0.506, 0.549, 0.973);
      vec3 baseColor = mix(colorBg, colorBg * 1.5, 0.5 + 0.5*sin(theta));
      vec3 finalColor = mix(baseColor, colorLine, grid);

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

const updateMobiusUniforms = () => {
  if (!sphereMesh || !sphereMesh.material.uniforms) return;
  const u = sphereMesh.material.uniforms;
  u.u_a.value.re = config.A.re; u.u_a.value.im = config.A.im;
  u.u_b.value.re = config.B.re; u.u_b.value.im = config.B.im;
  u.u_c.value.re = config.C.re; u.u_c.value.im = config.C.im;
  u.u_d.value.re = config.D.re; u.u_d.value.im = config.D.im;
  updateDegenerateWarning();
  updateCodeSnippet();
};

// Cached so an animating preset (which re-enters every frame) only writes
// the DOM when the formatted snippet actually changes.
let lastCode = null;
const updateCodeSnippet = () => {
  const codeOutput = document.getElementById('mobius_code_output');
  if (!codeOutput) return;
  const code = mobiusCodeString(config.A, config.B, config.C, config.D);
  if (code === lastCode) return;
  codeOutput.textContent = code;
  lastCode = code;
};

// A Möbius transform (az+b)/(cz+d) is invertible only when its complex
// determinant ad − bc ≠ 0; at det ≈ 0 the map collapses to a constant and
// the shader paints a flat field with no on-screen cue. Surface that as a
// warning so a degenerate parameter set isn't read as a rendering bug.
const DEGENERATE_WARNING =
  '⚠ Degenerate transform (ad − bc ≈ 0): the map collapses to a constant.';

const updateDegenerateWarning = () => {
  const el = document.getElementById('degenerateWarning');
  if (!el) return;
  const { A, B, C, D } = config;
  // det = a*d - b*c (complex multiplication).
  const detRe = (A.re * D.re - A.im * D.im) - (B.re * C.re - B.im * C.im);
  const detIm = (A.re * D.im + A.im * D.re) - (B.re * C.im + B.im * C.re);
  const degenerate = Math.hypot(detRe, detIm) < 1e-4;
  if (degenerate) {
    el.classList.remove('hidden');
    if (el.textContent !== DEGENERATE_WARNING)
      el.textContent = DEGENERATE_WARNING;
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
};

const applyConfig = (newVals) => {
  if (newVals.A) { config.A.re = newVals.A.re; config.A.im = newVals.A.im; }
  if (newVals.B) { config.B.re = newVals.B.re; config.B.im = newVals.B.im; }
  if (newVals.C) { config.C.re = newVals.C.re; config.C.im = newVals.C.im; }
  if (newVals.D) { config.D.re = newVals.D.re; config.D.im = newVals.D.im; }
  Object.values(uiUpdaters).forEach(u => u());
  updateMobiusUniforms();
};

const presets = [
  {
    id: 'identity',
    name: 'Identity',
    desc: 'Reset to default state. f(z) = z',
    animate: false,
    setup: () => ({ A: { re: 1, im: 0 }, B: { re: 0, im: 0 }, C: { re: 0, im: 0 }, D: { re: 1, im: 0 } })
  },
  {
    id: 'elliptic',
    name: 'Elliptic (Rotation)',
    desc: 'Continuous rotation around the poles.',
    animate: true,
    update: (t) => elliptic(t)
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic (Zoom)',
    desc: 'Continuous flow from Source to Sink.',
    animate: true,
    update: (t) => hyperbolic(t)
  },
  {
    id: 'loxodromic',
    name: 'Loxodromic (Spiral)',
    desc: 'Seamless spiral flow.',
    animate: true,
    update: (t) => loxodromic(t)
  },
  {
    id: 'parabolic',
    name: 'Parabolic (Drift)',
    desc: 'Continuous translation along Real axis.',
    animate: true,
    update: (t) => parabolic(t)
  },
  {
    id: 'inversion',
    name: 'Inversion (Rotation)',
    desc: 'Continuous rotation around Real axis (swaps 0 and ∞).',
    animate: true,
    update: (t) => inversion(t)
  },
  {
    id: 'tumble',
    name: 'Tumble',
    desc: 'Rotation around Imaginary axis.',
    animate: true,
    update: (t) => tumble(t)
  },
  {
    id: 'cayley',
    name: 'Cayley Transform',
    desc: 'Transition: Identity -> Cayley.',
    animate: true,
    update: (t) => cayley(t)
  }
];

const stopAnimation = () => {
  isAnimating = false;
  activePreset = null;
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  // Clear the mobile dropdown back to its placeholder. <select> fires
  // 'change' only on a value change, so without this the just-stopped
  // preset stays selected and can't be re-tapped on mobile (where the
  // dropdown is the only preset UI).
  const presetSelect = document.getElementById('presetSelect');
  if (presetSelect) presetSelect.value = '';
};

const startPreset = (preset) => {
  stopAnimation(); // Stop any existing animation
  activePreset = preset;
  document.querySelectorAll('.preset-btn').forEach(b => {
    const selected = b.dataset.id === preset.id;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  const presetSelect = document.getElementById('presetSelect');
  if (presetSelect) presetSelect.value = preset.id;

  if (preset.animate) {
    isAnimating = true;
    animationTime = 0;
    lastAnimTime = 0; // re-seed the delta clock for the new preset
  } else if (preset.setup) {
    applyConfig(preset.setup());
  }
};

const createComplexPlaneControl = (id, paramObj, maxExtent, onChange) => {
  const container = document.getElementById(`${id}_control_container`);
  if (!container) return;

  const controlId = `${id}_plane`;
  const dotId = `${id}_dot`;
  const labelId = `${id}_label`;
  const reId = `${id}_re_axis`;
  const imId = `${id}_im_axis`;

  const makeDiv = (className, elementId) => {
    const el = document.createElement('div');
    el.className = className;
    if (elementId) el.id = elementId;
    return el;
  };

  // The mouse/touch-only pad is exposed as a group of two per-axis sliders:
  // each off-screen handle takes the arrow keys for its own part and carries
  // the announced value in aria-valuenow/aria-valuetext, which a screen
  // reader re-reads on every change.
  const makeAxis = (axisId, axisLabel, keyshortcuts, vertical) => {
    const el = document.createElement('span');
    el.id = axisId;
    el.className = 'complex-plane-axis';
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    if (vertical) el.setAttribute('aria-orientation', 'vertical');
    el.setAttribute('aria-label', axisLabel);
    el.setAttribute('aria-valuemin', String(-maxExtent));
    el.setAttribute('aria-valuemax', String(maxExtent));
    el.setAttribute('aria-keyshortcuts', keyshortcuts);
    return el;
  };

  const planeElement = makeDiv('complex-plane-control', controlId);
  planeElement.setAttribute('role', 'group');
  planeElement.setAttribute('aria-label', `Parameter ${id} complex value`);

  const inner = makeDiv('complex-plane-inner');
  const dotElement = makeDiv('complex-plane-dot', dotId);
  inner.append(makeDiv('axis-h'), makeDiv('axis-v'), dotElement);

  const reElement = makeAxis(reId, `Parameter ${id} real part`,
    'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home', false);
  const imElement = makeAxis(imId, `Parameter ${id} imaginary part`,
    'ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Home', true);
  planeElement.append(inner, reElement, imElement);

  const labelElement = makeDiv('complex-plane-label', labelId);
  container.replaceChildren(planeElement, labelElement);

  // Cache the last strings written to the DOM so a preset animation (which
  // calls applyConfig -> updateUI every frame) only touches the label/dot
  // when their rounded values actually change. Both outputs are quantized
  // (2-decimal text, clamped percent), so most frames are no-ops; skipping
  // them avoids ~12 redundant text/style mutations per frame at 60 Hz while
  // the shader uniforms keep updating every frame.
  let lastLabel = null, lastLeft = null, lastTop = null;
  const updateUI = () => {
    const re = paramObj.re;
    const im = paramObj.im;
    const sign = im >= 0 ? '+' : '-';
    const label = `${re.toFixed(2)} ${sign} ${Math.abs(im).toFixed(2)}i`;
    if (label !== lastLabel) {
      labelElement.textContent = label;
      const reText = re.toFixed(2);
      const imText = im.toFixed(2);
      reElement.setAttribute('aria-valuenow', reText);
      reElement.setAttribute('aria-valuetext', reText);
      imElement.setAttribute('aria-valuenow', imText);
      imElement.setAttribute('aria-valuetext', `${imText}i`);
      lastLabel = label;
    }
    const xPercent = ((re / maxExtent) * 0.5 + 0.5) * 100;
    const yPercent = ((-im / maxExtent) * 0.5 + 0.5) * 100;
    const left = `${Math.min(100, Math.max(0, xPercent))}%`;
    const top = `${Math.min(100, Math.max(0, yPercent))}%`;
    if (left !== lastLeft) {
      dotElement.style.left = left;
      lastLeft = left;
    }
    if (top !== lastTop) {
      dotElement.style.top = top;
      lastTop = top;
    }
  };

  uiUpdaters[id] = updateUI;

  const handleInput = (clientX, clientY) => {
    // The dot rides .complex-plane-inner, which spans the pad's padding box, so
    // the pointer has to be normalized against that box rather than the border
    // box getBoundingClientRect() reports.
    const rect = innerRect(planeElement);
    if (rect.width <= 0 || rect.height <= 0) return;
    if (isAnimating) stopAnimation();

    const width = rect.width;
    const height = rect.height;
    let x = clientX - rect.left;
    let y = clientY - rect.top;
    let nx = (x / width) * 2 - 1;
    let ny = -((y / height) * 2 - 1);
    let re = nx * maxExtent;
    let im = ny * maxExtent;
    re = Math.max(-maxExtent, Math.min(maxExtent, re));
    im = Math.max(-maxExtent, Math.min(maxExtent, im));
    re = snapComplex(re);
    im = snapComplex(im);

    paramObj.re = re;
    paramObj.im = im;
    updateUI();
    onChange();
  };

  // The plane carries touch-action: none, which is what stops the page
  // scrolling under a touch drag.
  const planeDrag = createPointerDrag({
    element: planeElement,
    onStart: (e) => {
      planeElement.style.cursor = 'grabbing';
      handleInput(e.clientX, e.clientY);
    },
    onMove: (e) => {
      e.preventDefault();
      handleInput(e.clientX, e.clientY);
    },
    onEnd: () => {
      planeElement.style.cursor = 'grab';
    },
  });

  // Keyboard equivalent of dragging the dot: a handle's arrows nudge its own
  // part, decreasing on Left/Down and increasing on Right/Up (Shift for a
  // coarser step); Home recenters to the origin. Mirrors handleInput's
  // stop-animation / clamp / snap / notify sequence.
  const onAxisKeyDown = (axis) => (e) => {
    const step = e.shiftKey ? 0.2 : 0.05;
    let delta = 0;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': delta = -step; break;
      case 'ArrowRight': case 'ArrowUp': delta = step; break;
      case 'Home': break; // handled below as recenter
      default: return;
    }
    e.preventDefault();
    if (isAnimating) stopAnimation();
    const home = e.key === 'Home';
    let re = home ? 0 : paramObj.re + (axis === 're' ? delta : 0);
    let im = home ? 0 : paramObj.im + (axis === 'im' ? delta : 0);
    // Scale the snap band to the key step so a single nudge escapes the
    // zero band (2*threshold) instead of latching back onto 0.
    re = snapComplex(Math.max(-maxExtent, Math.min(maxExtent, re)), step / 4);
    im = snapComplex(Math.max(-maxExtent, Math.min(maxExtent, im)), step / 4);
    paramObj.re = re;
    paramObj.im = im;
    updateUI();
    onChange();
  };

  const reKeyDown = onAxisKeyDown('re');
  const imKeyDown = onAxisKeyDown('im');
  reElement.addEventListener('keydown', reKeyDown);
  imElement.addEventListener('keydown', imKeyDown);
  updateUI();
  return () => {
    planeDrag.stop();
    planeDrag.remove();
    reElement.removeEventListener('keydown', reKeyDown);
    imElement.removeEventListener('keydown', imKeyDown);
    delete uiUpdaters[id];
  };
};

const initThree = () => {
  const result = initScene('canvasContainer', 'threeCanvas', {
    cameraPosition: [2.5, 2.5, 4],
    maxDistance: 15,
    showSphere: false,
    onAnimate: () => {
      if (isAnimating && activePreset && activePreset.update) {
        const now = performance.now();
        // Seed on the first frame (dt = 0), then advance by real elapsed
        // seconds. 0.6 units/s reproduces the original 0.01-per-frame speed
        // at 60 Hz, now matched on any refresh rate.
        const dt = lastAnimTime ? (now - lastAnimTime) / 1000 : 0;
        lastAnimTime = now;
        animationTime += dt * 0.6;
        const newVals = activePreset.update(animationTime);
        applyConfig(newVals);
      }
    },
  });
  scene = result.scene;

  // Each struct uniform keeps its own stable value object; updateMobiusUniforms
  // mutates these in place so Three.js re-uploads without per-tick allocation.
  const uniforms = {
    u_a: { value: { re: config.A.re, im: config.A.im } },
    u_b: { value: { re: config.B.re, im: config.B.im } },
    u_c: { value: { re: config.C.re, im: config.C.im } },
    u_d: { value: { re: config.D.re, im: config.D.im } }
  };

  // 64x64 is plenty: the pattern is computed per-fragment from the
  // interpolated position (the vertex shader is a pass-through), so the
  // geometry only needs enough tessellation for a smooth silhouette and
  // low interpolation error — 128x128 (~16k verts) was ~4x more than
  // needed.
  const geometry = new THREE.SphereGeometry(1.5, 64, 64);
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    side: THREE.DoubleSide
  });

  sphereMesh = new THREE.Mesh(geometry, material);
  scene.add(sphereMesh);

  const wireGeo = new THREE.SphereGeometry(1.48, 32, 16);
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.05 });
  // Keep a reference so the decorative wireframe can be disposed on teardown.
  wireMesh = new THREE.Mesh(wireGeo, wireMat);
  scene.add(wireMesh);

  updateMobiusUniforms();
  return () => {
    for (const m of [sphereMesh, wireMesh]) {
      if (!m) continue;
      m.geometry.dispose();
      m.material.dispose();
    }
    result.dispose();
  };
};

const init = () => {
  const presetList = document.getElementById('presetList');
  const presetSelect = document.getElementById('presetSelect');
  presets.forEach(preset => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.id = preset.id;
    const name = document.createElement('div');
    name.className = 'font-semibold';
    name.textContent = preset.name;
    const desc = document.createElement('div');
    desc.className = 'preset-desc';
    desc.textContent = preset.desc;
    btn.append(name, desc);
    btn.addEventListener('click', () => startPreset(preset));
    presetList.appendChild(btn);

    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.name;
    presetSelect.appendChild(opt);
  });
  presetSelect.addEventListener('change', () => {
    const preset = presets.find(p => p.id === presetSelect.value);
    if (preset) startPreset(preset);
  });

  const onParamChange = () => updateMobiusUniforms();

  const controlTeardowns = [
    createComplexPlaneControl('A', config.A, config.MAX_EXTENT, onParamChange),
    createComplexPlaneControl('B', config.B, config.MAX_EXTENT, onParamChange),
    createComplexPlaneControl('C', config.C, config.MAX_EXTENT, onParamChange),
    createComplexPlaneControl('D', config.D, config.MAX_EXTENT, onParamChange),
  ];

  document.getElementById('resetBtn').addEventListener('click', () => {
    stopAnimation();
    applyConfig({ A: { re: 1, im: 0 }, B: { re: 0, im: 0 }, C: { re: 0, im: 0 }, D: { re: 1, im: 0 } });
  });

  wireCopyBlock({
    source: document.getElementById('mobius_code_output'),
    button: document.getElementById('copy_code_button'),
    prompt: document.getElementById('copy_code_prompt'),
    block: document.getElementById('code_pre_block'),
  });

  updateCodeSnippet();
  const teardownThree = initThree();
  onPageTeardown(() => {
    for (const teardown of controlTeardowns) teardown?.();
    teardownThree();
  });
};

bootstrapTool(init, 'Möbius tool');
