/**
 * The vocabulary of formatcast, as types.
 *
 * - A **kind** is any string naming a representation: a format id (`'yaml'`, `'midi'`) is a
 *   kind whose values are serialized (a string, or bytes for a binary format); `'data'` (plain
 *   JS values) or an app's own `'song'` are in-memory kinds.
 * - A **format** is a kind that can be *detected* (extension, MIME type, magic bytes, sniff) and
 *   that has a codec: its `decode` is the graph edge `id → kind`, its `encode` is `kind → id`.
 * - A **transform** is any other edge, `from → to`. Decoding and converting follow the cheapest
 *   path of edges, so `mxl → musicxml → song` or `json → data → yaml` need no special code.
 * - A **pack** is a list of formats and transforms that a consumer registers as one unit.
 */

/** A representation name: a format id, or an in-memory kind such as `'data'`. */
export type Kind = string;

/** Codec parameters: a format's defaults, overridden by the ones a request gives. */
export type Params = Record<string, unknown>;

/** What every edge function receives besides its value and params. */
export interface Ctx {
  /** The file name the input came with, if any. */
  filename?: string;
  /** The MIME type the input came with, if any. */
  mimeType?: string;
  /** Whatever the caller passed as `context`: a side channel for flags, handles, caches. */
  context?: unknown;
}

export type Decoder = (input: any, params: Params, ctx: Ctx) => unknown;
export type Encoder = (value: any, params: Params, ctx: Ctx) => unknown;
export type Converter = (value: any, params: Params, ctx: Ctx) => unknown;

/** What a format's `load()` resolves to (a module, or its `default` export). */
export interface CodecModule {
  decode?: Decoder;
  encode?: Encoder;
}

/** Bytes at a fixed offset: a string (latin-1 characters) or byte values. */
export type MagicBytes = string | ArrayLike<number>;
export type Magic = MagicBytes | { offset?: number; bytes: MagicBytes };

export interface FormatDef {
  /** Unique id; registering the same id again replaces the earlier definition. */
  id: string;
  /** The kind `decode` produces and `encode` consumes. Default `'data'`. */
  kind?: Kind;
  /** True when the serialized form is bytes (`Uint8Array`), false (default) for text (`string`). */
  binary?: boolean;
  /** File extensions without the dot, lower case: `['yaml', 'yml']`. */
  extensions?: string[];
  /** MIME types, lower case, without parameters: `['application/yaml']`. */
  mimeTypes?: string[];
  /** Signature(s) at the start of the bytes; any match counts as magic evidence. */
  magic?: Magic | Magic[];
  /** Confidence in [0, 1] (or a boolean) that `head` is this format; `text` is the head as text when it looks like text. */
  sniff?: (head: Uint8Array, text: string | undefined) => number | boolean;
  /** Default params, overridden by the request's. */
  params?: Params;
  /** Inherit `kind`, `binary`, `params`, the codec and `cost` from another format id (a parameterised alias). */
  extends?: string;
  decode?: Decoder;
  encode?: Encoder;
  /** With `load`: set false when the module has no `decode`, so no route counts on it. Default true. */
  decodes?: boolean;
  /** With `load`: set false when the module has no `encode`, so no route counts on it. Default true. */
  encodes?: boolean;
  /** When this id is already registered: true replaces the old definition; by default the new fields are merged into it (a new codec replaces the old codec as a whole). */
  replace?: boolean;
  /** Lazy codec: called (once, cached) only when the codec is first needed. */
  load?: () => Promise<CodecModule | { default: CodecModule }>;
  /** npm packages `load` needs, named in the error when they are missing. */
  requires?: string[];
  /** Route cost of this format's decode and encode edges. Default 1. */
  cost?: number;
  /** Human-readable name. */
  label?: string;
}

export interface TransformDef {
  from: Kind;
  to: Kind;
  /** Route cost (raise it for lossy or slow edges). Default 1. */
  cost?: number;
  /** Default params passed to `convert`. */
  params?: Params;
  convert?: Converter;
  load?: () => Promise<{ convert?: Converter; default?: Converter }>;
  requires?: string[];
}

export interface Pack {
  name?: string;
  formats?: FormatDef[];
  transforms?: TransformDef[];
}

/** A format named by id, extension or MIME type, optionally with params:
 *  `'csv'`, `'yml'`, `'csv;delimiter=";";header=false'`, `'text/csv; header=absent'`,
 *  or `{ id: 'csv', delimiter: ';' }`. */
export type FormatSpec = string | ({ id: string } & Params);

/** What decode, detect and convert accept. A `Blob`/`File` contributes its name and type as hints. */
export type Input = string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

export interface Hints {
  filename?: string;
  mimeType?: string;
}

export type EvidenceSource = 'explicit' | 'magic' | 'sniff' | 'extension' | 'mime';

export interface Candidate {
  format: string;
  score: number;
  evidence: Partial<Record<EvidenceSource, number>>;
}

/** One step of a route, as data. */
export interface Step {
  from: Kind;
  to: Kind;
  cost: number;
  /** The format whose codec runs, for decode/encode steps. */
  format?: string;
  op: 'decode' | 'encode' | 'transform';
}

export interface DecodeOptions extends Hints {
  /** The input's format, bypassing detection. A kind that is not a format means "the input already is a value of this kind". */
  format?: FormatSpec;
  /** Target kind or format. Default: the detected format's own kind. */
  to?: FormatSpec;
  context?: unknown;
}

export interface EncodeOptions {
  /** Target format (required). */
  format: FormatSpec;
  /** The value's kind. Default: the target format's kind. */
  from?: Kind;
  context?: unknown;
}

export interface ConvertOptions extends Hints {
  /** Target format (required). */
  to: FormatSpec;
  /** Source format, bypassing detection. */
  from?: FormatSpec;
  context?: unknown;
}

/** What `decodeWithInfo` returns: the value, and the format and route that produced it. */
export interface Decoded<T = unknown> {
  value: T;
  format: string;
  route: Step[];
  candidate: Candidate;
}

/** A resolved decode: which format, which route; `run()` executes it. */
export interface Plan {
  format: string;
  candidate: Candidate;
  route: Step[];
  run(): Promise<unknown>;
}

export interface Weights {
  magic: number;
  sniff: number;
  extension: number;
  mime: number;
}
