import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const NEED = /^ {6}-\s+([A-Za-z0-9_-]+)\s*$/;

/** @param {string} source @returns {string[]} Top-level workflow job IDs. */
export const workflowJobs = (source) => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) throw new Error('workflow has no top-level jobs mapping');

  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(JOB_KEY);
    if (match) jobs.push(match[1]);
  }
  if (jobs.length === 0) throw new Error('workflow jobs mapping is empty');
  return jobs;
};

/** @param {string} source @returns {string[]} Job IDs required by ci-green. */
export const ciGreenNeeds = (source) => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}ci-green:\s*$/.test(line));
  if (start < 0) throw new Error('workflow has no ci-green job');

  const endOffset = lines.slice(start + 1).findIndex((line) => JOB_KEY.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const block = lines.slice(start + 1, end);
  const needsAt = block.findIndex((line) => /^ {4}needs:\s*/.test(line));
  if (needsAt < 0) throw new Error('ci-green has no needs list');

  const tail = block[needsAt].replace(/^ {4}needs:\s*/, '').trim();
  if (tail !== '') {
    const value = tail.startsWith('[') && tail.endsWith(']')
      ? tail.slice(1, -1)
      : tail;
    return value.split(',').map((job) => job.trim()).filter(Boolean);
  }

  const needs = [];
  for (const line of block.slice(needsAt + 1)) {
    const match = line.match(NEED);
    if (match) {
      needs.push(match[1]);
    } else if (/^ {4}\S/.test(line)) {
      break;
    }
  }
  if (needs.length === 0) throw new Error('ci-green needs list is empty');
  return needs;
};

/** @param {string} source @returns {string[]} Jobs omitted from ci-green. */
export const missingCiGreenDependencies = (source) => {
  const needs = new Set(ciGreenNeeds(source));
  return workflowJobs(source).filter((job) => job !== 'ci-green' && !needs.has(job));
};

const main = () => {
  const workflowPath = '.github/workflows/ci.yml';
  const source = readFileSync(workflowPath, 'utf8');
  const missing = missingCiGreenDependencies(source);
  if (missing.length > 0) {
    for (const job of missing) {
      console.error(
        `::error file=${workflowPath}::job '${job}' is absent from ci-green's needs`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const results = JSON.parse(process.env.RESULTS ?? '');
  const failed = Object.fromEntries(
    Object.entries(results)
      .filter(([, job]) => job.result !== 'success')
      .map(([name, job]) => [name, job.result]),
  );
  if (Object.keys(failed).length > 0) {
    console.error(`::error::required jobs did not succeed: ${JSON.stringify(failed)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`CI green: ${Object.keys(results).length} required jobs succeeded.`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
