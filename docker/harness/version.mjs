// Version ordering for minimum requirements and updates. Records keep the
// original strings; ordering understands numeric, prerelease and date versions.

/** Compare numeric releases, prereleases and date versions: -1, 0, or 1. */
export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  const core = compareParts(left.core, right.core);
  if (core !== 0 || !left.numeric || !right.numeric) return core;
  // Build metadata has no precedence, and a stable release follows all its
  // prereleases. A preview must never look newer than the stable release.
  if (left.pre === null) return right.pre === null ? 0 : 1;
  if (right.pre === null) return -1;
  return compareParts(left.pre, right.pre, true);
}

function compareParts(left, right, prerelease = false) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (prerelease && oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1;
    if (oneNumeric && twoNumeric) {
      const diff = Number(one) - Number(two);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (one !== two) {
      return one < two ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `version` is at least `minimum`. Null minimum means no constraint. */
export function meetsMinimum(version, minimum) {
  if (!minimum) return true;
  if (!version) return null;
  return compareVersions(version, minimum) >= 0;
}

function parse(value) {
  const text = String(value ?? "").trim().replace(/^v/i, "");
  const numeric = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  return numeric
    ? { numeric: true, core: numeric[1].split("."), pre: numeric[2]?.split(".") ?? null }
    : { numeric: false, core: text.split(/[.+-]/).filter(Boolean), pre: null };
}
