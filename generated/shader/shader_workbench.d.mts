export const BAKED_CONSTANT_IDS: ReadonlySet<string>;
export const LIVE_TOPOLOGY_FIELD: string;
export function bakedTopologyFields(catalog: { operators?: Array<{ params?: Array<{ id: string; topology?: boolean }> }> }): Set<string>;
export function engineControlNames(parameterId: string, descriptor?: {chain?: Array<{label: string; operator: string; resource_key?: string}>}): string[];
export function documentModulationBinding(descriptor: {chain?: Array<{label: string; operator: string; resource_key?: string}>}, parameterId: string): {resource: string; id: string}|null;
export const LABEL_PATTERN: RegExp;
export function declarationFromCatalogField(label: string, field: import("../../src/workbench/shader/chain_document_store.js").CatalogField, operator: string): import("../../src/workbench/shader/chain_document_store.js").ParameterDeclaration;
export function promotedControlNames(parameterId: string, descriptor?: {chain?: Array<{label: string; operator: string; resource_key?: string}>}, catalog?: object|null): string[];
export function isCatalogFieldLive(slot: {label: string; operator: string}, field: import("../../src/workbench/shader/chain_document_store.js").CatalogField, values: Readonly<Record<string, unknown>>): boolean;
export function isUnusedPlanarParameter(descriptor: object, presets: Array<{values: Record<string, unknown>}>, parameterId: string): boolean;
export const PLANAR_SOURCE_OPERATOR: 'sample.planar.v1';
export function planarSourceFamily(kind: string): string|null;
export type SourceMorph = {
  instance: string;
  from: Record<string, number|string>;
  to: Record<string, number|string>;
  evaluation: number;
  duration: number;
  easing: string;
};
export type ModulationMorph = {
  instance: string;
  from: Record<string, number|string>;
  to: Record<string, number|string>;
  mix: number;
};
export type PaletteMorph = ModulationMorph;
export function evaluateTransition(descriptor: object, bank: object, fromId: string, toId: string, evaluation: number, catalog?: object): {
  evaluation: number;
  duration: number;
  raw_progress: number;
  eased_progress: number;
  values: Record<string, number|string|{from: string; to: string; mix: number}>;
  sourceMorph?: SourceMorph;
  modulationMorphs?: ModulationMorph[];
  paletteMorph?: PaletteMorph;
};
