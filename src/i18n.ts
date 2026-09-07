/**
 * The agent's i18n, mirroring `packages/web/src/i18n`'s `Dict = { ko, en }` shape and its per-module file split so
 * two workstreams never edit one string file. There is no framework here: a CLI has one locale for the life of the
 * process, chosen from the environment, and a translator is a closure over a plain object.
 *
 * Korean is written as Korean. The web's particle resolver (을/를, 이/가, (으)로) is deliberately NOT copied — a
 * hundred lines of Hangul phonology to serve four string files is the wrong trade, so the Korean here is phrased so
 * no particle ever follows an interpolated value.
 */
export type Locale = 'ko' | 'en';
export type Dict = Record<string, { ko: string; en: string }>;

/** `AINIZE_LOCALE` first (explicit), then the shell's own `LC_ALL`/`LANG`. English otherwise — Ainize is English-first. */
export function agentLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const v = (env.AINIZE_LOCALE ?? env.LC_ALL ?? env.LANG ?? '').toLowerCase();
  return v.startsWith('ko') ? 'ko' : 'en';
}

/** Interpolate `{name}` placeholders; an unknown name is left visible rather than silently becoming "undefined". */
export function fmt(s: string, vars?: Record<string, string | number>): string {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`)) : s;
}

export type T<D extends Dict> = (key: keyof D & string, vars?: Record<string, string | number>) => string;

/** A translator bound to one dictionary and one locale. A missing key returns the key, never an empty line. */
export function translator<D extends Dict>(dict: D, locale: Locale = agentLocale()): T<D> {
  return (key, vars) => {
    const e = dict[key];
    return e ? fmt(e[locale], vars) : key;
  };
}
