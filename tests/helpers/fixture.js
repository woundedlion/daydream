import {readFileSync} from 'node:fs';

export const fixture = name => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').trimEnd();
