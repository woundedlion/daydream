/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Regenerates the schema-v2 pattern documents and the frozen v1->v2 digest
// migration table from the v1 fixtures in shader/patterns/v1/. The committed
// v2 files are by definition this expansion's output; the byte-identical
// re-export test in tests/shader_document.test.js holds them to it.
//
//   node scripts/generate-shader-v2-documents.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileShaderDocument,
  exportShaderDocumentJson,
  parseShaderDocument,
  v1DescriptorDigest,
} from '../shader/shader_workbench.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PATTERNS = resolve(REPO, 'shader/patterns');
const FIXTURES = resolve(PATTERNS, 'v1');
const catalog = JSON.parse(readFileSync(resolve(REPO, 'shader/engine_catalog.json'), 'utf8'));

const migration = {};
const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.shader.json')).sort();
for (const name of names) {
  const source = readFileSync(resolve(FIXTURES, name), 'utf8');
  const v1 = parseShaderDocument(source);
  const compiled = compileShaderDocument(v1, { catalog });
  if (compiled.status !== 'VALID') {
    console.error(`${name}:`, JSON.stringify(compiled.diagnostics, null, 2));
    process.exit(1);
  }
  writeFileSync(resolve(PATTERNS, name), exportShaderDocumentJson(compiled.document));
  migration[v1DescriptorDigest(v1)] = compiled.descriptor_digest;
  console.log(`${name} -> ${compiled.descriptor_digest}`);
}

const table = Object.fromEntries(Object.entries(migration).sort(([a], [b]) => a < b ? -1 : 1));
writeFileSync(resolve(PATTERNS, 'digest_migration.v1v2.json'),
  `${JSON.stringify(table, null, 2)}\n`);
console.log(`${names.length} documents, ${Object.keys(table).length} migration entries`);
