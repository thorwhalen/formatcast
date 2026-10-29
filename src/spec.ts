/**
 * Format specs: a format named by a string with MIME-style parameters, or by an object.
 *
 *     parseSpec('csv')                        // { name: 'csv', params: {} }
 *     parseSpec('csv;delimiter=";";header=false')
 *                                             // { name: 'csv', params: { delimiter: ';', header: false } }
 *     parseSpec('text/csv; header=absent')    // { name: 'text/csv', params: { header: 'absent' } }
 *     parseSpec({ id: 'csv', delimiter: '\t' })
 *
 * Parameters are separated by `;` (outside quotes). A value may be quoted (RFC 9110
 * quoted-string) and inside quotes `\t`, `\n`, `\r` are a tab, a newline and a carriage return
 * and a backslash escapes any other character. A bare key (`csv;strict`) is `true`; unquoted
 * `true` and `false` are booleans. Every other value stays a string: each codec reads its own
 * params, so `header=0` or `version=1.0` are not second-guessed here.
 */
import type { FormatSpec, Params } from './types.js';

export interface ParsedSpec {
  /** An id, an extension or a MIME type, lower-cased; the registry decides which. */
  name: string;
  params: Params;
}

const _ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r' };

/** Split on `;` outside double quotes, keeping the quotes for the value parser. */
function _segments(spec: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (quoted && c === '\\' && i + 1 < spec.length) {
      cur += c + spec[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function _value(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = '';
    for (let i = 1; i < v.length && v[i] !== '"'; i++) {
      if (v[i] === '\\' && i + 1 < v.length) {
        const e = v[++i];
        out += _ESCAPES[e] ?? e;
      } else out += v[i];
    }
    return out;
  }
  return v === 'true' ? true : v === 'false' ? false : v;
}

export function parseSpec(spec: FormatSpec): ParsedSpec {
  if (typeof spec !== 'string') {
    const { id, ...params } = spec;
    return { name: id.toLowerCase(), params };
  }
  const [name, ...rest] = _segments(spec);
  const params: Params = {};
  for (const seg of rest) {
    const eq = seg.indexOf('=');
    const key = (eq < 0 ? seg : seg.slice(0, eq)).trim();
    if (key) params[key] = eq < 0 ? true : _value(seg.slice(eq + 1));
  }
  return { name: name.trim().toLowerCase(), params };
}
