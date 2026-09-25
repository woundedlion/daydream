import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubApi, latestSuccessfulPair, pairWasAttempted, recordPair, run, samePair, snapshotPair, validatePair } from '../scripts/deployment-pair.mjs';

const pair = { daydream: 'a'.repeat(40), holosphere: 'b'.repeat(40) };
const repo = 'example/daydream';
const heads = async (path) => ({ sha: path.includes('woundedlion/pov') ? pair.holosphere : pair.daydream });

test('pair selection snapshots trusted master heads and rejects malformed revisions', async () => {
  const paths = [];
  assert.deepEqual(await snapshotPair(async (path) => { paths.push(path); return heads(path); }, repo), pair);
  assert.deepEqual(paths, ['repos/example/daydream/commits/master', 'repos/woundedlion/pov/commits/master']);
  for (const value of [null, {}, { ...pair, daydream: 'master' }, { ...pair, holosphere: pair.holosphere + '-dirty' }])
    assert.throws(() => validatePair(value), /full commit/);
  assert.equal(samePair(pair, { ...pair }), true);
  assert.equal(samePair(null, pair), false);
  assert.equal(samePair(pair, { ...pair, holosphere: 'c'.repeat(40) }), false);
});

test('reconciliation uses the newest successful pair, paging past incomplete records', async () => {
  assert.equal(await latestSuccessfulPair(async () => [], repo), null);
  const paths = [];
  const previous = await latestSuccessfulPair(async (path) => {
    paths.push(path);
    if (path.includes('statuses')) return path.includes('/101/') ? [{ state: 'success' }] : [];
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => ({ id: i }));
    return [{ id: 101, payload: pair }, { id: 102, payload: { ...pair, holosphere: 'c'.repeat(40) } }];
  }, repo);
  assert.deepEqual(previous, pair);
  assert.ok(paths.some((path) => path.endsWith('page=2')));
  assert.ok(!paths.some((path) => path.includes('/102/')));
});

test('successful deployment records both exact commits only after status success', async () => {
  const calls = [];
  await recordPair(async (...args) => { calls.push(args); return { id: 42 }; }, repo, pair, 'https://example/run/1');
  assert.equal(calls[0][1].ref, pair.daydream);
  assert.deepEqual(calls[0][1].payload, pair);
  assert.equal(calls[0][1].auto_merge, false);
  assert.deepEqual(calls[0][1].required_contexts, []);
  assert.equal(calls[1][0], 'repos/example/daydream/deployments/42/statuses');
  assert.equal(calls[1][1].state, 'success');
  assert.equal(calls[1][1].auto_inactive, false);
});

test('attempted pairs suppress scheduled retries independently of success', async () => {
  assert.equal(await pairWasAttempted(async () => [{ payload: pair }], repo, pair), true);
  assert.equal(await pairWasAttempted(async () => [{ payload: { ...pair, holosphere: 'c'.repeat(40) } }], repo, pair), false);
  const calls = [];
  await recordPair(async (...args) => { calls.push(args); return { id: 9 }; }, repo, pair, 'run', 'pending');
  assert.equal(calls[1][1].state, 'pending');
});

test('GitHub API supports public reads, authenticated writes and surfaces HTTP errors', async () => {
  const calls = [];
  const fetcher = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ ok: 1 }) }; };
  assert.deepEqual(await githubApi('', fetcher)('repos/example'), { ok: 1 });
  assert.equal(calls[0][1].headers.Authorization, undefined);
  await githubApi('token', fetcher)('repos/example', { payload: pair });
  assert.equal(calls[1][1].headers.Authorization, 'Bearer token');
  assert.equal(calls[1][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1][1].body), { payload: pair });
  await assert.rejects(githubApi('', async () => ({ ok: false, status: 403 }))('denied'), /HTTP 403/);
});

test('resolve skips an already deployed pair and final checks reject either advancing head', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deployment-pair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { GITHUB_REPOSITORY: repo, GITHUB_SHA: pair.daydream, GITHUB_OUTPUT: join(root, 'outputs'), PAIR_FILE: join(root, 'pair.json') };
  const api = async (path) => {
    if (path.includes('statuses')) return [{ state: 'success' }];
    if (path.includes('deployments')) return [{ id: 42, payload: pair }];
    return heads(path);
  };
  await run('resolve', env, api);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /deploy=false/);
  assert.deepEqual(JSON.parse(readFileSync(env.PAIR_FILE)), pair);
  writeFileSync(env.GITHUB_OUTPUT, '');
  await run('resolve', { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', FORCE_DEPLOY: 'true' }, api);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /deploy=true/);
  writeFileSync(env.GITHUB_OUTPUT, '');
  await run('resolve', { ...env, GITHUB_EVENT_NAME: 'schedule' }, async (path) => {
    if (path.includes('statuses')) return [{ state: 'failure' }];
    return api(path);
  });
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /deploy=false/);
  await run('check', env, heads);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /current=true/);
  for (const moved of ['daydream', 'holosphere']) {
    writeFileSync(env.GITHUB_OUTPUT, '');
    await run('check', env, async (path) => ({ sha: path.includes(moved === 'holosphere' ? 'woundedlion/pov' : repo)
      ? 'c'.repeat(40) : (await heads(path)).sha }));
    assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /current=false/);
  }
  writeFileSync(env.GITHUB_OUTPUT, '');
  await run('resolve', env, async (path) => path.includes('deployments') ? [] : heads(path));
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /deploy=true/);
  writeFileSync(env.GITHUB_OUTPUT, '');
  await run('resolve', { ...env, GITHUB_SHA: 'd'.repeat(40) }, async (path) => path.includes('deployments') ? [] : heads(path));
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /deploy=false/);
  const calls = [];
  await run('record', { ...env, GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '5' }, async (...args) => {
    calls.push(args); return { id: 42 };
  });
  assert.equal(calls[1][1].log_url, 'https://github.com/example/daydream/actions/runs/5');
  await assert.rejects(run('bad', env, api), /Unknown deployment/);
  await assert.rejects(run('resolve', {}, api), /Missing repository/);
});
