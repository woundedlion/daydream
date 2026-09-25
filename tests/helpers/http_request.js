import { get as httpGet } from 'node:http';

/** Fetches one test-server path without pooling a socket across fixture lifetimes. */
export const request = (origin, path) => new Promise((done, fail) => {
  httpGet(`${origin}${path}`, { agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => done({
      status: res.statusCode ?? 0,
      type: res.headers['content-type'],
      body,
    }));
  }).on('error', fail);
});
