/**
 * The built-in text pack: json, ndjson, yaml, toml, csv and tsv, all decoding to plain data.
 *
 * Only descriptors live here (a few hundred bytes); the csv, yaml and toml codecs are separate
 * modules imported the first time they are needed, and yaml/toml pull their parser package
 * (`yaml`, `smol-toml`) only then.
 */
import type { Pack, Params } from '../types.js';

const _lines = (text: string | undefined) => (text ?? '').split(/\r?\n/).filter((l) => l.trim());

/** Every line but a possibly truncated last one has the same, non-zero count of `delimiter`. */
function _consistentDelimiter(text: string | undefined, delimiter: string): boolean {
  const lines = _lines(text).slice(0, 10);
  if (lines.length < 2) return false;
  const counts = lines.slice(0, -1).map((l) => l.split(delimiter).length - 1);
  return counts[0] > 0 && counts.every((c) => c === counts[0]);
}

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
      encode: (value, p: Params) => JSON.stringify(value, null, p.indent as number),
    },
    {
      id: 'ndjson',
      label: 'Newline-delimited JSON',
      extensions: ['ndjson', 'jsonl'],
      mimeTypes: ['application/x-ndjson', 'application/jsonl'],
      sniff: (_, text) => {
        const lines = _lines(text).slice(0, -1);
        return lines.length >= 2 && lines.every((l) => /^\s*[{[].*[}\]]\s*$/.test(l)) ? 0.9 : 0;
      },
      decode: (text: string) => _lines(text).map((l) => JSON.parse(l)),
      encode: (value: unknown[]) => value.map((v) => JSON.stringify(v)).join('\n') + '\n',
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
      encodes: true,
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
        return /^\s*[\w"'.-]+\s*=\s*\S/m.test(t) ? 0.5 : 0;
      },
      requires: ['smol-toml'],
      encodes: true,
      load: () => import('./toml.js'),
    },
    {
      id: 'csv',
      label: 'Delimiter-separated values',
      extensions: ['csv'],
      mimeTypes: ['text/csv'],
      params: { delimiter: ',', quote: '"', header: true, newline: '\n' },
      sniff: (_, text) => (_consistentDelimiter(text, ',') ? 0.4 : 0),
      encodes: true,
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
