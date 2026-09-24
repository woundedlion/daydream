/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Regenerates the frozen v1->v2 digest migration table from the v1 fixtures in
// shader/patterns/v1/. Each entry maps a v1 descriptor digest onto the digest
// of the committed document of the same name. Current pattern documents are
// engine-owned artifacts; some intentionally differ from the legacy expansion,
// so the expansion's own digest is not an identity anything ships.
//
//   node scripts/generate-shader-v2-documents.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileShaderDocument,
  parseShaderDocument,
  v1DescriptorDigest,
} from '../shader/shader_workbench.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PATTERNS = resolve(REPO, 'shader/patterns');
const FIXTURES = resolve(PATTERNS, 'v1');
const catalog = JSON.parse(readFileSync(resolve(REPO, 'shader/engine_catalog.json'), 'utf8'));

const migration = {};
const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.shader.json')).sort();
if (names.length === 0) {
  throw new Error('No legacy shader fixtures found; migration table was not written.');
}
for (const name of names) {
  const v1 = parseShaderDocument(readFileSync(resolve(FIXTURES, name), 'utf8'));
  const successor = compileShaderDocument(
    readFileSync(resolve(PATTERNS, name), 'utf8'), { catalog });
  if (successor.status !== 'VALID') {
    console.error(`${name}:`, JSON.stringify(successor.diagnostics, null, 2));
    process.exit(1);
  }
  migration[v1DescriptorDigest(v1)] = successor.descriptor_digest;
  console.log(`${name} -> ${successor.descriptor_digest}`);
}

const table = Object.fromEntries(Object.entries(migration).sort(([a], [b]) => a < b ? -1 : 1));
writeFileSync(resolve(PATTERNS, 'digest_migration.v1v2.json'),
  `${JSON.stringify(table, null, 2)}\n`);
console.log(`${names.length} legacy documents, ${Object.keys(table).length} migration entries`);
