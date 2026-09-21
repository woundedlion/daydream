import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A job id is a plain identifier, which YAML may spell quoted or bare.
const JOB_KEY = /^ {2}(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+)):\s*(?:#.*)?$/;
const NEED = /^ {6}-\s+(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*$/;

/** @param {string} line @returns {string|null} The job it keys, if it keys one. */
const jobKeyOf = (line) => {
  const match = line.match(JOB_KEY);
  return match ? match[1] ?? match[2] ?? match[3] : null;
};

/** @param {string} source @returns {string[]} Top-level workflow job IDs. */
export const workflowJobs = (source) => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) throw new Error('workflow has no top-level jobs mapping');

  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    // Only the job keys sit at this depth; anything else here is a spelling the
    // scan cannot classify, and dropping it would report the job as gated.
    if (!/^ {2}\S/.test(line)) continue;
    const job = jobKeyOf(line);
    if (job === null) throw new Error(`workflow job key is unreadable: ${line.trim()}`);
    jobs.push(job);
  }
  if (jobs.length === 0) throw new Error('workflow jobs mapping is empty');
  return jobs;
};

/**
 * @param {string} source @param {string} terminal - Gating job's ID.
 * @returns {string[]} Job IDs the terminal job requires.
 */
export const terminalJobNeeds = (source, terminal) => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => jobKeyOf(line) === terminal);
  if (start < 0) throw new Error(`workflow has no ${terminal} job`);

  const endOffset = lines.slice(start + 1).findIndex((line) => JOB_KEY.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const block = lines.slice(start + 1, end);
  const needsAt = block.findIndex((line) => /^ {4}needs:\s*/.test(line));
  if (needsAt < 0) throw new Error(`${terminal} has no needs list`);

  const tail = block[needsAt].replace(/^ {4}needs:\s*/, '').trim();
  if (tail !== '') {
    const value = tail.startsWith('[') && tail.endsWith(']')
      ? tail.slice(1, -1)
      : tail;
    // A flow list may quote its entries; unquoted job ids read the same either way.
    return value.split(',')
      .map((job) => job.trim().replace(/^["'](.*)["']$/, '$1').trim())
      .filter(Boolean);
  }

  const needs = [];
  for (const line of block.slice(needsAt + 1)) {
    const match = line.match(NEED);
    if (match) {
      needs.push(match[1] ?? match[2] ?? match[3]);
    } else if (/^ {4}\S/.test(line)) {
      break;
    }
  }
  if (needs.length === 0) throw new Error(`${terminal} needs list is empty`);
  return needs;
};

/**
 * @param {string} source @param {string} terminal - Gating job's ID.
 * @returns {string[]} Jobs the terminal job does not gate.
 */
export const missingTerminalDependencies = (source, terminal) => {
  const needs = new Set(terminalJobNeeds(source, terminal));
  return workflowJobs(source).filter((job) => job !== terminal && !needs.has(job));
};

/** Workflows paired with the job every other job in them must feed. */
const GATED_WORKFLOWS = [
  ['.github/workflows/ci.yml', 'ci-green'],
  ['.github/workflows/deploy.yml', 'deploy'],
];

/**
 * Aggregates the `toJSON(needs)` payload the gating job receives. Only an
 * explicit `success` string passes, so a renamed or absent result field is an
 * error rather than a green report.
 * @param {string | undefined} raw - Serialized job-result mapping.
 * @returns {{ total: number, failed: Record<string, string> }}
 */
export const requiredJobOutcomes = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('no required-job results were supplied');
  }
  const results = JSON.parse(raw);
  if (results === null || typeof results !== 'object' || Array.isArray(results)) {
    throw new Error('required-job results are not a mapping');
  }

  const entries = Object.entries(results);
  if (entries.length === 0) throw new Error('required-job results name no jobs');

  /** @type {Record<string, string>} */
  const failed = {};
  for (const [name, job] of entries) {
    const result = job === null || typeof job !== 'object'
      ? undefined
      : /** @type {Record<string, unknown>} */ (job).result;
    if (typeof result !== 'string') {
      throw new Error(`job '${name}' reports no result field`);
    }
    if (result !== 'success') failed[name] = result;
  }
  return { total: entries.length, failed };
};

const main = () => {
  let ungated = false;
  for (const [workflowPath, terminal] of GATED_WORKFLOWS) {
    const source = readFileSync(workflowPath, 'utf8');
    for (const job of missingTerminalDependencies(source, terminal)) {
      console.error(
        `::error file=${workflowPath}::job '${job}' is absent from ${terminal}'s needs`,
      );
      ungated = true;
    }
  }
  if (ungated) {
    process.exitCode = 1;
    return;
  }

  let outcomes;
  try {
    outcomes = requiredJobOutcomes(process.env.RESULTS);
  } catch (error) {
    console.error(
      `::error::unusable required-job results: ${/** @type {Error} */ (error).message}`,
    );
    process.exitCode = 1;
    return;
  }
  if (Object.keys(outcomes.failed).length > 0) {
    console.error(
      `::error::required jobs did not succeed: ${JSON.stringify(outcomes.failed)}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`CI green: ${outcomes.total} required jobs succeeded.`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
