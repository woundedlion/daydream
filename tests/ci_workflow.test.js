import { test } from 'node:test';
import { RUNTIME_PATHS } from '../scripts/install-engine-bundle.mjs';
import { manifestEntries } from './helpers/site_pages.js';
import { findBash, scratchDir } from './helpers/fixture_repo.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATED_WORKFLOWS,
  missingTerminalDependencies,
  requiredJobOutcomes,
  terminalJobNeeds,
  workflowJobs,
} from '../scripts/verify-ci-green.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_DIR = '.github/workflows';
const workflowText = (name) => readFileSync(
  resolve(REPO, name.startsWith(WORKFLOW_DIR + '/') ? name : `${WORKFLOW_DIR}/${name}`), 'utf8');
const workflowFiles = () => readdirSync(resolve(REPO, WORKFLOW_DIR))
  .filter((name) => /\.ya?ml$/.test(name));
const packageJson = () => JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8'));

/** @param {string} source @param {string} name @returns {string} A top-level job block. */
function jobBlock(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^ {2}${escaped}:[ \t]*(?:#.*)?\r?$`, 'm').exec(source);
  if (!start) return '';
  const offset = start.index + start[0].length;
  const next = source.slice(offset).search(/^(?: {2}[^ \t\r\n#]|[^ \t\r\n#])/m);
  return source.slice(start.index, next < 0 ? undefined : offset + next);
}

const workflow = workflowText('ci.yml');

// The prepare script is the only thing that points git at .githooks, and a
// hook the index holds without its executable bit is never run.
test('npm install points git at the tracked hooks, every one executable', () => {
  const scripts = packageJson().scripts;
  assert.equal(scripts.prepare, 'git config core.hooksPath .githooks');
  const hooks = execFileSync('git', ['-C', REPO, 'ls-files', '-s', '--', '.githooks'], { encoding: 'utf8' })
    .trim().split(/\n/).map((line) => line.split(/\s+/));
  const paths = hooks.map(([, , , path]) => path);
  for (const hook of ['pre-commit', 'pre-push', 'reference-transaction']) {
    assert.ok(paths.includes(`.githooks/${hook}`), `${hook} is tracked`);
  }
  for (const [mode, , , path] of hooks) assert.equal(mode, '100755', path);
});

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
  const block = source.slice(header.index + header[0].length).split(/^[^\s#]/m)[0];
  const names = [...block.matchAll(/^ {2}['"]?([a-z_]+)['"]?:/gm)].map((match) => match[1]);
  assert.ok(names.length, 'workflow trigger block must not be empty');
  return names;
};

// A workflow only workflow_call reaches is gated through its caller; every
// other one is reachable on its own and needs a terminal job on the list.
test('GATED_WORKFLOWS names every directly triggered workflow', () => {
  assert.deepEqual(triggersOf(workflow), ['push', 'pull_request']);
  const direct = workflowFiles()
    .map((file) => `${WORKFLOW_DIR}/${file}`)
    .filter((path) => triggersOf(workflowText(path))
      .some((trigger) => trigger !== 'workflow_call'));
  assert.deepEqual(GATED_WORKFLOWS.map(([path]) => path).sort(), direct.sort());
  for (const [path, terminal] of GATED_WORKFLOWS) {
    assert.ok(workflowJobs(workflowText(path)).includes(terminal),
      `${path} has no job ${terminal}`);
  }
});

for (const [path, terminal] of GATED_WORKFLOWS) {
  test(`${terminal} needs every other ${path} job`, () => {
    const source = workflowText(path);
    assert.deepEqual(missingTerminalDependencies(source, terminal), []);
    assert.deepEqual(
      terminalJobNeeds(source, terminal).sort(),
      workflowJobs(source).filter((job) => job !== terminal).sort(),
    );
  });
}

test('ci-green dependency check rejects an omitted job', () => {
  const incomplete = workflow.replace(/^ {6}- browser\n/m, '');
  assert.notEqual(incomplete, workflow);
  assert.deepEqual(missingTerminalDependencies(incomplete, 'ci-green'), ['browser']);
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

test('ci-green runs after failed dependencies', () => {
  const gate = jobBlock(workflow, 'ci-green');
  assert.ok(gate);
  assert.match(gate, /^ {4}if: always\(\)\s*$/m);

});

test('engine selection snapshots current master and preserves an explicit pair', (t) => {
  const gate = workflowText('engine-bundle.yml');
  const block = gate.split('      - name: Resolve engine pin\n')[1].split('      - name:')[0];
  const body = block.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const current = 'a'.repeat(40);
  const selected = 'b'.repeat(40);
  const shell = findBash();
  if (!shell) { t.skip('Bash is unavailable'); return; }
  const scratch = scratchDir(t, 'daydream-engine-selection-');
  for (const pin of ['', selected]) {
    const output = join(scratch, pin || 'master');
    const result = spawnSync(shell, ['-e', '-s'], {
      encoding: 'utf8',
      input: `gh() {\n  test "$*" = 'api repos/woundedlion/pov/commits/master --jq .sha' || return 1\n  test -z "$SELECTED_PIN" || return 1\n  printf '%s\\n' '${current}'\n}\n${body}`,
      env: { ...process.env, SELECTED_PIN: pin, GITHUB_OUTPUT: output.replaceAll('\\', '/') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8').trim(), `pin=${pin || current}`);
  }
});

for (const [results, status, output] of [
  [{ build: { result: 'success' } }, 0, /CI green: 1 required jobs succeeded/],
  [{ build: { result: 'failure' } }, 1, /required jobs did not succeed/],
]) {
  test(`the CI gate CLI returns ${status} for ${results.build.result}`, () => {
    const result = spawnSync(process.execPath,
      [join(REPO, 'scripts/verify-ci-green.mjs')], {
        cwd: REPO, encoding: 'utf8',
        env: { ...process.env, RESULTS: JSON.stringify(results) },
      });
    assert.equal(result.status, status);
    assert.match(status === 0 ? result.stdout : result.stderr, output);
  });
}

test('the CI gate CLI rejects an ungated job before evaluating results', (t) => {
  const scratch = scratchDir(t, 'daydream-ungated-cli-');
  mkdirSync(join(scratch, '.github/workflows'), { recursive: true });
  for (const [path, terminal] of GATED_WORKFLOWS) {
    writeFileSync(join(scratch, path),
      `jobs:\n  build:\n    runs-on: ubuntu-latest\n  ${terminal}:\n    needs: [build]\n  forgotten:\n    runs-on: ubuntu-latest\n`);
  }
  const result = spawnSync(process.execPath,
    [join(REPO, 'scripts/verify-ci-green.mjs')], {
      cwd: scratch, encoding: 'utf8',
      env: { ...process.env, RESULTS: '{}' },
    });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /job 'forgotten' is absent/);
  assert.doesNotMatch(result.stderr, /required-job results/);
});

test('engine bundle polling retries transient queries and artifact calls', (t) => {
  const shell = findBash();
  if (!shell) { t.skip('Bash is unavailable'); return; }
  const gate = workflowText('engine-bundle.yml');
  const block = gate.split('      - name: Download the verified engine bundle\n')[1].split('      - name:')[0];
  const root = scratchDir(t, 'engine-retries-');
  const body = block.split('        run: |\n')[1].replace(/^ {10}/gm, '')
    .replaceAll('/tmp/engine-bundle.zip', '"$FIXTURE_ROOT/bundle.zip"');
  const stubs = `
    sleep() { :; }
    fail_api() { printf '{"message":"temporary API failure"}'; return 1; }
    python3() { test "$(cat "$FIXTURE_ROOT/bundle.zip")" = bundle; }
    gh() {
      case "$2" in
        *workflows*) kind=query ;;
        *runs/*/artifacts\\?*) kind=artifact ;;
        *artifacts/*/zip) kind=zip ;;
        *) return 9 ;;
      esac
      counter="$FIXTURE_ROOT/$kind"
      n=0
      if [ -f "$counter" ]; then n=$(cat "$counter"); fi
      n=$((n + 1))
      printf '%s' "$n" > "$counter"
      case "$kind" in
        query)
          if [ "$FIRST_FAIL" = true ]; then fail_api; return 1; fi
          if [ "$FIRST_FAIL" = transient ] && [ "$n" = 1 ]; then fail_api; return 1; fi
          if [ "$n" = 1 ]; then return 0; fi
          if [ "$n" = 2 ]; then fail_api; return 1; fi
          printf '13\\tcompleted\\tfailure\\t%s\\n12\\tcompleted\\tsuccess\\t%s\\n' "$PIN" "$PIN" ;;
        artifact)
          if [ "$n" -lt 3 ]; then fail_api; return 1; fi
          case "$4" in
            *length) printf '1\\n' ;;
            *) printf '42\\tfalse\\t2030-01-01\\n' ;;
          esac ;;
        zip)
          if [ "$n" -lt 3 ]; then printf 'partial'; return 1; fi
          printf 'bundle' ;;
      esac
    }
  `;
  for (const firstFail of [false, true, 'transient']) {
    const fixture = join(root, String(firstFail));
    mkdirSync(fixture);
    const result = spawnSync(shell, ['-e', '-s'], {
      input: stubs + body, encoding: 'utf8',
      env: { ...process.env, FIXTURE_ROOT: fixture.replaceAll('\\', '/'),
        PIN: 'a'.repeat(40), FIRST_FAIL: String(firstFail) },
    });
    const exhausted = firstFail === true;
    assert.equal(result.status, exhausted ? 1 : 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /"message":/);
    assert.doesNotMatch(result.stderr, /integer expression expected/);
    assert.equal(readFileSync(join(fixture, 'query'), 'utf8'), exhausted ? '4' : '3');
    if (!exhausted) {
      assert.equal(readFileSync(join(fixture, 'artifact'), 'utf8'), '4');
      assert.equal(readFileSync(join(fixture, 'zip'), 'utf8'), '3');
    }
  }
});

test('the engine bundle poll recovers after exhausting metadata or ZIP retries', (t) => {
  const shell = findBash();
  if (!shell) { t.skip('Bash is unavailable'); return; }
  const gate = workflowText('engine-bundle.yml');
  const block = gate.split('      - name: Download the verified engine bundle\n')[1].split('      - name:')[0];
  const root = scratchDir(t, 'engine-poll-');
  const body = block.split('        run: |\n')[1].replace(/^ {10}/gm, '')
    .replaceAll('/tmp/engine-bundle.zip', '"$FIXTURE_ROOT/bundle.zip"');
  const stubs = `
    sleep() { :; }
    python3() {
      if [ "$FAIL_PHASE" = extract ]; then return 42; fi
      test "$(cat "$FIXTURE_ROOT/bundle.zip")" = bundle
    }
    fail_batch() {
      if [ "$1" != "$FAIL_PHASE" ]; then return 1; fi
      counter="$FIXTURE_ROOT/$1"
      n=0
      if [ -f "$counter" ]; then read -r n < "$counter"; fi
      n=$((n + 1))
      printf '%s\\n' "$n" > "$counter"
      [ "$n" -le 4 ]
    }
    gh() {
      case "$2:$4" in
        *workflows*) printf '12\\tcompleted\\tsuccess\\t%s\\n' "$PIN" ;;
        *runs/*/artifacts\\?*:*length) printf '1\\n' ;;
        *runs/*/artifacts\\?*)
          if fail_batch metadata; then return 1; fi
          printf '42\\tfalse\\t2030-01-01\\n' ;;
        *artifacts/*/zip:*)
          if fail_batch zip; then printf 'partial'; return 1; fi
          printf 'bundle' ;;
        *) return 9 ;;
      esac
    }
  `;
  for (const [phase, message] of [
    ['metadata', 'artifact metadata query failed'],
    ['zip', 'artifact ZIP download failed'],
    ['extract', ''],
  ]) {
    for (const timeout of phase === 'extract' ? [false] : [false, true]) {
      const fixture = join(root, `${phase}-${timeout}`);
      mkdirSync(fixture);
      const result = spawnSync(shell, ['-e', '-s'], {
        input: stubs + (timeout ? body.replace('SECONDS + 3300', 'SECONDS + 0') : body),
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, FIXTURE_ROOT: fixture.replaceAll('\\', '/'),
          PIN: 'a'.repeat(40), FAIL_PHASE: phase },
      });
      assert.equal(result.status, phase === 'extract' ? 42 : Number(timeout),
        result.error?.message || result.stderr + result.stdout);
      if (phase === 'extract') continue;
      assert.match(result.stdout, new RegExp(`::warning::Engine bundle ${message}`));
      assert.equal(result.stdout.includes('::error::'), timeout);
      if (timeout) assert.match(result.stdout, new RegExp(`::error::[^\\n]+${message}`));
      assert.equal(readFileSync(join(fixture, phase), 'utf8').trim(), timeout ? '4' : '5');
    }
  }
});

test('deployment pair recovery uses retained resolve outputs and engine packages last through reruns', (t) => {
  const deploy = workflowText('deploy.yml');
  assert.doesNotMatch(deploy, /name: deployment-pair/);
  assert.match(deploy, /DAYDREAM_SHA: \$\{\{ needs.resolve.outputs.daydream \}\}/);
  assert.match(deploy, /HOLOSPHERE_SHA: \$\{\{ needs.resolve.outputs.holosphere \}\}/);
  const code = deploy.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/)[1]
    .replace(/^ {10}/gm, '');
  const root = scratchDir(t, 'deployment-pair-recovery-');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/deployment-pair.mjs'),
    readFileSync(resolve(REPO, 'scripts/deployment-pair.mjs')));
  const pair = { daydream: 'a'.repeat(40), holosphere: 'b'.repeat(40) };
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, env: { ...process.env, DAYDREAM_SHA: pair.daydream, HOLOSPHERE_SHA: pair.holosphere },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'deployment-pair.json'), 'utf8')), pair);
  assert.match(workflowText('engine-bundle.yml'),
    /name: verified-engine-bundle\s+path: engine-bundle\/\s+retention-days: 30\b/);
});

test('deployment MIME and presence checks cover every published engine module', () => {
  const assets = workflowText('deploy.yml').match(/^\s+ENGINE_ASSETS: (.+)$/m);
  assert.ok(assets, 'deploy declares its engine module checks');
  const published = new Set(manifestEntries());
  const expected = [...RUNTIME_PATHS].filter((path) => /\.(m?js|wasm)$/.test(path) && published.has(path));
  assert.deepEqual([...new Set(assets[1].trim().split(/\s+/))].sort(), expected.sort());
});

// The engine-parity and hook cases skip without their flags.
test('the JS unit suite arms the engine-parity and hook cases', () => {
  const source = workflowText('js-unit-suite.yml');
  const checkout = source.match(
    /- name: Checkout the pinned engine\n[\s\S]*?(?=\n\s{6}- )/,
  )?.[0] ?? '';
  assert.match(checkout, /^\s+path: engine$/m);
  const step = source.match(/- name: Test\n[\s\S]*?(?=\n\s{6}- |\s*$)/)?.[0] ?? '';
  assert.match(step, /^\s+HOLOSPHERE_ENGINE_REQUIRED: '1'$/m);
  assert.match(step, /^\s+DAYDREAM_HOOK_SH_REQUIRED: '1'$/m);
  assert.match(step, /^\s+run: npm test$/m);
});
