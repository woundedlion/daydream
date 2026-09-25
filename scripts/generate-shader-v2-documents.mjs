/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Maps frozen v1 descriptor digests to installed document filenames.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseShaderDocument,
  v1DescriptorDigest,
} from '../shader/shader_workbench.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PATTERNS = resolve(REPO, 'shader/patterns');
const FIXTURES = resolve(PATTERNS, 'v1');

const migration = {};
const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.shader.json')).sort();
if (names.length === 0) {
  throw new Error('No legacy shader fixtures found; migration table was not written.');
}
for (const name of names) {
  const v1 = parseShaderDocument(readFileSync(resolve(FIXTURES, name), 'utf8'));
  migration[v1DescriptorDigest(v1)] = name;
  console.log(`${name} -> ${v1DescriptorDigest(v1)}`);
}

const table = Object.fromEntries(Object.entries(migration).sort(([a], [b]) => a < b ? -1 : 1));
writeFileSync(resolve(PATTERNS, 'digest_migration.v1v2.json'),
  `${JSON.stringify(table, null, 2)}\n`);
console.log(`${names.length} legacy documents, ${Object.keys(table).length} migration entries`);
