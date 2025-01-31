const permute_pairwise = (list) => {
  if (list.length < 2) {
    return [];
  }
  let a = list[0];
  let rest = list.slice(1);
  let pairs = rest.map((i) => [a, i]);
  return pairs.concat(permute_pairwise(rest));
}

const distance_between = (a, b) => {
  return Math.sqrt(
    Math.pow(b[0] - a[0], 2)
    + Math.pow(b[1] - a[1], 2)
    + Math.pow(b[2] - a[2], 2)
  );
}
