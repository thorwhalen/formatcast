/**
 * Delimiter-separated values (RFC 4180 and its usual relatives), with no dependency.
 *
 * Params: `delimiter` (default `,`, any non-empty string), `quote` (`"`, one character),
 * `header` (true: rows are objects keyed by the first row; false: rows are arrays; RFC 4180's
 * `present`/`absent` are accepted too), `strict` (true: an unterminated quote, or a row with more
 * fields than the header, is an error rather than silently lost data), `newline` (written between
 * rows, `\n`), `columns` (encode: the column order; default every key in order of first
 * appearance). Values are decoded as strings; objects are encoded as JSON.
 */
import { FormatcastError } from '../errors.js';
import type { Params } from '../types.js';

const _NO_HEADER = new Set<unknown>([false, 'false', 'absent', '0', 0]);
const _NOT_STRICT = new Set<unknown>([false, 'false', '0', 0]);

function _options(p: Params): { delimiter: string; quote: string; header: boolean; strict: boolean } {
  const { delimiter = ',', quote = '"' } = p;
  if (typeof delimiter !== 'string' || !delimiter) throw new FormatcastError('BAD_INPUT', `csv: delimiter must be a non-empty string, got ${JSON.stringify(delimiter)}`);
  if (typeof quote !== 'string' || quote.length !== 1) throw new FormatcastError('BAD_INPUT', `csv: quote must be one character, got ${JSON.stringify(quote)}`);
  if (delimiter.includes(quote)) throw new FormatcastError('BAD_INPUT', 'csv: the delimiter cannot contain the quote character');
  return { delimiter, quote, header: !_NO_HEADER.has(p.header), strict: !_NOT_STRICT.has(p.strict) };
}

/** Rows of fields, honouring quotes (a doubled quote inside quotes is a literal quote). Blank lines are skipped. */
export function parseRows(text: string, { delimiter = ',', quote = '"', strict = true }: { delimiter?: string; quote?: string; strict?: boolean } = {}): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== '' || wasQuoted) rows.push(row);
    row = [];
    field = '';
    wasQuoted = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
    } else if (c === quote && field === '') {
      quoted = wasQuoted = true;
      i++;
    } else if (text.startsWith(delimiter, i)) {
      row.push(field);
      field = '';
      i += delimiter.length;
    } else if (c === '\n' || c === '\r') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted && strict) throw new FormatcastError('BAD_INPUT', `csv: unterminated quoted field in row ${rows.length + 1}`);
  if (field !== '' || row.length || wasQuoted) endRow();
  return rows;
}

export function decode(text: string, p: Params): string[][] | Record<string, string>[] {
  const o = _options(p);
  const rows = parseRows(text, o);
  if (!o.header) return rows;
  const [names = [], ...body] = rows;
  return body.map((r, k) => {
    if (o.strict && r.length > names.length)
      throw new FormatcastError('BAD_INPUT', `csv: row ${k + 2} has ${r.length} fields but the header has ${names.length} (pass strict=false to drop the extra ones)`);
    return Object.fromEntries(names.map((n, j) => [n, r[j] ?? '']));
  });
}

export function encode(value: unknown, p: Params): string {
  if (!Array.isArray(value))
    throw new FormatcastError('BAD_INPUT', `csv encodes an array of rows (objects or arrays), got ${value === null ? 'null' : typeof value}`);
  const { delimiter, quote, header } = _options(p);
  const newline = (p.newline as string) ?? '\n';
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.includes(delimiter) || s.includes(quote) || /[\r\n]/.test(s) ? quote + s.split(quote).join(quote + quote) + quote : s;
  };
  const line = (r: unknown[]) => r.map(cell).join(delimiter);
  if (!value.length) return '';
  if (Array.isArray(value[0])) return (value as unknown[][]).map(line).join(newline) + newline;
  const records = value as Record<string, unknown>[];
  const columns = (p.columns as string[] | undefined) ?? [...new Set(records.flatMap((r) => Object.keys(r)))];
  const rows = records.map((r) => line(columns.map((c) => r[c])));
  return (header ? [line(columns), ...rows] : rows).join(newline) + newline;
}
