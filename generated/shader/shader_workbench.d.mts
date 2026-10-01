export const BAKED_CONSTANT_IDS: ReadonlySet<string>;
export const LIVE_TOPOLOGY_FIELD: string;
export function bakedTopologyFields(catalog: { operators?: Array<{ params?: Array<{ id: string; topology?: boolean }> }> }): Set<string>;
export function engineControlNames(parameterId: string): string[];
export const LABEL_PATTERN: RegExp;
export function declarationFromCatalogField(label: string, field: import("../../src/workbench/shader/chain_document_store.js").CatalogField, operator: string): import("../../src/workbench/shader/chain_document_store.js").ParameterDeclaration;
