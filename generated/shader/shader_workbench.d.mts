export const BAKED_CONSTANT_IDS: ReadonlySet<string>;
export const LIVE_TOPOLOGY_FIELD: string;
export function bakedTopologyFields(catalog: { operators?: Array<{ params?: Array<{ id: string; topology?: boolean }> }> }): Set<string>;
export function engineControlNames(parameterId: string, descriptor?: {chain?: Array<{label: string; operator: string; resource_key?: string}>}): string[];
export function documentModulationBinding(descriptor: {chain?: Array<{label: string; operator: string; resource_key?: string}>}, parameterId: string): {resource: string; id: string}|null;
export const LABEL_PATTERN: RegExp;
export function declarationFromCatalogField(label: string, field: import("../../src/workbench/shader/chain_document_store.js").CatalogField, operator: string): import("../../src/workbench/shader/chain_document_store.js").ParameterDeclaration;
export function promotedControlNames(parameterId: string, descriptor?: {chain?: Array<{label: string; operator: string; resource_key?: string}>}, catalog?: object|null): string[];
