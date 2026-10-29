/**
 * Detection: rank the registered formats by the evidence an input carries.
 *
 * Each source of evidence adds its weight to a format's score: a magic-byte match adds
 * `weights.magic`, a sniffer adds `weights.sniff` times its confidence, a matching extension
 * adds `weights.extension`, a matching MIME type adds `weights.mime`. The defaults put the
 * content first (magic, then sniffing), the file name next and the declared MIME type last,
 * because a browser's `File.type` is itself guessed from the extension and servers mislabel.
 */
import { essenceOf, extensionOf, head, type Source } from './input.js';
import type { Candidate, FormatDef, Magic, MagicBytes, Weights } from './types.js';

export const DEFAULT_WEIGHTS: Weights = { magic: 1, sniff: 0.8, extension: 0.5, mime: 0.3 };
/** How many leading bytes magic and sniffers see. */
export const DEFAULT_HEAD_SIZE = 4096;

function _bytesOf(m: MagicBytes): ArrayLike<number> {
  if (typeof m !== 'string') return m;
  return Array.from(m, (c) => c.charCodeAt(0) & 0xff);
}

export function matchesMagic(bytes: Uint8Array, magic: Magic | Magic[]): boolean {
  // A two-element numeric array is a signature, not a list of signatures; only arrays of
  // strings/objects/arrays are lists.
  const list: Magic[] =
    Array.isArray(magic) && magic.length > 0 && typeof magic[0] !== 'number' ? (magic as Magic[]) : [magic as Magic];
  return list.some((m) => {
    const { offset = 0, bytes: sig } = typeof m === 'object' && 'bytes' in m ? m : { bytes: m as MagicBytes };
    const want = _bytesOf(sig);
    if (bytes.length < offset + want.length) return false;
    for (let k = 0; k < want.length; k++) if (bytes[offset + k] !== want[k]) return false;
    return true;
  });
}

export function rank(
  source: Source,
  formats: Iterable<FormatDef>,
  { weights = DEFAULT_WEIGHTS, headSize = DEFAULT_HEAD_SIZE }: { weights?: Weights; headSize?: number } = {},
): Candidate[] {
  const h = head(source, headSize);
  const ext = extensionOf(source.filename);
  const mime = essenceOf(source.mimeType);
  const out: Candidate[] = [];
  for (const f of formats) {
    const evidence: Candidate['evidence'] = {};
    if (f.magic && matchesMagic(h.bytes, f.magic)) evidence.magic = weights.magic;
    if (f.sniff) {
      const c = Number(f.sniff(h.bytes, h.text));
      if (c > 0) evidence.sniff = weights.sniff * Math.min(c, 1);
    }
    if (ext && f.extensions?.includes(ext)) evidence.extension = weights.extension;
    if (mime && f.mimeTypes?.includes(mime)) evidence.mime = weights.mime;
    const score = Object.values(evidence).reduce((a, b) => a + b, 0);
    if (score > 0) out.push({ format: f.id, score, evidence });
  }
  return out.sort((a, b) => b.score - a.score); // stable: ties keep registration order
}
