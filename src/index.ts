/**
 * formatcast: resolve and run format conversions, with codecs loaded only when needed.
 *
 *     import { decode, decodeWithInfo, encode, convert, detect, createRegistry } from 'formatcast';
 *
 *     const data = await decode(file);                          // detected: magic, sniff, extension, MIME
 *     const { value, format } = await decodeWithInfo(file);    // ...and which format it was
 *     const rows = await decode(text, { format: 'csv;delimiter=";"' });
 *     const yaml = await encode(data, { format: 'yaml' });
 *     const toml = await convert(file, { to: 'toml' });
 *
 *     const reg = createRegistry({ packs: [myPack], preload: ['midi'] });
 *     const song = await reg.decode(file, { to: 'song' });
 *
 * The functions exported directly use a registry holding the built-in text pack only; make your
 * own with `createRegistry` to register formats.
 */
import { createRegistry } from './registry.js';
import type { ConvertOptions, Decoded, DecodeOptions, EncodeOptions, Hints, Input } from './types.js';

export { createRegistry, definePack, defineFormat } from './registry.js';
export type { Registry, RegistryOptions } from './registry.js';
export { FormatcastError, type ErrorCode, type Attempt } from './errors.js';
export { parseSpec, type ParsedSpec } from './spec.js';
export { matchesMagic, DEFAULT_WEIGHTS, DEFAULT_HEAD_SIZE } from './detect.js';
export { textPack } from './text/index.js';
export type * from './types.js';

let _default: ReturnType<typeof createRegistry> | undefined;
const _registry = () => (_default ??= createRegistry());

export const decode = <T = unknown>(input: unknown, options?: DecodeOptions): Promise<T> => _registry().decode<T>(input, options);
export const decodeWithInfo = <T = unknown>(input: unknown, options?: DecodeOptions): Promise<Decoded<T>> => _registry().decodeWithInfo<T>(input, options);
export const encode = <T = string | Uint8Array>(value: unknown, options: EncodeOptions): Promise<T> => _registry().encode<T>(value, options);
export const convert = <T = string | Uint8Array>(input: Input, options: ConvertOptions): Promise<T> => _registry().convert<T>(input, options);
export const detect = (input: Input, hints?: Hints) => _registry().detect(input, hints);
