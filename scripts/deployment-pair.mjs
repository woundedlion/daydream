import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENGINE_REPO = 'woundedlion/pov';
const PAIR_ENVIRONMENT = 'daydream-pair';
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function validatePair(pair) {
  if (!pair || !validSha(pair.daydream) || !validSha(pair.holosphere))
    throw new Error('Deployment pair must contain two full commit SHAs');
  return pair;
}

export function githubApi(token, fetcher = fetch) {
  return async (path, body) => {
    const response = await fetcher(`https://api.github.com/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
    return response.json();
  };
}

export async function snapshotPair(api, repo) {
  const [daydream, holosphere] = await Promise.all([
    api(`repos/${repo}/commits/master`), api(`repos/${ENGINE_REPO}/commits/master`),
  ]);
  return validatePair({ daydream: daydream.sha, holosphere: holosphere.sha });
}

export async function latestSuccessfulPair(api, repo) {
  for (let page = 1; ; page++) {
    const deployments = await api(`repos/${repo}/deployments?environment=${PAIR_ENVIRONMENT}&per_page=100&page=${page}`);
    for (const deployment of deployments) {
      const statuses = await api(`repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
      if (statuses[0]?.state === 'success') return validatePair(deployment.payload);
    }
    if (deployments.length < 100) return null;
  }
}

export const samePair = (a, b) => Boolean(a && b && a.daydream === b.daydream && a.holosphere === b.holosphere);

export async function pairWasAttempted(api, repo, pair) {
  for (let page = 1; ; page++) {
    const deployments = await api(`repos/${repo}/deployments?environment=${PAIR_ENVIRONMENT}&sha=${pair.daydream}&per_page=100&page=${page}`);
    if (deployments.some((deployment) => samePair(pair, deployment.payload))) return true;
    if (deployments.length < 100) return false;
  }
}

export async function recordPair(api, repo, pair, runUrl, state = 'success') {
  validatePair(pair);
  const deployment = await api(`repos/${repo}/deployments`, {
    ref: pair.daydream, environment: PAIR_ENVIRONMENT, payload: pair,
    auto_merge: false, required_contexts: [], transient_environment: true, production_environment: false,
    description: `Holosphere ${pair.holosphere}`,
  });
  await api(`repos/${repo}/deployments/${deployment.id}/statuses`, {
    state, auto_inactive: false, log_url: runUrl,
    description: state === 'success' ? 'Unit, browser and Pages deployment checks passed' : 'Deployment pair attempt started',
  });
}

export async function run(command, env, api) {
  const repo = env.GITHUB_REPOSITORY;
  const pairFile = env.PAIR_FILE || 'deployment-pair.json';
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Missing repository');
  const output = (values) => appendFileSync(env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (command === 'resolve') {
    const pair = await snapshotPair(api, repo);
    const previous = await latestSuccessfulPair(api, repo);
    const attempted = env.GITHUB_EVENT_NAME === 'schedule' && await pairWasAttempted(api, repo, pair);
    writeFileSync(pairFile, JSON.stringify(pair, null, 2) + '\n');
    const forced = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.FORCE_DEPLOY === 'true';
    output({ ...pair, deploy: env.GITHUB_SHA === pair.daydream && (forced || (!samePair(pair, previous) && !attempted)) });
  } else if (command === 'check') {
    const pair = validatePair(JSON.parse(readFileSync(pairFile, 'utf8')));
    output({ current: samePair(pair, await snapshotPair(api, repo)) });
  } else if (command === 'record' || command === 'attempt') {
    await recordPair(api, repo, JSON.parse(readFileSync(pairFile, 'utf8')),
      `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
      command === 'attempt' ? 'pending' : 'success');
  } else throw new Error(`Unknown deployment command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await run(process.argv[2], process.env, githubApi(process.env.GH_TOKEN));
}
