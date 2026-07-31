// Shannon entropy over a string's own character distribution, in bits/char.
// Zero dependencies, node:* only. Used by ../generate.mjs to VERIFY — never to
// estimate — every entropy figure quoted in ../secrets/*.json.

/** @param {string} s @returns {number} bits per character; 0 for the empty string */
export function shannonEntropy(s) {
  if (s.length === 0) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Round to 4 decimals the same way every figure in secrets/*.json was produced. */
export function entropy4(s) {
  return Number(shannonEntropy(s).toFixed(4));
}

/**
 * Walk any JSON value and yield every string leaf with a readable location.
 * @param {unknown} node
 * @param {string} path
 * @returns {Generator<{path: string, value: string}>}
 */
export function* walkStrings(node, path = '$') {
  if (typeof node === 'string') {
    yield { path, value: node };
  } else if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* walkStrings(v, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) yield* walkStrings(node[k], `${path}.${k}`);
  }
}

/** The sentinel every synthetic credential value must carry. See ../SECRETS-README.md. */
export const SENTINEL = 'SYNTHETIC';

/**
 * Credential-shaped detector used ONLY to police the sentinel invariant across
 * fixtures/synthetic/. It is deliberately over-eager: its job is to find
 * anything a real scanner might fire on, so `generate.mjs verify` can assert
 * that every such value carries the sentinel. It is NOT a reference
 * implementation of T1.16 — in particular it makes no entropy judgement.
 */
export const CREDENTIAL_SHAPED = new RegExp(
  [
    'sk-[A-Za-z0-9-]{16,}',
    'ghp_[A-Za-z0-9]{20,}',
    'gho_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'xoxb-[0-9]{6,}-[0-9]{6,}-[A-Za-z0-9]{10,}',
    'AKIA[A-Z0-9]{12,}',
    'Bearer [A-Za-z0-9._~+/-]{20,}',
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    'BEGIN [A-Z ]*PRIVATE KEY',
    '[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s/@:"]+:[^\\s/@"]+@',
  ].join('|'),
);
