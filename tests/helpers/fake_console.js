//
// Console capture: records each call's argument list and the same call joined
// into one string.
import { mock } from 'node:test';

/**
 * Redirects the named console methods into one recording until restore().
 * @param {...string} methods - Console method names, e.g. 'error', 'warn'.
 * @returns {{calls: Array<Array<any>>, messages: Array<string>,
 *   restore: () => void}} The recording and the restore for what was replaced.
 */
export function installConsoleCapture(...methods) {
  const calls = [];
  const messages = [];
  const record = (...args) => {
    calls.push(args);
    messages.push(args.map(String).join(' '));
  };
  const installed = methods.map((name) => mock.method(console, name, record));
  return {
    calls,
    messages,
    restore: () => { for (const installedMethod of installed) installedMethod.mock.restore(); },
  };
}

/**
 * Runs `body` with console.error and console.warn captured.
 * @param {Function} body - Code to run under the capture.
 * @returns {{calls: Array<Array<any>>, messages: Array<string>}} What the two
 *   methods recorded while `body` ran.
 */
export function captureConsole(body) {
  const captured = installConsoleCapture('error', 'warn');
  try {
    body();
  } finally {
    captured.restore();
  }
  return captured;
}
