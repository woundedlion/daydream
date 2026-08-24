import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ciGreenNeeds,
  missingCiGreenDependencies,
  workflowJobs,
} from '../scripts/verify-ci-green.mjs';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

test('ci-green needs every other workflow job', () => {
  assert.deepEqual(missingCiGreenDependencies(workflow), []);
  assert.deepEqual(
    ciGreenNeeds(workflow).sort(),
    workflowJobs(workflow).filter((job) => job !== 'ci-green').sort(),
  );
});

test('ci-green dependency check rejects an omitted job', () => {
  const incomplete = workflow.replace(/^ {6}- browser\r?\n/m, '');
  assert.notEqual(incomplete, workflow);
  assert.deepEqual(missingCiGreenDependencies(incomplete), ['browser']);
});
