// Minimal zero-dependency CLI parser. Supports `--key value` and `--key=value`.
// Returns { ...defaults, ...parsed }.
// A flag with no following value (e.g. a trailing `--key`, or `--key --other`)
// is left unset so the caller's default is preserved rather than clobbered
// with undefined. Use `--key=` for an explicit empty string.
export function parseArgs(argv, defaults = {}) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      parsed[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        parsed[body] = next;
        i++;
      }
      // else: flag with no value, leave unset so the default wins
    }
  }
  return { ...defaults, ...parsed };
}
