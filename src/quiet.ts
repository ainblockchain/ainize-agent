/**
 * Imported first by the bins: eccrypto (via ain-util) prints "secp256k1 unavailable, reverting to browser
 * version" to stdout when its native binding is missing, which would corrupt `--json` output. Drop that line.
 */
const NOISE = /secp256k1 unavailable/;
for (const k of ['log', 'info', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => { if (typeof args[0] === 'string' && NOISE.test(args[0])) return; orig(...args); };
}
export {};
