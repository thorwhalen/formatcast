/** Reading inputs: whatever the caller has, as bytes or text plus the hints it carries. */
import { FormatcastError } from './errors.js';
import type { Hints, Input } from './types.js';

export interface Source {
  /** Exactly one of `bytes` and `text` is set. */
  bytes?: Uint8Array;
  text?: string;
  filename?: string;
  mimeType?: string;
}

/** Also true for an ArrayBuffer from another realm (an iframe, a vm context). */
function _isArrayBuffer(x: unknown): x is ArrayBuffer {
  return x instanceof ArrayBuffer || Object.prototype.toString.call(x) === '[object ArrayBuffer]';
}

export function isInput(x: unknown): x is Input {
  return (
    typeof x === 'string' ||
    _isArrayBuffer(x) ||
    ArrayBuffer.isView(x) ||
    (typeof Blob !== 'undefined' && x instanceof Blob)
  );
}

/** Bytes or text from an input; a Blob/File's `name` and `type` fill hints the caller left out. */
export async function readSource(input: Input, hints: Hints = {}): Promise<Source> {
  if (typeof input === 'string') return { text: input, ...hints };
  if (input instanceof Uint8Array) return { bytes: input, ...hints };
  if (_isArrayBuffer(input)) return { bytes: new Uint8Array(input), ...hints };
  if (ArrayBuffer.isView(input)) return { bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength), ...hints };
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const name = (input as { name?: unknown }).name;
    return {
      bytes: new Uint8Array(await _blobBytes(input)),
      filename: hints.filename ?? (typeof name === 'string' && name ? name : undefined),
      mimeType: hints.mimeType ?? (input.type || undefined),
    };
  }
  throw new FormatcastError('BAD_INPUT', `Cannot read input of type ${Object.prototype.toString.call(input)}; pass a string, Uint8Array, ArrayBuffer or Blob`);
}

/** A Blob's bytes; through FileReader where `Blob.arrayBuffer` is missing (jsdom, older browsers). */
function _blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof FileReader === 'undefined') throw new FormatcastError('BAD_INPUT', 'This Blob has no arrayBuffer() and there is no FileReader to read it');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const _BOM = '\uFEFF';

/** Bytes to text (BOM dropped), honouring a `charset` param. */
export function toText(value: string | Uint8Array, charset = 'utf-8'): string {
  if (typeof value === 'string') return value.startsWith(_BOM) ? value.slice(1) : value;
  return new TextDecoder(charset).decode(value);
}

export function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

/** The first `size` bytes, and the same as text when it looks like text (no NUL byte). */
export function head(source: Source, size: number): { bytes: Uint8Array; text?: string } {
  if (source.text !== undefined) {
    const text = toText(source.text.slice(0, size));
    return { bytes: new TextEncoder().encode(text), text };
  }
  const bytes = source.bytes!.subarray(0, size);
  if (bytes.includes(0)) return { bytes };
  // a multi-byte character cut at the boundary decodes to U+FFFD, which no sniffer cares about
  return { bytes, text: new TextDecoder('utf-8').decode(bytes) };
}

/** Lower-case extension of a file name, without the dot ('' when none). */
export function extensionOf(filename: string | undefined): string {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A MIME type without parameters, lower case. */
export function essenceOf(mimeType: string | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}
