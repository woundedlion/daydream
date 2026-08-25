import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  missingTerminalDependencies,
  terminalJobNeeds,
  workflowJobs,
} from '../scripts/verify-ci-green.mjs';

const WORKFLOW_DIR = '.github/workflows';
const WORKFLOW_PATH = `${WORKFLOW_DIR}/ci.yml`;
const DEPLOY_PATH = `${WORKFLOW_DIR}/deploy.yml`;
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

// Every `node-version:` spelling under .github/workflows, tagged with its file.
const nodePins = (dir) => readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) => [
    ...readFileSync(`${dir}/${file}`, 'utf8').matchAll(/node-version:\s*'?([^'\s]+)'?/g),
  ].map((match) => `${file}: ${match[1]}`));

test('ci-green needs every other workflow job', () => {
  assert.deepEqual(missingTerminalDependencies(workflow, 'ci-green'), []);
  assert.deepEqual(
    terminalJobNeeds(workflow, 'ci-green').sort(),
    workflowJobs(workflow).filter((job) => job !== 'ci-green').sort(),
  );
});

test('the deploy job needs every other deploy-workflow job', () => {
  const deploy = readFileSync(DEPLOY_PATH, 'utf8');
  assert.deepEqual(missingTerminalDependencies(deploy, 'deploy'), []);
  assert.deepEqual(
    terminalJobNeeds(deploy, 'deploy').sort(),
    workflowJobs(deploy).filter((job) => job !== 'deploy').sort(),
  );
});

test('ci-green dependency check rejects an omitted job', () => {
  const incomplete = workflow.replace(/^ {6}- browser\r?\n/m, '');
  assert.notEqual(incomplete, workflow);
  assert.deepEqual(missingTerminalDependencies(incomplete, 'ci-green'), ['browser']);
});

test('every workflow pins the Node version package.json requires', () => {
  const required = JSON.parse(readFileSync('package.json', 'utf8')).engines.node
    .replace(/^>=/, '');
  assert.match(required, /^\d+\.\d+\.\d+$/,
    'package.json engines.node names one full version');
  const pins = nodePins(WORKFLOW_DIR);
  assert.ok(pins.length >= 3, 'the workflows still pin the Node version themselves');
  assert.deepEqual(pins.filter((pin) => !pin.endsWith(`: ${required}`)), [],
    `every setup-node pin must read ${required}`);
});
