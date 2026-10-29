/**
 * The built-in text pack: json, ndjson, yaml, toml, csv and tsv, all decoding to plain data.
 *
 * Only descriptors live here (a few hundred bytes); the csv, yaml and toml codecs are separate
 * modules imported the first time they are needed, and yaml/toml pull their parser package
 * (`yaml`, `smol-toml`) only then.
 */
import { FormatcastError } from '../errors.js';
import type { Pack, Params } from '../types.js';

function _array(value: unknown, format: string): unknown[] {
  if (!Array.isArray(value)) throw new FormatcastError('BAD_INPUT', `${format} encodes an array (one item per line), got ${typeof value}`);
  return value;
}

const _lines = (text: string | undefined) => (text ?? '').split(/\r?\n/).filter((l) => l.trim());

/** Whether `ok` holds for at least two lines and every line, except perhaps a last one cut off by the head. */
function _allLines(lines: string[], ok: (line: string) => boolean): boolean {
  return lines.length >= 2 && (lines.every(ok) || lines.slice(0, -1).every(ok));
}

/** The first lines share the same non-zero count of `delimiter`. */
function _consistentDelimiter(text: string | undefined, delimiter: string): boolean {
  const lines = _lines(text).slice(0, 10);
  const count = (l: string) => l.split(delimiter).length - 1;
  const first = lines.length ? count(lines[0]) : 0;
  return first > 0 && _allLines(lines, (l) => count(l) === first);
}

function _isJsonContainer(line: string): boolean {
  if (!/^\s*[{[]/.test(line)) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** A whole line that is a TOML key/value pair whose value is a TOML value (so `bpm=100 C4 D4` is not one). */
const _TOML_PAIR = /^\s*[\w"'.-]+\s*=\s*("[^"]*"|'[^']*'|[+-]?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|inf|nan)|true|false|\d{4}-\d{2}-\d{2}[\dT:.Z+ -]*|[[{].*)\s*(#.*)?$/m;

/** An `indent` param from a spec string arrives as text: digits mean spaces, anything else is the indent string. */
const _indent = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : (v as number | string | undefined));

export const textPack: Pack = {
  name: 'text',
  formats: [
    {
      id: 'json',
      label: 'JSON',
      extensions: ['json'],
      mimeTypes: ['application/json', 'text/json'],
      params: { indent: 2 },
      sniff: (_, text) => (/^\s*(\{|\[\s*([[\]{"\d-]|true|false|null))/.test(text ?? '') ? 0.6 : 0),
      decode: (text: string) => JSON.parse(text),
      encode: (value, p: Params) => JSON.stringify(value, null, _indent(p.indent)),
    },
    {
      id: 'ndjson',
      label: 'Newline-delimited JSON',
      extensions: ['ndjson', 'jsonl'],
      mimeTypes: ['application/x-ndjson', 'application/jsonl'],
      sniff: (_, text) => (_allLines(_lines(text), _isJsonContainer) ? 0.9 : 0),
      decode: (text: string) => _lines(text).map((l) => JSON.parse(l)),
      encode: (value: unknown[]) => _array(value, 'ndjson').map((v) => JSON.stringify(v)).join('\n') + '\n',
    },
    {
      id: 'yaml',
      label: 'YAML',
      extensions: ['yaml', 'yml'],
      mimeTypes: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'],
      sniff: (_, text) => {
        const t = text ?? '';
        if (/^(%YAML|---)/.test(t)) return 0.7;
        if (/^[\w"'-][^:\n]*:(\s|$)/m.test(t)) return 0.4;
        return /^- /m.test(t) ? 0.3 : 0;
      },
      requires: ['yaml'],
      load: () => import('./yaml.js'),
    },
    {
      id: 'toml',
      label: 'TOML',
      extensions: ['toml'],
      mimeTypes: ['application/toml'],
      sniff: (_, text) => {
        const t = text ?? '';
        if (/^\s*\[{1,2}[\w"'. -]+\]{1,2}\s*$/m.test(t)) return 0.7;
        return _TOML_PAIR.test(t) ? 0.5 : 0;
      },
      requires: ['smol-toml'],
      load: () => import('./toml.js'),
    },
    {
      id: 'csv',
      label: 'Delimiter-separated values',
      extensions: ['csv'],
      mimeTypes: ['text/csv'],
      params: { delimiter: ',', quote: '"', header: true, newline: '\n', strict: true },
      sniff: (_, text) => (_consistentDelimiter(text, ',') ? 0.4 : 0),
      load: () => import('./csv.js'),
    },
    {
      id: 'tsv',
      extends: 'csv',
      label: 'Tab-separated values',
      extensions: ['tsv', 'tab'],
      mimeTypes: ['text/tab-separated-values'],
      params: { delimiter: '\t' },
      sniff: (_, text) => (_consistentDelimiter(text, '\t') ? 0.5 : 0),
    },
  ],
};
