/**
 * Format specs: a format named by a string with MIME-style parameters, or by an object.
 *
 *     parseSpec('csv')                        // { name: 'csv', params: {} }
 *     parseSpec('csv;delimiter=";";header=false')
 *                                             // { name: 'csv', params: { delimiter: ';', header: false } }
 *     parseSpec('text/csv; header=absent')    // { name: 'text/csv', params: { header: 'absent' } }
 *     parseSpec({ id: 'csv', delimiter: '\t' })
 *
 * Parameter values may be quoted (RFC 9110 quoted-string, with backslash escapes); unquoted
 * `true`/`false` and decimal numbers become booleans and numbers, everything else stays a string.
 */
import type { FormatSpec, Params } from './types.js';

export interface ParsedSpec {
  /** An id, an extension or a MIME type, lower-cased; the registry decides which. */
  name: string;
  params: Params;
}

const _NUMBER = /^-?\d+(\.\d+)?$/;

function _coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (_NUMBER.test(raw)) return Number(raw);
  return raw;
}

export function parseSpec(spec: FormatSpec): ParsedSpec {
  if (typeof spec !== 'string') {
    const { id, ...params } = spec;
    return { name: id.toLowerCase(), params };
  }
  const params: Params = {};
  let i = spec.indexOf(';');
  const name = (i < 0 ? spec : spec.slice(0, i)).trim().toLowerCase();
  while (i >= 0 && i < spec.length) {
    i++; // past ';'
    const eq = spec.indexOf('=', i);
    if (eq < 0) break;
    const key = spec.slice(i, eq).trim();
    let j = eq + 1;
    while (spec[j] === ' ') j++;
    let value: unknown;
    if (spec[j] === '"') {
      let out = '';
      j++;
      while (j < spec.length && spec[j] !== '"') {
        if (spec[j] === '\\' && j + 1 < spec.length) j++;
        out += spec[j++];
      }
      value = out;
      i = spec.indexOf(';', j);
    } else {
      const end = spec.indexOf(';', j);
      value = _coerce(spec.slice(j, end < 0 ? undefined : end).trim());
      i = end;
    }
    if (key) params[key] = value;
  }
  return { name, params };
}
