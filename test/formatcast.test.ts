import { describe, expect, it, vi } from 'vitest';
import { convert, createRegistry, decode, decodeWithInfo, definePack, detect, encode, FormatcastError, parseSpec } from '../src/index.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('parseSpec', () => {
  it('reads ids, MIME types and params', () => {
    expect(parseSpec('CSV')).toEqual({ name: 'csv', params: {} });
    expect(parseSpec('csv;delimiter=";";header=false')).toEqual({ name: 'csv', params: { delimiter: ';', header: false } });
    expect(parseSpec('text/csv; header=absent; n=3')).toEqual({ name: 'text/csv', params: { header: 'absent', n: '3' } });
    expect(parseSpec('x;q="a\\"b"')).toEqual({ name: 'x', params: { q: 'a"b' } });
    expect(parseSpec('csv;strict;delimiter="\\t";q="a;b=c"')).toEqual({ name: 'csv', params: { strict: true, delimiter: '\t', q: 'a;b=c' } });
    expect(parseSpec({ id: 'csv', delimiter: '\t' })).toEqual({ name: 'csv', params: { delimiter: '\t' } });
  });
});

describe('the default registry (text pack)', () => {
  it('detects by content, extension and MIME type', async () => {
    expect((await detect('{"a": 1}'))[0].format).toBe('json');
    expect((await detect('[tool]\nname = "x"\n'))[0].format).toBe('toml');
    expect((await detect('a: 1\nb: [2, 3]\n'))[0].format).toBe('yaml');
    expect((await detect('a,b\n1,2\n3,4\n'))[0].format).toBe('csv');
    expect((await detect('a\tb\n1\t2\n3\t4\n'))[0].format).toBe('tsv');
    expect((await detect('{"a":1}\n{"a":2}\n{"a":3}\n'))[0].format).toBe('ndjson');
    expect((await detect('{"a":1}\n{"a":2}\n'))[0].format).toBe('ndjson');
    expect((await detect('anything', { filename: 'x.yml' }))[0].format).toBe('yaml');
    expect((await detect('anything', { mimeType: 'application/toml; charset=utf-8' }))[0].format).toBe('toml');
  });

  it('decodes each built-in format', async () => {
    expect(await decode('{"a": [1, 2]}')).toEqual({ a: [1, 2] });
    expect(await decode('a: 1\nb: [2, 3]\n', { filename: 'x.yaml' })).toEqual({ a: 1, b: [2, 3] });
    expect(await decode('[t]\nn = 1\n')).toEqual({ t: { n: 1 } });
    expect(await decode('a,b\n1,"x, ""y"""\n')).toEqual([{ a: '1', b: 'x, "y"' }]);
    expect(await decode('a\tb\n1\t2\n', { filename: 'x.tsv' })).toEqual([{ a: '1', b: '2' }]);
    expect(await decode('{"a":1}\n{"a":2}\n', { format: 'jsonl' })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reads bytes, ArrayBuffers and Blobs, using a File name as a hint', async () => {
    expect(await decode(bytes('\uFEFF{"a":1}'))).toEqual({ a: 1 });
    expect(await decode(bytes('{"a":1}').buffer)).toEqual({ a: 1 });
    const file = new File(['k: v\n'], 'spec.yaml', { type: '' });
    expect(await decode(file)).toEqual({ k: 'v' });
  });

  it('takes params from the format spec', async () => {
    expect(await decode('a;b\n1;2\n', { format: 'csv;delimiter=";"' })).toEqual([{ a: '1', b: '2' }]);
    expect(await decode('1,2\n3,4\n', { format: 'text/csv; header=absent' })).toEqual([['1', '2'], ['3', '4']]);
    expect(await decode('1|2\n', { format: { id: 'csv', delimiter: '|', header: false } })).toEqual([['1', '2']]);
  });

  it('encodes, and converts between formats through data', async () => {
    expect(await encode({ a: 1 }, { format: 'json;indent=0' })).toBe('{"a":1}');
    expect(await encode({ a: 1 }, { format: 'yaml' })).toBe('a: 1\n');
    expect(await encode({ t: { n: 1 } }, { format: 'toml' })).toBe('[t]\nn = 1\n');
    expect(await encode([{ a: 1, b: 'x,y' }, { a: 2 }], { format: 'csv' })).toBe('a,b\n1,"x,y"\n2,\n');
    expect(await encode([[1, 2]], { format: 'tsv' })).toBe('1\t2\n');
    expect(await convert('a: 1\n', { to: 'json;indent=0', filename: 'x.yml' })).toBe('{"a":1}');
    expect(await convert('a,b\n1,2\n', { from: 'csv', to: 'yaml' })).toBe('- a: "1"\n  b: "2"\n');
  });

  it('falls back among content-only guesses, never past a format the name or magic vouches for', async () => {
    const info = await decodeWithInfo('name,note\nann,"time: 10"\nbob,x\n');
    expect([info.format, info.value]).toEqual(['csv', [{ name: 'ann', note: 'time: 10' }, { name: 'bob', note: 'x' }]]);
    // a broken .toml must not come back as CSV rows
    await expect(decode('a = [1, 2]\nb = [3, 4]\na = [5, 6]\n', { filename: 'cfg.toml' })).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    await expect(decode('a: 1\n', { filename: 'oops.json' })).rejects.toThrow(/json/);
  });

  it('reads params from a MIME type hint', async () => {
    const latin1 = new Uint8Array([0x61, 0x0a, 0xe9, 0x0a]); // "a\né\n" in ISO-8859-1
    expect(await decode(latin1, { mimeType: 'text/csv; charset=iso-8859-1' })).toEqual([{ a: 'é' }]);
  });

  it('round-trips a format to itself with new params', async () => {
    expect(await convert('a,b\n1,2\n', { from: 'csv', to: 'csv;delimiter=";"' })).toBe('a;b\n1;2\n');
    expect(await convert('{ "a": 1 }', { to: 'json;indent=0' })).toBe('{"a":1}');
  });

  it('refuses CSV input or params that would lose data', async () => {
    await expect(encode({ a: 1 }, { format: 'csv' })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(decode('a,b\n', { format: 'csv;delimiter=' })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(decode('a\n"x\n', { format: 'csv' })).rejects.toThrow(/unterminated/);
    await expect(decode('a\n1,2\n', { format: 'csv' })).rejects.toThrow(/2 fields/);
    expect(await decode('a\n1,2\n', { format: 'csv;strict=false' })).toEqual([{ a: '1' }]);
    expect(await encode([{ a: { b: 1 } }], { format: 'csv' })).toBe('a\n"{""b"":1}"\n');
  });

  it('explains what it tried when nothing works', async () => {
    await expect(decode(new Uint8Array([0, 1, 2, 3]))).rejects.toMatchObject({ code: 'NO_FORMAT' });
    await expect(decode('{not json', { format: 'json' })).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    await expect(decode('x', { format: 'nope' })).rejects.toThrow(/Unknown format or kind 'nope'/);
  });
});

describe('packs, routes and lazy codecs', () => {
  const songOf = (notes: string) => ({ notes: notes.trim().split(/\s+/) });
  const load = vi.fn(async () => ({ decode: (b: Uint8Array) => songOf(new TextDecoder().decode(b.subarray(4))) }));
  const music = definePack({
    name: 'music',
    formats: [
      { id: 'tune', binary: true, magic: 'TUNE', extensions: ['tune'], kind: 'song', encodes: false, load },
      // a container that decodes to another format: the route chains through it
      { id: 'tunez', binary: true, magic: [0x50, 0x4b], kind: 'tune', decode: (b: Uint8Array) => b.subarray(2) },
      { id: 'abc', sniff: (_, t) => /^X:/m.test(t ?? ''), kind: 'song', decode: (t: string) => songOf(t.replace(/^X:.*$/m, '')) },
    ],
    transforms: [{ from: 'data', to: 'song', cost: 2, convert: (d: { notes: string[] }) => ({ notes: d.notes }) }],
  });

  it('loads a codec only when a request needs it, once', async () => {
    load.mockClear();
    const reg = createRegistry({ packs: [music] });
    await reg.decode('{"x": 1}');
    expect(load).not.toHaveBeenCalled();
    expect(await reg.decode(bytes('TUNEC D E'))).toEqual({ notes: ['C', 'D', 'E'] });
    expect(await reg.decode(bytes('TUNEF'))).toEqual({ notes: ['F'] });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('preloads on request', async () => {
    load.mockClear();
    const reg = createRegistry({ packs: [music], preload: ['tune'] });
    await reg.ready;
    expect(load).toHaveBeenCalledTimes(1);
    await expect(createRegistry({ preload: ['nope'] }).ready).rejects.toMatchObject({ code: 'NO_FORMAT' });
  });

  it('chains through formats and transforms to the requested kind', async () => {
    const reg = createRegistry({ packs: [music] });
    expect(await reg.decode(bytes('PKTUNEA B'))).toEqual({ notes: ['A', 'B'] });
    expect(reg.route('tunez', 'song')!.map((s) => `${s.op}:${s.from}>${s.to}`)).toEqual(['decode:tunez>tune', 'decode:tune>song']);
    expect(await reg.decode('{"notes": ["G"]}', { to: 'song' })).toEqual({ notes: ['G'] });
    expect(await reg.decode('X:1\nC G\n', { to: 'song' })).toEqual({ notes: ['C', 'G'] });
    const plan = await reg.resolve(bytes('TUNEC'), { to: 'song' });
    expect([plan.format, plan.route.length]).toEqual(['tune', 1]);
    expect(await plan.run()).toEqual({ notes: ['C'] });
  });

  it('skips candidates with no route to the target', async () => {
    const reg = createRegistry({ packs: [music] });
    await expect(reg.decode('a,b\n1,2\n', { to: 'tune' })).rejects.toMatchObject({ code: 'NO_ROUTE' });
  });

  it('decodes an in-memory value of a named kind', async () => {
    const reg = createRegistry({ packs: [music] });
    expect(await reg.decode({ notes: ['E'] }, { format: 'data', to: 'song' })).toEqual({ notes: ['E'] });
    expect(await reg.decode({ notes: ['E'] }, { format: 'song' })).toEqual({ notes: ['E'] });
    expect(await reg.encode({ a: 1 }, { format: 'json;indent=0' })).toBe('{"a":1}');
  });

  it('merges a re-registered format, or replaces it on request', async () => {
    const reg = createRegistry({ packs: [{ formats: [{ id: 'csv', decode: () => 'mine' }] }] });
    expect(await reg.decode('a,b\n1,2\n', { filename: 'x.csv' })).toBe('mine'); // detection kept, codec swapped
    expect((await reg.detect('', { filename: 'x.tsv' }))[0].format).toBe('tsv');
    reg.register({ formats: [{ id: 'csv', replace: true, decode: () => 'bare' }] });
    expect(await reg.detect('', { filename: 'x.csv' })).toEqual([]);
  });

  it('leaves the registry unchanged when a pack is invalid', async () => {
    const reg = createRegistry();
    expect(() => reg.register({ formats: [{ id: 'b', extends: 'nope' }] })).toThrow(/unknown format 'nope'/);
    expect(() => reg.register({ formats: [{ id: 'c', extensions: ['c'], decode: (t: string) => t }] })).not.toThrow();
  });

  it('lets the latest registration win ties, in detection and in spec lookup alike', async () => {
    const reg = createRegistry({ packs: [{ formats: [{ id: 'geojson', extensions: ['json'], decode: (t: string) => JSON.parse(t) }] }] });
    expect((await reg.detect('', { filename: 'x.json' }))[0].format).toBe('geojson');
    expect(reg.route('.json', 'data')![0].format).toBe('geojson');
  });

  it('names the npm package when a codec dependency is missing', async () => {
    const reg = createRegistry({
      builtins: false,
      packs: [{ formats: [{ id: 'x', extensions: ['x'], requires: ['not-a-real-pkg-xyz'], load: () => import('not-a-real-pkg-xyz' as string) }] }],
    });
    const err = (await reg.decode('...', { filename: 'a.x' }).catch((e: unknown) => e)) as FormatcastError;
    expect(err).toBeInstanceOf(FormatcastError);
    expect(err.code).toBe('MISSING_DEPENDENCY');
    expect(err.message).toMatch(/npm install not-a-real-pkg-xyz/);
    // a missing file that is not one of `requires` is the codec's own bug, reported as is
    const own = createRegistry({ builtins: false, packs: [{ formats: [{ id: 'y', requires: ['yaml'], load: () => import('./no-such-file.js' as string) }] }] });
    const err2 = (await own.decode('...', { format: 'y' }).catch((e: unknown) => e)) as Error;
    expect((err2 as FormatcastError).code).toBe('DECODE_FAILED');
  });
});
