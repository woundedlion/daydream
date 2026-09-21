import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('npm test retains discovery and coverage guards', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts.pretest, 'node scripts/require-tests.mjs');
  assert.equal(scripts.test, 'node scripts/run-tests.mjs --experimental-test-module-mocks ' +
    '"tests/**/*.test.js" "tests/**/*.test.mjs" "tests/**/*.spec.js" "tests/**/*.spec.mjs"');
});

// The prepare script is the only thing that points git at .githooks, and a
// hook the index holds without its executable bit is never run.
test('npm install points git at the tracked hooks, every one executable', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts.prepare, 'git config core.hooksPath .githooks');
  const hooks = execFileSync('git', ['ls-files', '-s', '--', '.githooks'], { encoding: 'utf8' })
    .trim().split(/\r?\n/).map((line) => line.split(/\s+/));
  const paths = hooks.map(([, , , path]) => path);
  for (const hook of ['pre-commit', 'pre-push', 'reference-transaction']) {
    assert.ok(paths.includes(`.githooks/${hook}`), `${hook} is tracked`);
  }
  for (const [mode, , , path] of hooks) assert.equal(mode, '100755', path);
});

test('the reusable JavaScript suite runs all required checks', () => {
  const suite = readFileSync(`${WORKFLOW_DIR}/js-unit-suite.yml`, 'utf8');
  for (const command of ['npm test', 'npm run lint', 'npm run typecheck']) {
    assert.ok(suite.split(/\r?\n/).some((line) =>
      line.trim().replace(/^- /, '') === `run: ${command}`),
      `${command} is absent from the reusable suite`);
  }
  assert.match(suite, /name: Verify committed import map\s+run: \|\s+npm run importmap\s+git diff --exit-code/);
});

// No workflow is a tracked *.sh file, so the shell gate above cannot see the
// bash inside the `run:` blocks; actionlint is what pipes it through shellcheck.
test('the reusable suite lints the workflow YAML and the bash inside it', () => {
  const suite = readFileSync(`${WORKFLOW_DIR}/js-unit-suite.yml`, 'utf8');
  assert.match(suite, /pip install --require-hashes -r requirements\/actionlint\.txt/);
  assert.match(suite, /actionlint -verbose -oneline/);
  assert.match(suite, /Rule "shellcheck" was disabled/,
    'a silently dropped shellcheck would leave every run: body unchecked');
  const pin = readFileSync('requirements/actionlint.txt', 'utf8');
  assert.match(pin, /^actionlint-py==[\d.]+/m, 'the linter is version-pinned');
  assert.match(pin, /--hash=sha256:[0-9a-f]{64}/, 'and hash-pinned');
});

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

// The needs list is hand-parsed, so a reformat must not read as an ungated
// workflow: YAML spells a flow sequence with or without quoted entries.
test('the needs reader takes a block list, a flow list and a scalar alike', () => {
  const jobs = 'jobs:\n  build:\n    x: 1\n  browser:\n    x: 1\n  gate:\n';
  const spellings = [
    '    needs:\n      - build\n      - browser',
    '    needs: [build, browser]',
    '    needs: ["build", "browser"]',
    "    needs: ['build', 'browser']",
  ];
  for (const needs of spellings) {
    assert.deepEqual(terminalJobNeeds(jobs + needs, 'gate'), ['build', 'browser'], needs);
    assert.deepEqual(missingTerminalDependencies(jobs + needs, 'gate'), [], needs);
  }
  assert.deepEqual(
    terminalJobNeeds('jobs:\n  build:\n    x: 1\n  gate:\n    needs: build', 'gate'),
    ['build']);
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

test('column-zero comments do not end the jobs mapping', () => {
  const source = 'jobs:\n  build:\n    runs-on: ubuntu-latest\n# Browser gates\n'
    + '  browser:\n    runs-on: ubuntu-latest\n  gate:\n    needs: build\n';
  assert.deepEqual(workflowJobs(source), ['build', 'browser', 'gate']);
  assert.deepEqual(missingTerminalDependencies(source, 'gate'), ['browser']);
});

// A quoted key is valid YAML and a valid Actions job, so a scan that skipped it
// would leave the job out of the ungated-job report entirely.
test('the job scan reads a quoted key and refuses a spelling it cannot', () => {
  const quoted = 'jobs:\n  "build":\n    x: 1\n  \'browser\':\n    x: 1\n'
    + '  gate:\n    needs: [build]\n';
  assert.deepEqual(workflowJobs(quoted), ['build', 'browser', 'gate']);
  assert.deepEqual(missingTerminalDependencies(quoted, 'gate'), ['browser']);
  assert.deepEqual(terminalJobNeeds(
    'jobs:\n  build:\n    x: 1\n  "gate":\n    needs:\n      - "build"\n', 'gate'), ['build']);
  assert.throws(
    () => workflowJobs('jobs:\n  build:\n    x: 1\n  browser!:\n    x: 1\n'),
    /workflow job key is unreadable: browser!:/);
});

test('external workflow actions use immutable commit pins', () => {
  for (const file of readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const source = readFileSync(`${WORKFLOW_DIR}/${file}`, 'utf8');
    for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (action.startsWith('./')) continue;
      assert.match(action, /^[^@]+@[0-9a-f]{40}$/, `${file}: ${action}`);
    }
  }
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

test('ci-green runs after failed dependencies while deployment requires success', () => {
  const gate = workflow.split(/^ {2}ci-green:\s*$/m)[1]?.split(/^ {2}\S/m)[0];
  assert.ok(gate);
  assert.match(gate, /^ {4}if: always\(\)\s*$/m);
  const deploy = readFileSync(DEPLOY_PATH, 'utf8')
    .split(/^ {2}deploy:\s*$/m)[1]?.split(/^ {2}\S/m)[0];
  assert.ok(deploy);
  assert.doesNotMatch(deploy, /^ {4}if:.*always\(/m);
});
