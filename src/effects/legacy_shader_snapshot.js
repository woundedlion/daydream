// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { LEGACY_SHADER_FIELDS } from './legacy_shader_schema.js';
import { scratchChainDocument } from '../workbench/shader/chain_document_store.js';

const SOURCE = ['sample.twin-wave.v3', 'sample.rings.v2', 'sample.spiral.v2',
  'sample.grid.v3', 'sample.projected-noise.v2', 'sample.lattice.v2',
  'sample.spherical-noise.v3', 'sample.spherical-rings.v3', 'sample.fractal.v2',
  'sample.tessellation.v2'];
const PROJECTION = ['project.folded-sinusoidal.v2', 'project.stereographic.v2',
  'project.gnomonic.v2', 'project.bonne.v3', 'project.peirce.v3',
  'project.airocean.v3', 'project.equirectangular.v2'];
const WARP = [null, 'warp.affine.v3', 'warp.wave-shear.v2', 'warp.vortex.v2',
  'warp.vector-noise.v2', 'warp.curl-flow.v2', 'warp.mirror-tile.v2', 'warp.polar-chart.v2'];
const INTEGER_FIELDS = new Set([
  'params.source.noise_basis', 'params.source.noise_seed', 'params.surface_noise.basis',
  'params.surface_noise.integrator', 'params.surface_noise.seed',
  'params.source.ring_count', 'params.source.fractal_iterations', 'params.source.tessellation_kind',
]);
const FLOAT_BITS = new DataView(new ArrayBuffer(4));
/** @param {number} bits @returns {number} */
const floatValue = (bits) => { FLOAT_BITS.setUint32(0, bits, true); return FLOAT_BITS.getFloat32(0, true); };

/** @param {number} noiseSeed @param {number} spinPhase @returns {*} */
const legacyWalk = (noiseSeed, spinPhase) => ({
  noiseSeed, spinPhase, walkTime: 0, angularVelocity: 0,
  position: [0, 1, 0], direction: [0, 0, -1],
  wander: [1, 0, 0, 0], rawOrientation: [1, 0, 0, 0], legacy: true,
});

/** @param {Array<{instance:string,operator:string}>} chain @param {Record<string,number>} values @param {number[]} clocks @returns {Array<*>} */
export function legacyShaderRuntime(chain, values, clocks) {
  const phase = (/** @type {number} */ index) => ((clocks[index] % 1) + 1) % 1;
  return chain.flatMap(({instance, operator}) => {
    let kind;
    let state;
    const outer = instance === 'outer';
    if (operator === 'sphere.rotate.v2' || operator.startsWith('project.')) {
      kind = 'spatial-walk-v1';
      state = legacyWalk(operator === 'sphere.rotate.v2' ? -1517021871 : -1021214475,
        operator === 'sphere.rotate.v2' ? 0 : clocks[4]);
    } else if (operator.startsWith('sphere.displace.') || operator === 'warp.vector-noise.v2'
        || operator === 'warp.curl-flow.v2' || operator === 'sample.projected-noise.v2'
        || operator === 'sample.spherical-noise.v3') {
      kind = 'noise-clock-v1';
      const surface = operator.startsWith('sphere.displace.');
      const warp = operator.startsWith('warp.');
      state = {
        phase: phase(surface ? 8 : warp ? outer ? 9 : 10 : 6),
        noiseSeed: values[surface ? 'params.surface_noise.seed' : warp
          ? `slots.warp_program.${outer ? 'outer' : 'inner'}.seed` : 'params.source.noise_seed'] | 0,
      };
    } else if (operator === 'warp.affine.v3') {
      kind = 'affine-clock-v1';
      state = {phase: phase(outer ? 9 : 10), rotation: clocks[outer ? 3 : 7]};
    } else if (operator.startsWith('warp.')) {
      kind = 'phase-clock-v1';
      state = {phase: phase(outer ? 9 : 10)};
    } else if (operator === 'sample.spherical-rings.v3') {
      kind = 'spherical-rings-v1';
      state = {walk: legacyWalk(-1517021871, clocks[2]), phase: clocks[0]};
    } else if (operator.startsWith('sample.') && operator !== 'sample.lattice.v2') {
      kind = 'source-clock-v1';
      state = {primary: clocks[0], secondary: clocks[1], angle: clocks[2]};
    } else if (operator.startsWith('colorize.')) {
      kind = 'color-clock-v1';
      state = {oscillationPhase: phase(11), hueNoisePhase: phase(5), hueNoiseSeed: 6047};
    } else return [];
    return [{instance, kind, state}];
  });
}

/**
 * @param {*} original
 * @param {*} catalog
 * @param {(chain: Array<{instance:string,operator:string}>, values: Record<string,number>, clocks:number[], hasRuntime:boolean) => Array<*>} [runtimeFactory]
 * @returns {*}
 */
export function convertLegacyShaderSnapshot(original, catalog, runtimeFactory = legacyShaderRuntime) {
  const refused = (/** @type {string} */ reason) => ({ ok: false, reason, original });
  try {
    if (!original || ![10, 11].includes(original.schemaVersion))
      return refused('Only legacy Shader snapshot versions 10 and 11 can be imported.');
    const count = original.schemaVersion === 10 ? 153 : 152;
    for (const array of [original.accepted, original.requested]) {
      if (!Array.isArray(array) || array.length !== count
          || array.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff))
        return refused('The legacy snapshot has invalid configuration words.');
    }
    if (!Array.isArray(original.pendingFieldIds)
        || new Set(original.pendingFieldIds).size !== original.pendingFieldIds.length
        || original.pendingFieldIds.some((/** @type {number} */ id) => !Number.isInteger(id) || id < 0 || id >= count))
      return refused('The legacy snapshot has invalid pending field IDs.');
    const pending = new Set(original.pendingFieldIds);
    for (let index = 0; index < count; index += 1) {
      if (pending.has(index) !== (original.accepted[index] !== original.requested[index]))
        return refused('The legacy pending fields do not match its requested values.');
    }
    if (original.schemaVersion === 10
        && (original.accepted[152] > 3 || original.requested[152] > 3))
      return refused('The legacy palette mapping is invalid.');
    if (typeof original.hasRuntime !== 'boolean'
        || (original.hasRuntime && (!Array.isArray(original.runtime) || original.runtime.length !== 12
          || original.runtime.some((/** @type {number} */ value) => !Number.isFinite(value)))))
      return refused('The legacy snapshot has invalid animation clocks.');
    /** @type {Record<string, number>} */
    const values = {};
    for (const [index, name] of LEGACY_SHADER_FIELDS.entries()) {
      const word = original.accepted[index];
      values[name] = name.startsWith('slots.') || INTEGER_FIELDS.has(name) ? word : floatValue(word);
      if (!Number.isFinite(values[name])) return refused(`The legacy field ${name} is non-finite.`);
    }
    const lensStorage = values['slots.surface_lens'];
    if (lensStorage === 5 || lensStorage > 13)
      return refused('The legacy lens is unsupported.');
    values['slots.surface_lens'] = lensStorage > 5 ? lensStorage - 1 : lensStorage;
    for (const instance of ['outer', 'inner']) {
      const name = `slots.warp_program.${instance}.kind`;
      if (values[name] === 1 || values[name] > 8)
        return refused('The legacy planar warp is unsupported.');
      values[name] = values[name] > 1 ? values[name] - 1 : 0;
    }
    const slot = (/** @type {string} */ name) => values[`slots.${name}`];
    const param = (/** @type {string} */ name) => values[`params.${name}`];
    const source = SOURCE[slot('function')];
    const projection = PROJECTION[slot('projection')];
    if (!source || !projection) return refused('The legacy source or projection is unsupported.');
    /** @type {Array<{instance: string, operator: string}>} */
    const chain = [];
    /** @type {Array<{name: string, value: number}>} */
    const parameters = [];
    const operators = new Map(catalog.operators.map((/** @type {*} */ op) => [op.id, op]));
    /** @param {string} instance @param {string} id @param {Record<string,number>} overrides */
    const add = (instance, id, overrides) => {
      const operator = /** @type {*} */ (operators.get(id));
      if (!operator) throw new Error(`The engine catalog has no equivalent for ${id}.`);
      chain.push({ instance, operator: id });
      for (const field of operator.params) {
        const value = overrides[field.id] ?? (field.values
          ? field.values.indexOf(field.default) : field.default);
        if (!Number.isFinite(value) || (field.values
          ? !Number.isInteger(value) || value < 0 || value >= field.values.length
          : value < Math.fround(field.min) || value > Math.fround(field.max)))
          throw new Error(`The legacy value for ${instance}.${field.id} is outside the chain domain.`);
        parameters.push({ name: `${instance}.${field.id}`, value });
      }
    };
    add('camera', 'sphere.rotate.v2', { wander: param('outer_camera.wander') });
    const displacement = slot('surface_noise');
    if (![0, 1].includes(slot('surface_noise_placement')))
      return refused('The legacy surface displacement placement is invalid.');
    /** @returns {void} */
    const addDisplacement = () => {
      if (displacement === 0) return;
      if (![1, 2].includes(displacement)) throw new Error('The legacy surface displacement is unsupported.');
      add('displace', displacement === 1 ? 'sphere.displace.direct.v2' : 'sphere.displace.curl.v2', {
        scale: param('surface_noise.scale'), strength: param('surface_noise.strength'),
        speed: param('surface_noise.rate'), direction: param('surface_noise.direction'),
        basis: param('surface_noise.basis'), integrator: param('surface_noise.integrator'),
      });
    };
    if (slot('surface_noise_placement') === 0) addDisplacement();
    const lens = slot('surface_lens');
    if (lens === 1) add('lens', 'sphere.lens.glitch.v2', {});
    else if (lens === 2) add('lens', 'sphere.lens.twist.v2', {});
    else if (lens === 4) {
      const components = ['a.re', 'a.im', 'b.re', 'b.im', 'c.re', 'c.im', 'd.re', 'd.im'];
      add('lens', 'sphere.lens.mobius.v2', Object.fromEntries(components.map((component) =>
        [`mobius-${component.replace('.', '-')}`, param(`surface_lens.mobius.${component}`)])));
    } else if (lens === 3 || (lens >= 5 && lens <= 12)) {
      add('lens', 'sphere.lens.kaleidoscope.v2', { symmetry: lens === 3 ? 0 : lens - 4 });
    } else if (lens !== 0) return refused('The legacy lens is unsupported.');
    if (slot('surface_noise_placement') === 1) addDisplacement();
    const spherical = slot('function') === 6 || slot('function') === 7;
    if (spherical && (slot('warp_program.outer.kind') || slot('warp_program.inner.kind')))
      return refused('A spherical legacy source with planar warps cannot be imported.');
    if (!spherical) {
      const id = slot('projection') === 4 && slot('peirce_layout') === 1
        && param('projection.central_meridian') === 0
        ? 'project.peirce-square-fast.v3' : projection;
      add('project', id, {
        'singularity-fade': param('projection.singularity_fade'),
        'projection-spin-speed': param('projection.spin_rate'),
        'projection-wander': param('projection.wander'),
        'central-meridian': param('projection.central_meridian'),
        'coordinate-scale': param('projection.coordinate_scale'),
        'layout-scroll': param('projection.layout_scroll'),
        'standard-parallel': param('projection.bonne_standard_parallel'),
        frame: slot('projection_frame'),
        hemisphere: slot('projection') === 3 ? slot('bonne_hemisphere') : slot('gnomonic_hemisphere'),
        layout: slot('projection') === 4 ? slot('peirce_layout') : slot('airocean_layout'),
      });
      for (const instance of ['outer', 'inner']) {
        const kind = slot(`warp_program.${instance}.kind`);
        if (!kind) continue;
        const id = WARP[kind];
        if (!id) return refused('The legacy planar warp is unsupported.');
        if (kind === 5 && slot(`warp_program.${instance}.envelope`) !== 0)
          return refused('Legacy curl-flow envelopes are not representable by the chain operator.');
        /** @type {Record<string,number>} */
        const overrides = {};
        for (const name of ['scale', 'strength', 'speed', 'translation_x', 'translation_y',
          'rotation', 'scale_x', 'scale_y', 'shear', 'frequency', 'field_angle', 'center_x',
          'center_y', 'radius', 'turns', 'center_orbit_radius', 'vector_angle', 'cell_x',
          'cell_y', 'offset_x', 'offset_y', 'radial_scale', 'radial_phase', 'angular_phase', 'edge_width'])
          overrides[name.replaceAll('_', '-')] = param(`warp.${instance}.${name}`);
        overrides['rotation-rate'] = param(`warp.${instance}.rotation`);
        overrides['lattice-period'] = slot('function') === 5
          ? Math.fround(1 / param('source.lattice_cell_scale')) : 1;
        for (const name of ['basis', 'envelope']) overrides[name] = slot(`warp_program.${instance}.${name}`);
        overrides.integrator = slot(`warp_program.${instance}.curl_integrator`);
        overrides.mode = slot(`warp_program.${instance}.polar_mode`);
        overrides.harmonic = slot(`warp_program.${instance}.polar_harmonic`) - 1;
        add(instance, id, overrides);
      }
    }
    const coverage = slot('coverage');
    if (coverage < 0 || coverage > 4) return refused('The legacy coverage mode is invalid.');
    add('sample', source, {
      'pattern-freq': param('source.pattern_freq'), speed: param('source.speed'),
      complexity: param('source.complexity'), 'pattern-mix': param('source.pattern_mix'),
      drift: param('source.secondary_rate'), 'angle-speed': param('source.angle_rate'),
      'noise-scale': param('source.noise_scale'), 'noise-contrast': param('source.noise_contrast'),
      'noise-speed': param('source.noise_time_rate'), basis: param('source.noise_basis'),
      'lattice-cell-scale': param('source.lattice_cell_scale'), 'lattice-shape': param('source.lattice_shape_blend'),
      'lattice-softness': param('source.lattice_softness'), 'lattice-radius': param('source.lattice_radius'),
      'ring-count': param('source.ring_count'), 'ring-thickness': param('source.ring_thickness'),
      'ring-softness': param('source.ring_softness'), wander: param('source.ring_wander'),
      'spin-speed': param('source.angle_rate'), 'fractal-scale': param('source.fractal_scale'),
      'fractal-iterations': param('source.fractal_iterations'), 'julia-mix': param('source.julia_mix'),
      'julia-real': param('source.julia_real'), 'julia-imaginary': param('source.julia_imaginary'),
      'fractal-contours': param('source.fractal_contours'), 'cell-scale': param('source.tessellation_cell_scale'),
      'line-thickness': param('source.tessellation_line_thickness'),
      'line-softness': param('source.tessellation_line_softness'), kind: param('source.tessellation_kind'),
      'edge-width': param('value.edge_width'), 'weight-mode': slot('signal_weight'),
      'coverage-mode': [0, 2, 0, 3, 1][coverage],
    });
    const transfer = slot('value_transfer');
    if (transfer) {
      const id = [null, 'field.transfer.ridge.v2', 'field.transfer.iso-contour.v2', 'field.transfer.smooth-bands.v2'][transfer];
      if (!id) return refused('The legacy value transfer is unsupported.');
      add('transfer', id, { 'iso-level': param('value.iso_level'), 'iso-width': param('value.iso_width'),
        'band-count': param('value.band_count'), 'band-phase': param('value.band_phase') });
    }
    if (coverage === 2) add('coverage', 'field.coverage.value-cutout.v2', {
      'cutout-threshold': param('value.cutout_threshold'), 'cutout-softness': param('value.cutout_softness'),
    });
    add('colorize', 'colorize.generated-palette.v3', {
      'hue-shift-amount': param('color.hue_shift_amount'), 'hue-noise-scale': param('color.hue_noise_scale'),
      'hue-noise-speed': param('color.hue_noise_speed'), 'palette-chroma': param('color.palette_chroma'),
      'mapping-frequency': param('color.mapping_frequency'), 'mapping-phase': param('color.mapping_phase'),
      'phase-oscillation-depth': param('color.phase_oscillation_depth'),
      'phase-oscillation-speed': param('color.phase_oscillation_speed'),
      'brightness-bottom': param('color.brightness_bottom'), 'brightness-top': param('color.brightness_top'),
      'value-opacity-low': param('color.opacity_low'), 'value-opacity-high': param('color.opacity_high'),
      'palette-mode': slot('palette'), 'palette-mapping': slot('palette_mapping'),
      'hue-shift-mode': slot('hue_shift'), 'brightness-envelope': slot('brightness_envelope'),
    });
    const clocks = original.hasRuntime ? [...original.runtime] : Array(12).fill(0);
    const snapshot = { schemaVersion: 1, chain, parameters, animationsPaused: true,
      runtime: runtimeFactory(chain, values, clocks, original.hasRuntime) };
    return { ok: true, snapshot, legacy: { original, pendingFieldIds: [...original.pendingFieldIds] },
      notice: original.pendingFieldIds.length
        ? 'Imported the accepted legacy configuration. Pending edits remain preserved in its legacy sidecar.'
        : 'Imported the legacy Shader configuration as an editable chain.' };
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
}

/** @param {*} snapshot @param {*} catalog @returns {*} */
export function documentFromChainSnapshot(snapshot, catalog) {
  const document = scratchChainDocument(catalog, snapshot.chain.map((/** @type {*} */ entry) => ({
    label: entry.instance, operator: entry.operator,
  })));
  document.document_id = 'legacy-shader';
  document.effect_id = 'legacy-shader';
  document.effect_metadata.display_name = 'Imported Shader';
  document.effect_metadata.description = 'Imported legacy Shader configuration.';
  const values = document.preset_bank.presets[0].values;
  for (const entry of snapshot.parameters) {
    const parameter = document.descriptor.parameters.find((/** @type {*} */ p) => p.id === entry.name);
    values[entry.name] = parameter.storage === 'enum8'
      ? parameter.domain.values[entry.value] : entry.value;
  }
  return document;
}
