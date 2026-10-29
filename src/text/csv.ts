/**
 * Delimiter-separated values (RFC 4180 and its usual relatives), with no dependency.
 *
 * Params: `delimiter` (default `,`), `quote` (`"`), `header` (true: rows are objects keyed by
 * the first row; false: rows are arrays; RFC 4180's `present`/`absent` are accepted too),
 * `newline` (written between rows, `\n`), `columns` (encode: the column order; default every
 * key in order of first appearance). Values are decoded as strings.
 */
import type { Params } from '../types.js';

function _hasHeader(p: Params): boolean {
  return p.header !== false && p.header !== 'absent' && p.header !== 'false';
}

/** Rows of fields, honouring quotes (a doubled quote inside quotes is a literal quote). */
export function parseRows(text: string, { delimiter = ',', quote = '"' }: { delimiter?: string; quote?: string } = {}): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row); // skip blank lines
    row = [];
    field = '';
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
      quoted = true;
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
  if (field !== '' || row.length) endRow();
  return rows;
}

export function decode(text: string, p: Params): string[][] | Record<string, string>[] {
  const rows = parseRows(text, { delimiter: p.delimiter as string, quote: p.quote as string });
  if (!_hasHeader(p)) return rows;
  const [names = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(names.map((n, k) => [n, r[k] ?? ''])));
}

export function encode(value: unknown[], p: Params): string {
  const delimiter = (p.delimiter as string) ?? ',';
  const quote = (p.quote as string) ?? '"';
  const newline = (p.newline as string) ?? '\n';
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(delimiter) || s.includes(quote) || /[\r\n]/.test(s) ? quote + s.split(quote).join(quote + quote) + quote : s;
  };
  const line = (r: unknown[]) => r.map(cell).join(delimiter);
  if (!value.length) return '';
  if (Array.isArray(value[0])) return (value as unknown[][]).map(line).join(newline) + newline;
  const records = value as Record<string, unknown>[];
  const columns = (p.columns as string[] | undefined) ?? [...new Set(records.flatMap((r) => Object.keys(r)))];
  const rows = records.map((r) => line(columns.map((c) => r[c])));
  return (_hasHeader(p) ? [line(columns), ...rows] : rows).join(newline) + newline;
}
