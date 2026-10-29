# formatcast

Resolve and run format conversions in JavaScript: find the right decoder or encoder from an explicit format spec, the file extension, the MIME type or the first bytes, route through as many codecs as it takes, and load each codec only when a request needs it.

```bash
npm install formatcast
```

```js
import { decode, decodeWithInfo, encode, convert } from 'formatcast';

const data = await decode(file);                        // a File, Blob, string, Uint8Array or ArrayBuffer
const { value, format } = await decodeWithInfo(file);   // ...and which format it turned out to be
const yaml = await encode(data, { format: 'yaml' });
const toml = await convert(file, { to: 'toml' });
```

Headless, pure ESM, works in browsers and Node 18+. The core is about 5 kB gzipped; the built-in codecs for CSV, YAML and TOML are separate modules that are imported the first time a CSV, YAML or TOML file actually shows up (with Vite, Rollup, esbuild or webpack they become their own lazy chunks).

## Why

An app usually has one internal shape for something (a game spec, a song, a dataset) and wants to import and export it in "general" formats. The format-specific code is easy; what gets rewritten every time is the plumbing around it: guessing the format from what the user dropped, passing format parameters (a CSV delimiter), loading a heavy parser only when needed, and chaining steps (unzip, then parse, then map to the app's schema). formatcast is that plumbing, once.

## Formats out of the box

| id | extensions | MIME types | decodes to | codec |
| --- | --- | --- | --- | --- |
| `json` | json | application/json | data | native |
| `ndjson` | ndjson, jsonl | application/x-ndjson | array | native |
| `yaml` | yaml, yml | application/yaml, text/yaml | data | [`yaml`](https://www.npmjs.com/package/yaml), lazy |
| `toml` | toml | application/toml | data | [`smol-toml`](https://www.npmjs.com/package/smol-toml), lazy |
| `csv` | csv | text/csv | rows | built-in, lazy |
| `tsv` | tsv, tab | text/tab-separated-values | rows | `csv` with `delimiter=\t` |

All of them encode as well as decode.

## Format specs and parameters

Wherever a format is named, it can be an id, an extension, a MIME type, any of those with MIME-style parameters, or an object:

```js
await decode(text, { format: 'csv' });
await decode(text, { format: 'csv;delimiter=";";header=false' });
await decode(text, { format: 'csv;delimiter="\\t"' });          // \t, \n, \r inside quotes
await decode(text, { format: 'text/csv; header=absent' });
await decode(text, { format: { id: 'csv', delimiter: '|' } });
await encode(data, { format: 'json;indent=0' });
```

An explicit format always wins over detection. A bare key (`csv;strict`) means `true`, unquoted `true` and `false` are booleans, and every other value is passed to the codec as a string. Parameters on a MIME type hint (`text/csv; charset=iso-8859-1`) apply to the format that MIME type names.

## Detection

Without an explicit format, every registered format is scored by the evidence the input carries, and decoding tries the candidates best first:

| evidence | weight (default) | from |
| --- | --- | --- |
| magic bytes | 1 | the format's `magic` signature(s) at the start of the bytes |
| sniff | 0.8 × confidence | the format's `sniff(head, text)` function |
| extension | 0.5 | `filename`, or a `File`'s name |
| MIME type | 0.3 | `mimeType`, or a `Blob`'s type |

Content beats the name, and the name beats the declared type (a browser's `File.type` is itself guessed from the extension). When the best candidate fails to decode, the next one is tried, but only if it carries all of the best one's hard evidence (magic, extension, MIME type): a broken `config.toml` fails with the TOML parser's error instead of coming back as CSV rows. If every eligible candidate fails, the error lists each attempt. Ties go to the format registered last, so a consumer's format wins over a built-in one. `detect(input, hints)` returns the ranked candidates without decoding; `createRegistry({ weights, headSize })` changes the scoring.

## Your own formats: packs

```js
import { createRegistry, definePack } from 'formatcast';

const musicPack = definePack({
  name: 'music',
  formats: [
    {
      id: 'midi', binary: true, extensions: ['mid', 'midi'], mimeTypes: ['audio/midi'],
      magic: 'MThd', kind: 'song',
      requires: ['@tonejs/midi'],
      load: () => import('./codecs/midi.js'),   // exports decode(bytes, params, ctx)
      encodes: false,                            // ...and no encode: no route will count on one
    },
    {
      id: 'mxl', binary: true, extensions: ['mxl'], kind: 'musicxml',  // unzips to another format
      // a zip's first entry here is the `mimetype` file, so its content is inside the head
      sniff: (head) => new TextDecoder().decode(head.subarray(0, 100)).includes('application/vnd.recordare.musicxml'),
      load: () => import('./codecs/mxl.js'),
    },
    {
      id: 'musicxml', extensions: ['musicxml', 'xml'], kind: 'song',
      sniff: (head, text) => /<score-(partwise|timewise)/.test(text ?? ''),
      load: () => import('./codecs/musicxml.js'),
    },
  ],
});

const formats = createRegistry({ packs: [musicPack], preload: ['midi'] });
const song = await formats.decode(file, { to: 'song' });
```

A format definition:

| field | meaning |
| --- | --- |
| `id` | unique name; registering an id again merges into the existing definition (pass only a codec to swap the YAML library and keep its detection; `replace: true` starts over) |
| `kind` | what `decode` produces and `encode` consumes; default `'data'`; may be another format's id |
| `binary` | the codec gets and returns `Uint8Array` (default: text, a `string`, decoded as UTF-8 or the `charset` param) |
| `extensions`, `mimeTypes` | lower case, no dot, no parameters |
| `magic` | a signature (string, byte array, or `{ offset, bytes }`) or a list of them |
| `sniff(head, text)` | confidence in [0, 1] or a boolean; `text` is the head as text when it has no NUL byte |
| `params` | default parameters, overridden by the request's |
| `decode`, `encode` | inline codec functions `(value, params, ctx)` |
| `load` | lazy codec: `() => import(...)` of a module exporting `decode` and/or `encode`; called once, on first use |
| `decodes`, `encodes` | with `load`: set `false` for a direction the module does not provide, so no route counts on it (default: both) |
| `requires` | npm packages `load` needs; when one of them is not installed, the error says what to `npm install` |
| `extends` | another format's id: inherit its codec, kind and params (`tsv` is `csv` with a tab) |
| `cost` | route cost of this format's edges (default 1) |

A pack can also hold `transforms`, edges between kinds that are not formats: `{ from: 'data', to: 'song', cost: 2, convert(value, params, ctx) }` (or `load` for a lazy one).

## Routes

Every format is two edges in a graph, `id → kind` (decode) and `kind → id` (encode); transforms are further edges. A request is a route from a source to a target, and formatcast takes the cheapest one, so chains need no special code:

```js
await formats.decode(mxlFile, { to: 'song' });         // mxl → musicxml → song
await convert(yamlText, { to: 'toml' });               // yaml → data → toml
formats.route('mxl', 'song');                          // the steps, as data
const plan = await formats.resolve(file, { to: 'song' });   // detect and route, without running
plan.format; plan.route; await plan.run();
```

Format parameters apply to the step that runs that format's codec: the source format's to the first decode, the target's to the final encode; intermediate formats use their defaults.

`decode` without `to` decodes to the format's kind, following through container formats (an `mxl` file ends as a song, not as MusicXML text). `decode(value, { format: 'data', to: 'song' })` runs a route from an in-memory value.

## Loading

Nothing a codec needs is imported until a request routes through it. To pay the cost up front instead, pass `preload: ['yaml', 'midi']` to `createRegistry` (and `await registry.ready` if you want to know it is done) or call `await registry.preload(['yaml'])`.

## Errors

Everything throws a `FormatcastError` with a `code`: `NO_FORMAT` (nothing detected, or an unknown spec), `NO_ROUTE`, `NO_CODEC`, `MISSING_DEPENDENCY` (the message says what to `npm install`), `DECODE_FAILED` (with `attempts`: every candidate tried and why it failed), `BAD_INPUT` (an unreadable input, or a value or params a codec refuses, such as a CSV delimiter that is empty).

## CSV parameters

`delimiter` (`,`, any non-empty string), `quote` (`"`), `header` (`true`: rows are objects keyed by the first row; `false` or RFC 4180's `absent`: rows are arrays), `strict` (`true`: an unterminated quote or a row with more fields than the header is an error, not silently lost data), `newline` (`\n`, for encoding), `columns` (encoding: the column order). Values decode as strings; objects encode as JSON.

## Design

formatcast is a JavaScript cousin of [castgraph](https://github.com/i2mint/i2) (kinds, cost-weighted edges, multi-hop routing, a context side channel) and of [dol](https://github.com/i2mint/dol)'s codecs (encoder/decoder pairs, parameterised codecs), with the detection model of loaders.gl, shared-mime-info and libmagic. The research behind the design is in [docs/](docs/).

## License

Apache-2.0
