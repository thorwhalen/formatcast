/**
 * The registry: formats and transforms as one graph, plus detection, routing and lazy codecs.
 *
 *     const reg = createRegistry({ packs: [musicPack], preload: ['midi'] });
 *     const song = await reg.decode(file, { to: 'song' });
 *     const yaml = await reg.encode(spec, { format: 'yaml' });
 *
 * Nothing a codec needs is imported until a request routes through it: a format's `load()` is
 * called on first use and its promise cached. `preload` calls it early.
 */
import { DEFAULT_HEAD_SIZE, DEFAULT_WEIGHTS, rank } from './detect.js';
import { errorMessage, FormatcastError, isMissingModuleError, type Attempt } from './errors.js';
import { essenceOf, isInput, readSource, toBytes, toText, type Source } from './input.js';
import { cheapestRoute } from './route.js';
import { parseSpec } from './spec.js';
import { textPack } from './text/index.js';
import type {
  Candidate,
  CodecModule,
  ConvertOptions,
  Converter,
  Ctx,
  Decoded,
  DecodeOptions,
  EncodeOptions,
  FormatDef,
  FormatSpec,
  Hints,
  Input,
  Kind,
  Pack,
  Params,
  Plan,
  Step,
  TransformDef,
  Weights,
} from './types.js';

export interface RegistryOptions {
  /** Packs to register, after the built-in ones. */
  packs?: Pack[];
  /** Register the built-in text pack (json, ndjson, yaml, toml, csv, tsv) first. Default true. */
  builtins?: boolean;
  /** Format ids whose codecs to load now rather than on first use; `registry.ready` settles when done. */
  preload?: string[];
  /** How much each kind of evidence counts in detection. */
  weights?: Partial<Weights>;
  /** How many leading bytes magic and sniffers see. */
  headSize?: number;
  /** The kind a format decodes to when it does not say. Default `'data'`. */
  defaultKind?: Kind;
}

export interface Registry {
  /** Add packs. A format whose id is already registered is merged into the existing one (`replace: true` to start over). */
  register(...packs: Pack[]): Registry;
  /** Effective format definitions (aliases resolved), in registration order. */
  formats(): FormatDef[];
  /** Ranked format candidates for an input. */
  detect(input: Input, hints?: Hints): Promise<Candidate[]>;
  /** The cheapest route between two kinds or formats, as data. */
  route(from: FormatSpec, to: FormatSpec): Step[] | undefined;
  /** Detect and route without running: the plan for the best candidate that has a route. */
  resolve(input: unknown, options?: DecodeOptions): Promise<Plan>;
  /** Input (a string, bytes, a Blob, or an in-memory value of the kind named by `format`) to a value of the target kind. */
  decode<T = unknown>(input: unknown, options?: DecodeOptions): Promise<T>;
  /** `decode`, also saying which format was used and by which route (after any fallback). */
  decodeWithInfo<T = unknown>(input: unknown, options?: DecodeOptions): Promise<Decoded<T>>;
  /** A value to a serialized format (a string for text formats, a Uint8Array for binary ones). */
  encode<T = string | Uint8Array>(value: unknown, options: EncodeOptions): Promise<T>;
  /** Input in one format to another: detect (or `from`), decode, route, encode. */
  convert<T = string | Uint8Array>(input: Input, options: ConvertOptions): Promise<T>;
  /** Load the codecs of these formats (all registered ones when omitted). */
  preload(ids?: string[]): Promise<void>;
  /** Settles when the `preload` option's codecs are loaded (rejects if one failed). */
  readonly ready: Promise<void>;
}

interface Edge extends Step {
  run: (value: unknown, params: Params, ctx: Ctx) => Promise<unknown>;
  params: Params;
}

interface Target {
  kind: Kind;
  format?: string;
  params: Params;
}

/** Evidence that names the format outright; fallback never leaves it behind (see `decodeWithInfo`). */
const _HARD_EVIDENCE = ['explicit', 'magic', 'extension', 'mime'] as const;
const _CODEC_FIELDS = ['decode', 'encode', 'load', 'decodes', 'encodes', 'requires'] as const;

export function createRegistry(options: RegistryOptions = {}): Registry {
  const { packs = [], builtins = true, preload: preloadIds = [], headSize = DEFAULT_HEAD_SIZE, defaultKind = 'data' } = options;
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  let raw = new Map<string, FormatDef>(); // as registered (merged), by id
  let transforms: TransformDef[] = [];
  let effective = new Map<string, FormatDef>();
  let edges: Edge[] = [];
  let nodes = new Set<Kind>();
  const loaded = new Map<Function, Promise<unknown>>();

  function resolveAlias(f: FormatDef, from: Map<string, FormatDef>, seen: Set<string> = new Set()): FormatDef {
    if (!f.extends) return f;
    if (seen.has(f.id)) throw new FormatcastError('NO_FORMAT', `Format '${f.id}' extends itself through a cycle`);
    seen.add(f.id);
    const baseRaw = from.get(f.extends);
    if (!baseRaw) throw new FormatcastError('NO_FORMAT', `Format '${f.id}' extends unknown format '${f.extends}'`);
    const base = resolveAlias(baseRaw, from, seen);
    const codec = _CODEC_FIELDS.some((k) => k in f) ? {} : Object.fromEntries(_CODEC_FIELDS.map((k) => [k, base[k]]));
    return { kind: base.kind, binary: base.binary, cost: base.cost, ...codec, ...f, params: { ...base.params, ...f.params } };
  }

  /** A later definition of an id refines the earlier one; a codec replaces the codec as a whole. */
  function merge(old: FormatDef | undefined, f: FormatDef): FormatDef {
    if (!old || f.replace) return f;
    const base = _CODEC_FIELDS.some((k) => k in f) ? Object.fromEntries(Object.entries(old).filter(([k]) => !(_CODEC_FIELDS as readonly string[]).includes(k))) : old;
    return { ...base, ...f, params: { ...old.params, ...f.params } } as FormatDef;
  }

  async function loadOnce<M>(load: () => Promise<M>, label: string, requires: string[] | undefined): Promise<M> {
    let p = loaded.get(load) as Promise<M> | undefined;
    if (!p) {
      p = load().catch((error: unknown) => {
        loaded.delete(load);
        const missing = requires?.filter((pkg) => isMissingModuleError(error, pkg)) ?? [];
        if (missing.length)
          throw new FormatcastError(
            'MISSING_DEPENDENCY',
            `The codec for '${label}' needs ${missing.join(', ')}; install it with: npm install ${missing.join(' ')}`,
            { cause: error },
          );
        throw error;
      });
      loaded.set(load, p);
    }
    return p;
  }

  async function codecOf(f: FormatDef): Promise<CodecModule> {
    if (!f.load) return f;
    const m = (await loadOnce(f.load, f.id, f.requires)) as CodecModule & { default?: CodecModule };
    const mod = m.decode || m.encode ? m : (m.default ?? m);
    // inline functions on the definition override the loaded ones
    return { decode: f.decode ?? mod.decode, encode: f.encode ?? mod.encode };
  }

  async function converterOf(t: TransformDef): Promise<Converter> {
    if (t.convert) return t.convert;
    if (!t.load) throw new FormatcastError('NO_CODEC', `Transform ${t.from} → ${t.to} has neither convert nor load`);
    const m = await loadOnce(t.load, `${t.from} → ${t.to}`, t.requires);
    const fn = m.convert ?? m.default;
    if (!fn) throw new FormatcastError('NO_CODEC', `Transform ${t.from} → ${t.to}: its module exports neither convert nor default`);
    return fn;
  }

  function buildEdges(fs: Map<string, FormatDef>, ts: TransformDef[]): Edge[] {
    const out: Edge[] = [];
    for (const f of fs.values()) {
      const kind = f.kind ?? defaultKind;
      const cost = f.cost ?? 1;
      const params = f.params ?? {};
      // A lazy module is taken to provide both directions unless the format says otherwise.
      if (f.decode || (f.load && f.decodes !== false))
        out.push({
          from: f.id, to: kind, cost, format: f.id, op: 'decode', params,
          run: async (value, p, ctx) => {
            const { decode } = await codecOf(f);
            if (!decode) throw new FormatcastError('NO_CODEC', `Format '${f.id}' cannot decode (its module exports no decode; declare decodes: false)`);
            const input = f.binary ? toBytes(value as string | Uint8Array) : toText(value as string | Uint8Array, (p.charset as string) ?? 'utf-8');
            return decode(input, p, ctx);
          },
        });
      if (f.encode || (f.load && f.encodes !== false))
        out.push({
          from: kind, to: f.id, cost, format: f.id, op: 'encode', params,
          run: async (value, p, ctx) => {
            const { encode } = await codecOf(f);
            if (!encode) throw new FormatcastError('NO_CODEC', `Format '${f.id}' cannot encode (its module exports no encode; declare encodes: false)`);
            return encode(value, p, ctx);
          },
        });
    }
    for (const t of ts)
      out.push({
        from: t.from, to: t.to, cost: t.cost ?? 1, op: 'transform', params: t.params ?? {},
        run: async (value, p, ctx) => (await converterOf(t))(value, p, ctx),
      });
    return out;
  }

  function register(...more: Pack[]): Registry {
    // Build the new state aside, so a bad pack leaves the registry as it was.
    const nextRaw = new Map(raw);
    const nextTransforms = [...transforms];
    for (const pack of more) {
      for (const f of pack.formats ?? []) {
        const merged = merge(nextRaw.get(f.id), f);
        nextRaw.delete(f.id); // re-registering moves it to the end: the latest registration wins ties
        nextRaw.set(f.id, merged);
      }
      nextTransforms.push(...(pack.transforms ?? []));
    }
    const nextEffective = new Map([...nextRaw.values()].map((f) => [f.id, resolveAlias(f, nextRaw)]));
    const nextEdges = buildEdges(nextEffective, nextTransforms);
    [raw, transforms, effective, edges] = [nextRaw, nextTransforms, nextEffective, nextEdges];
    nodes = new Set([...edges.flatMap((e) => [e.from, e.to]), ...effective.keys()]);
    return registry;
  }

  /** Latest registration first, so a consumer's format wins over a built-in one everywhere. */
  const byPrecedence = () => [...effective.values()].reverse();

  /** A spec name to a target: a format id, then a kind, then an extension, then a MIME type. */
  function target(spec: FormatSpec): Target {
    const { name, params } = parseSpec(spec);
    const asFormat = (id: string): Target => ({ kind: id, format: id, params: { ...effective.get(id)!.params, ...params } });
    if (effective.has(name)) return asFormat(name);
    if (nodes.has(name)) return { kind: name, params };
    const ext = name.startsWith('.') ? name.slice(1) : name;
    const mime = essenceOf(name);
    const f = byPrecedence().find((f) => f.extensions?.includes(ext) || (name.includes('/') && f.mimeTypes?.includes(mime)));
    if (f) return asFormat(f.id);
    throw new FormatcastError('NO_FORMAT', `Unknown format or kind '${name}'. Known formats: ${[...effective.keys()].join(', ')}`);
  }

  /** Where decoding a format ends when no target is given: follow `kind` through container formats. */
  function finalKind(kind: Kind): Kind {
    const seen = new Set<Kind>();
    while (effective.has(kind) && !seen.has(kind)) {
      seen.add(kind);
      kind = effective.get(kind)!.kind ?? defaultKind;
    }
    return kind;
  }

  function routeOrThrow(from: Kind, to: Target | Kind): Step[] {
    const goal = typeof to === 'string' ? to : to.kind;
    // Format to the same format (new params, a normalising round trip): through its kind, never the empty route.
    if (from === goal && typeof to !== 'string' && to.format) {
      const via = effective.get(goal)!.kind ?? defaultKind;
      return [...routeOrThrow(from, via), ...routeOrThrow(via, goal)];
    }
    const r = cheapestRoute(edges, from, goal);
    if (!r) throw new FormatcastError('NO_ROUTE', `No conversion route from '${from}' to '${goal}'`);
    return r;
  }

  async function runRoute(route: Step[], value: unknown, ends: { source?: Target; target?: Target }, ctx: Ctx): Promise<unknown> {
    let v = value;
    for (const [i, step] of (route as Edge[]).entries()) {
      let params = step.params;
      if (i === 0 && step.op === 'decode' && step.format === ends.source?.format) params = ends.source!.params;
      if (i === route.length - 1 && ends.target) {
        if (step.op === 'encode' && step.format === ends.target.format) params = ends.target.params;
        else if (step.op === 'transform' && !ends.target.format) params = { ...step.params, ...ends.target.params };
      }
      v = await step.run(v, params, ctx);
    }
    return v;
  }

  interface Option {
    candidate: Candidate;
    source: Target;
  }

  function sourceTargets(source: Source, options: DecodeOptions): Option[] {
    if (options.format !== undefined) {
      const t = target(options.format);
      return [{ candidate: { format: t.kind, score: Infinity, evidence: { explicit: 1 } }, source: t }];
    }
    const ranked = rank(source, byPrecedence(), { weights, headSize });
    if (!ranked.length) {
      const hints = [source.filename && `file name '${source.filename}'`, source.mimeType && `MIME type '${source.mimeType}'`].filter(Boolean);
      throw new FormatcastError(
        'NO_FORMAT',
        `Could not detect the format${hints.length ? ` (${hints.join(', ')})` : ''}; pass { format } explicitly. Known formats: ${[...effective.keys()].join(', ')}`,
      );
    }
    // MIME parameters (charset, header=absent) apply to the candidate the MIME type names.
    const mimeParams = source.mimeType ? parseSpec(source.mimeType).params : {};
    return ranked.map((c) => {
      const t = target(c.format);
      return { candidate: c, source: c.evidence.mime ? { ...t, params: { ...t.params, ...mimeParams } } : t };
    });
  }

  /** Candidates may stand in for the best one only if they carry every piece of its hard evidence. */
  function eligible(options: Option[]): Option[] {
    if (!options.length) return options;
    const hard = _HARD_EVIDENCE.filter((k) => options[0].candidate.evidence[k]);
    return options.filter((o) => hard.every((k) => o.candidate.evidence[k]));
  }

  async function plans(input: unknown, options: DecodeOptions): Promise<{ plans: Plan[]; attempts: Attempt[] }> {
    const attempts: Attempt[] = [];
    const goal = options.to === undefined ? undefined : target(options.to);
    const ctxOf = (s: Hints): Ctx => ({ filename: s.filename, mimeType: s.mimeType, context: options.context });
    if (!isInput(input)) {
      // an in-memory value: its kind must be given
      if (options.format === undefined)
        throw new FormatcastError('BAD_INPUT', 'Input is not a string, bytes or Blob; say what kind it is with { format: <kind> }');
      const t = target(options.format);
      const route = routeOrThrow(t.kind, goal ?? t.kind);
      const candidate: Candidate = { format: t.kind, score: Infinity, evidence: { explicit: 1 } };
      return { plans: [{ format: t.kind, candidate, route, run: () => runRoute(route, input, { target: goal }, ctxOf(options)) }], attempts };
    }
    const source = await readSource(input, options);
    const value = source.bytes ?? source.text;
    const out: Plan[] = [];
    for (const { candidate, source: t } of eligible(sourceTargets(source, options))) {
      try {
        const route = routeOrThrow(t.kind, goal ?? finalKind(t.kind));
        out.push({ format: candidate.format, candidate, route, run: () => runRoute(route, value, { source: t, target: goal }, ctxOf(source)) });
      } catch (error) {
        attempts.push({ format: candidate.format, error });
      }
    }
    return { plans: out, attempts };
  }

  function failure(attempts: Attempt[]): FormatcastError {
    if (attempts.length === 1 && attempts[0].error instanceof FormatcastError) return attempts[0].error;
    const lines = attempts.map((a) => `  ${a.format}: ${errorMessage(a.error)}`).join('\n');
    return new FormatcastError('DECODE_FAILED', `Could not decode the input; tried:\n${lines}`, {
      attempts,
      cause: attempts.length === 1 ? attempts[0].error : undefined,
    });
  }

  async function decodeWithInfo<T>(input: unknown, options: DecodeOptions = {}): Promise<Decoded<T>> {
    const { plans: ps, attempts } = await plans(input, options);
    for (const plan of ps) {
      try {
        return { value: (await plan.run()) as T, format: plan.format, route: plan.route, candidate: plan.candidate };
      } catch (error) {
        if (error instanceof FormatcastError && error.code === 'MISSING_DEPENDENCY') throw error;
        attempts.push({ format: plan.format, error });
      }
    }
    throw failure(attempts);
  }

  const registry: Registry = {
    register,
    formats: () => [...effective.values()],
    async detect(input, hints = {}) {
      return rank(await readSource(input, hints), byPrecedence(), { weights, headSize });
    },
    route(from, to) {
      return cheapestRoute(edges, target(from).kind, target(to).kind)?.map(({ from, to, cost, format, op }) => ({ from, to, cost, format, op }));
    },
    async resolve(input, options = {}) {
      const { plans: ps, attempts } = await plans(input, options);
      if (!ps.length) throw failure(attempts);
      return ps[0];
    },
    async decode<T>(input: unknown, options?: DecodeOptions) {
      return (await decodeWithInfo<T>(input, options)).value;
    },
    decodeWithInfo,
    async encode<T>(value: unknown, options: EncodeOptions): Promise<T> {
      const goal = target(options.format);
      const from = options.from ?? (goal.format ? (effective.get(goal.format)!.kind ?? defaultKind) : defaultKind);
      const route = routeOrThrow(from, goal);
      return (await runRoute(route, value, { target: goal }, { context: options.context })) as T;
    },
    async convert<T>(input: Input, options: ConvertOptions): Promise<T> {
      const { to, from, ...rest } = options;
      return (await decodeWithInfo<T>(input, { ...rest, format: from, to })).value;
    },
    async preload(ids) {
      const fs = ids ? ids.map((id) => target(id).format) : [...effective.keys()];
      await Promise.all(
        fs.map((id, i) => {
          if (!id) throw new FormatcastError('NO_FORMAT', `Cannot preload '${ids![i]}': it is a kind, not a format`);
          return codecOf(effective.get(id)!);
        }),
      );
    },
    ready: Promise.resolve(),
  };

  if (builtins) register(textPack);
  register(...packs);
  if (preloadIds.length) {
    const ready = registry.preload(preloadIds);
    ready.catch(() => {}); // surfaced through `ready`, never as an unhandled rejection
    (registry as { ready: Promise<void> }).ready = ready;
  }
  return registry;
}

/** Identity helpers that give a pack or a format its type in plain JS and TS alike. */
export const definePack = (pack: Pack): Pack => pack;
export const defineFormat = (format: FormatDef): FormatDef => format;
