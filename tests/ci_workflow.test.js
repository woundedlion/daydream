import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GATED_WORKFLOWS,
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

/** @param {string} source @returns {string[]} The workflow's `on:` trigger names. */
const triggersOf = (source) => {
  const header = /^(?:on|'on'|"on"):[ \t]*([^\n]*)$/m.exec(source);
  assert.ok(header, 'workflow must declare its triggers');
  const inline = header[1].replace(/\s+#.*$/, '').trim();
  if (inline) {
    assert.match(inline, /^(?:[a-z_]+|\[(?:[\w'", \t]*)\])$/,
      'unsupported trigger syntax must not bypass the aggregate');
    return inline.match(/[a-z_]+/g) ?? [];
  }
  const block = source.slice(header.index + header[0].length).split(/^\S/m)[0];
  const names = [...block.matchAll(/^ {2}['"]?([a-z_]+)['"]?:/gm)].map((match) => match[1]);
  assert.ok(names.length, 'workflow trigger block must not be empty');
  return names;
};

// A workflow only workflow_call reaches is gated through its caller; every
// other one is reachable on its own and needs a terminal job on the list.
test('GATED_WORKFLOWS names every directly triggered workflow', () => {
  assert.deepEqual(triggersOf(workflow), ['pull_request']);
  const direct = readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file))
    .map((file) => `${WORKFLOW_DIR}/${file}`)
    .filter((path) => triggersOf(readFileSync(path, 'utf8'))
      .some((trigger) => trigger !== 'workflow_call'));
  assert.deepEqual(GATED_WORKFLOWS.map(([path]) => path).sort(), direct.sort());
  for (const [path, terminal] of GATED_WORKFLOWS) {
    assert.ok(workflowJobs(readFileSync(path, 'utf8')).includes(terminal),
      `${path} has no job ${terminal}`);
  }
});

for (const [path, terminal] of GATED_WORKFLOWS) {
  test(`${terminal} needs every other ${path} job`, () => {
    const source = readFileSync(path, 'utf8');
    assert.deepEqual(missingTerminalDependencies(source, terminal), []);
    assert.deepEqual(
      terminalJobNeeds(source, terminal).sort(),
      workflowJobs(source).filter((job) => job !== terminal).sort(),
    );
  });
}

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
;
  assert.match(required, /^\d+\.\d+\.\d+$/,
    'package.json engines.node names one full version');
  assert.equal(readFileSync('.nvmrc', 'utf8').trim(), required);
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

test('PR suites consume the provenance-gated bundle before CI can pass', () => {
  assert.match(workflow, /uses: \.\/\.github\/workflows\/engine-bundle\.yml/);
  for (const suite of ['js-tests', 'browser']) {
    const block = workflow.split(`  ${suite}:`)[1].split(/^ {2}[^ ]/m)[0];
    assert.match(block, /needs: gate/);
    assert.match(block, /engine-bundle: true/);
  }
  assert.ok(terminalJobNeeds(workflow, 'ci-green').includes('gate'));
});

test('the reusable suite verifies CDN integrity and lints tracked shell hooks', () => {
  const suite = readFileSync(`${WORKFLOW_DIR}/js-unit-suite.yml`, 'utf8');
  assert.match(suite, /name: Verify CDN integrity\s+run: node scripts\/check-cdn-integrity\.mjs/);
  assert.match(suite, /run: pip install --require-hashes -r requirements\/shellcheck\.txt/);
  const shell = suite.split('- name: Lint shell')[1]?.split(/\n {6}- /)[0] ?? '';
  assert.ok(shell.includes("git ls-files -- '*.sh' '.githooks/*'"));
  assert.ok(shell.includes('no shell files selected'));
  assert.match(shell, /shellcheck "\$\{FILES\[@\]\}"/);
});


test('workflow trigger parsing cannot hide flow or quoted declarations', () => {
  for (const source of ['on: [push, pull_request]', '"on": ["push", "pull_request"]',
    "'on':\n  push:\n  pull_request:\n", 'on: push']) {
    assert.ok(triggersOf(source).includes('push'), source);
  }
  assert.throws(() => triggersOf('"on": {push: {}}'), /unsupported trigger syntax/);
});



test('shell lint has no workflow-wide excluded diagnostics', () => {
  const suite = readFileSync(`${WORKFLOW_DIR}/js-unit-suite.yml`, 'utf8');
  assert.doesNotMatch(suite, /shellcheck[^\n]*--exclude/);
});

test('engine bundle API failures stop the gate instead of entering its poll timeout', () => {
  const gate = readFileSync(`${WORKFLOW_DIR}/engine-bundle.yml`, 'utf8');
  assert.doesNotMatch(gate, /\|\| true/);
  assert.match(gate, /Cannot query engine CI; check token access[^\n]+\n\s+exit 1/);
  assert.match(gate, /actions: read/);
});


test('actionlint enumerates both workflow extensions', () => {
  const suite = readFileSync(`${WORKFLOW_DIR}/js-unit-suite.yml`, 'utf8');
  assert.ok(suite.includes("git ls-files -- '.github/workflows/*.yml' '.github/workflows/*.yaml'"));
});


test('old engine pins warn and expired bundles explain the producing-run remedy', () => {
  const gate = readFileSync(`${WORKFLOW_DIR}/engine-bundle.yml`, 'utf8');
  assert.match(gate, /::warning::Engine pin/);
  assert.match(gate, /::warning::Engine bundle expires/);
  assert.match(gate, /if \[ "\$expired" = true \]/);
  assert.match(gate, /gh run rerun \$run_id --repo woundedlion\/pov/);
});

test('engine bundle callers grant Actions read only to the bundle gate', () => {
  for (const path of [WORKFLOW_PATH, DEPLOY_PATH]) {
    const source = readFileSync(path, 'utf8');
    const gate = source.split(/^ {2}gate:\s*$/m)[1]?.split(/^ {2}\S/m)[0];
    assert.ok(gate, `${path} has an engine gate`);
    assert.match(gate, /^ {4}permissions:\s*\n {6}contents: read\s*\n {6}actions: read\s*$/m, path);
    assert.match(gate, /uses: \.\/\.github\/workflows\/engine-bundle\.yml/, path);
    assert.doesNotMatch(source.split(/^jobs:/m)[0], /actions:/, path);
  }
});

test('bundle installation checks additions as well as tracked changes', () => {
  for (const name of ['engine-bundle', 'js-unit-suite', 'deploy']) {
    const source = readFileSync(`${WORKFLOW_DIR}/${name}.yml`, 'utf8');
    assert.ok(source.includes('test -z "$(git status --porcelain)"'), name);
  }
});

test('pre-push requires lint and typecheck to succeed', () => {
  const hook = readFileSync('.githooks/pre-push', 'utf8');
  for (const command of ['npm run lint', 'npm run typecheck']) {
    assert.ok(hook.split(/\r?\n/).some((line) => line.trim() === `${command} || exit 1`),
      `${command} must refuse the push on failure`);
  }
});

test('the CI gate executes through a linked checkout path', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'daydream-cli-link-'));
  try {
    const linked = join(scratch, 'checkout');
    symlinkSync(resolve('.'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [join(linked, 'scripts/verify-ci-green.mjs')],
      { encoding: 'utf8', cwd: scratch });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length > 0, 'missing inputs must be reported');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-push bounds browser probes and owns their scratch directory', () => {
  const hook = readFileSync('.githooks/pre-push', 'utf8');
  assert.match(hook, /probe_deadline=\$\(\( \$\(date \+%s\) \+ 1500 \)\)/);
  assert.match(hook, /left < 420 \? left : 420/);
  assert.ok(hook.includes('timeout -k 10s "${limit}s" "$@"'));
  assert.ok(hook.includes('export TMPDIR="$probe_tmp" TMP="$probe_tmp" TEMP="$probe_tmp"'));
  assert.ok(hook.includes('rm -rf "$probe_tmp"'));
  assert.match(hook, /resolveBrowser\(\)\)\.catch/);
});
