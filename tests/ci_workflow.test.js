import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  missingTerminalDependencies,
  requiredJobOutcomes,
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

const needsPayload = (results) => JSON.stringify(
  Object.fromEntries(Object.entries(results).map(([name, result]) => [
    name,
    { result, outputs: {} },
  ])),
);

test('every required job succeeding reports green', () => {
  const outcomes = requiredJobOutcomes(
    needsPayload({ 'js-tests': 'success', browser: 'success' }),
  );
  assert.deepEqual(outcomes, { total: 2, failed: {} });
});

test('a failed or cancelled job is reported red', () => {
  assert.deepEqual(
    requiredJobOutcomes(
      needsPayload({ 'js-tests': 'failure', browser: 'success' }),
    ),
    { total: 2, failed: { 'js-tests': 'failure' } },
  );
  assert.deepEqual(
    requiredJobOutcomes(
      needsPayload({ 'js-tests': 'cancelled', browser: 'skipped' }),
    ),
    { total: 2, failed: { 'js-tests': 'cancelled', browser: 'skipped' } },
  );
});

test('a renamed or missing result field is an error, not a green run', () => {
  assert.throws(
    () => requiredJobOutcomes(JSON.stringify({ browser: { outcome: 'success' } })),
    /job 'browser' reports no result field/,
  );
  assert.throws(
    () => requiredJobOutcomes(JSON.stringify({ browser: {} })),
    /job 'browser' reports no result field/,
  );
  assert.throws(
    () => requiredJobOutcomes(JSON.stringify({ browser: 'success' })),
    /job 'browser' reports no result field/,
  );
});

test('an absent, empty, or unusable payload is an error', () => {
  assert.throws(() => requiredJobOutcomes(undefined), /no required-job results/);
  assert.throws(() => requiredJobOutcomes('   '), /no required-job results/);
  assert.throws(() => requiredJobOutcomes('{}'), /name no jobs/);
  assert.throws(() => requiredJobOutcomes('[]'), /not a mapping/);
  assert.throws(() => requiredJobOutcomes('null'), /not a mapping/);
});

test('the gating job hands the script every job it needs', () => {
  const step = workflow.slice(workflow.indexOf('  ci-green:'));
  assert.match(step, /RESULTS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(step, /node scripts\/verify-ci-green\.mjs/);
});
