// util.js
export const permute_pairwise = (list) => {
  if (list.length < 2) {
    return [];
  }
  let a = list[0];
  let rest = list.slice(1);
  let pairs = rest.map((i) => [a, i]);
  return pairs.concat(permute_pairwise(rest));
}

export const distance_between = (a, b) => {
  return Math.sqrt(
    Math.pow(b[0] - a[0], 2)
    + Math.pow(b[1] - a[1], 2)
    + Math.pow(b[2] - a[2], 2)
  );
}
export function dir(v) { return v < 0 ? -1 : 1; }

export function wrap(x, m) {
  return x >= 0 ? x % m : ((x % m) + m) % m;
}

export function shortest_distance(x1, x2, m) {
  let d = Math.abs(x1 - x2) % m;
  return Math.min(d, m - d);
}

export function fwd_distance(a, b, m) {
  let diff = b - a;
  if (diff < 0) {
    diff += m;
  }
  return diff;
}

export const randomChoice = (choices) => {
  if (choices.length == 0) {
    return undefined;
  }
  return choices[Math.floor(Math.random() * choices.length)];
}
export function randomBetween(a, b) {
  return Math.random() * (b - a) + a;
}
