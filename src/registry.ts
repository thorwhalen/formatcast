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
  register(...packs: Pack[]): Registry;
  /** Effective format definitions (aliases resolved), in registration order. */
  formats(): FormatDef[];
  /** Ranked format candidates for an input. */
  detect(input: Input, hints?: Hints): Promise<Candidate[]>;
  /** The cheapest route between two kinds or formats, as data. */
  route(from: FormatSpec, to: FormatSpec): Step[] | undefined;
  /** Detect and route without running: the plan for the best candidate that has a route. */
  resolve(input: Input, options?: DecodeOptions): Promise<Plan>;
  /** Input to a value of the target kind (default: the detected format's kind). Tries candidates in order. */
  decode<T = unknown>(input: Input | unknown, options?: DecodeOptions): Promise<T>;
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

export function createRegistry(options: RegistryOptions = {}): Registry {
  const { packs = [], builtins = true, preload: preloadIds = [], headSize = DEFAULT_HEAD_SIZE, defaultKind = 'data' } = options;
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const raw = new Map<string, FormatDef>(); // as registered, by id (re-registering replaces)
  const transforms: TransformDef[] = [];
  let effective = new Map<string, FormatDef>();
  let edges: Edge[] = [];
  let nodes = new Set<Kind>();
  const loaded = new Map<Function, Promise<unknown>>();

  function resolveAlias(f: FormatDef, seen: Set<string> = new Set()): FormatDef {
    if (!f.extends) return f;
    if (seen.has(f.id)) throw new FormatcastError('NO_FORMAT', `Format '${f.id}' extends itself through a cycle`);
    seen.add(f.id);
    const baseRaw = raw.get(f.extends);
    if (!baseRaw) throw new FormatcastError('NO_FORMAT', `Format '${f.id}' extends unknown format '${f.extends}'`);
    const base = resolveAlias(baseRaw, seen);
    return {
      kind: base.kind,
      binary: base.binary,
      decode: base.decode,
      encode: base.encode,
      decodes: base.decodes,
      encodes: base.encodes,
      load: base.load,
      requires: base.requires,
      cost: base.cost,
      ...f,
      params: { ...base.params, ...f.params },
    };
  }

  async function loadOnce<M>(load: () => Promise<M>, label: string, requires: string[] | undefined): Promise<M> {
    let p = loaded.get(load) as Promise<M> | undefined;
    if (!p) {
      p = load().catch((error: unknown) => {
        loaded.delete(load);
        if (isMissingModuleError(error)) {
          const pkgs = requires?.length ? requires.join(' ') : undefined;
          throw new FormatcastError(
            'MISSING_DEPENDENCY',
            `The codec for '${label}' could not be loaded${pkgs ? `; install it with: npm install ${pkgs}` : ''} (${errorMessage(error)})`,
            { cause: error },
          );
        }
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

  function rebuild(): void {
    effective = new Map([...raw.values()].map((f) => [f.id, resolveAlias(f)]));
    edges = [];
    for (const f of effective.values()) {
      const kind = f.kind ?? defaultKind;
      const cost = f.cost ?? 1;
      const params = f.params ?? {};
      // An edge exists when the codec may provide the direction: inline, or (unknown until loaded) via load.
      if (f.decode || (f.load && f.decodes !== false))
        edges.push({
          from: f.id, to: kind, cost, format: f.id, op: 'decode', params,
          run: async (value, p, ctx) => {
            const { decode } = await codecOf(f);
            if (!decode) throw new FormatcastError('NO_CODEC', `Format '${f.id}' cannot decode`);
            const input = f.binary ? toBytes(value as string | Uint8Array) : toText(value as string | Uint8Array, (p.charset as string) ?? 'utf-8');
            return decode(input, p, ctx);
          },
        });
      if (f.encode || (f.load && f.encodes))
        edges.push({
          from: kind, to: f.id, cost, format: f.id, op: 'encode', params,
          run: async (value, p, ctx) => {
            const { encode } = await codecOf(f);
            if (!encode) throw new FormatcastError('NO_CODEC', `Format '${f.id}' cannot encode`);
            return encode(value, p, ctx);
          },
        });
    }
    for (const t of transforms)
      edges.push({
        from: t.from, to: t.to, cost: t.cost ?? 1, op: 'transform', params: t.params ?? {},
        run: async (value, p, ctx) => (await converterOf(t))(value, p, ctx),
      });
    nodes = new Set(edges.flatMap((e) => [e.from, e.to]));
    for (const id of effective.keys()) nodes.add(id);
  }

  function register(...more: Pack[]): Registry {
    for (const pack of more) {
      for (const f of pack.formats ?? []) {
        raw.delete(f.id); // re-registering moves it to the end, so a consumer's version wins ties
        raw.set(f.id, f);
      }
      transforms.push(...(pack.transforms ?? []));
    }
    rebuild();
    return registry;
  }

  /** A spec to a format id: by id, then extension, then MIME type; undefined when none. */
  function formatIdOf(name: string): string | undefined {
    if (effective.has(name)) return name;
    const ext = name.startsWith('.') ? name.slice(1) : name;
    const mime = essenceOf(name);
    for (const f of [...effective.values()].reverse()) {
      if (f.extensions?.includes(ext) || (name.includes('/') && f.mimeTypes?.includes(mime))) return f.id;
    }
    return undefined;
  }

  function target(spec: FormatSpec): Target {
    const { name, params } = parseSpec(spec);
    const id = formatIdOf(name);
    if (id) return { kind: id, format: id, params: { ...effective.get(id)!.params, ...params } };
    if (nodes.has(name)) return { kind: name, params };
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

  function routeOrThrow(from: Kind, to: Kind): Step[] {
    const r = cheapestRoute(edges, from, to);
    if (!r) throw new FormatcastError('NO_ROUTE', `No conversion route from '${from}' to '${to}'`);
    return r;
  }

  async function runRoute(route: Step[], value: unknown, ends: { source?: Target; target?: Target }, ctx: Ctx): Promise<unknown> {
    let v = value;
    for (const step of route as Edge[]) {
      let params = step.params;
      if (step.op === 'decode' && step.format === ends.source?.format) params = ends.source!.params;
      if (step.op === 'encode' && step.format === ends.target?.format) params = ends.target!.params;
      v = await step.run(v, params, ctx);
    }
    return v;
  }

  function planFor(source: Source, candidate: Candidate, sourceTarget: Target, to: FormatSpec | undefined, context: unknown): Plan {
    const goal = to === undefined ? undefined : target(to);
    const toKind = goal?.kind ?? finalKind(sourceTarget.kind);
    const route = routeOrThrow(sourceTarget.kind, toKind);
    const ctx: Ctx = { filename: source.filename, mimeType: source.mimeType, context };
    const value = source.bytes ?? source.text;
    return {
      format: candidate.format,
      candidate,
      route,
      run: () => runRoute(route, value, { source: sourceTarget, target: goal }, ctx),
    };
  }

  async function candidatesFor(source: Source, options: DecodeOptions): Promise<{ candidate: Candidate; source: Target }[]> {
    if (options.format !== undefined) {
      const t = target(options.format);
      return [{ candidate: { format: t.kind, score: Infinity, evidence: { explicit: 1 } }, source: t }];
    }
    const ranked = rank(source, effective.values(), { weights, headSize });
    if (!ranked.length) {
      const hints = [source.filename && `file name '${source.filename}'`, source.mimeType && `MIME type '${source.mimeType}'`].filter(Boolean);
      throw new FormatcastError(
        'NO_FORMAT',
        `Could not detect the format${hints.length ? ` (${hints.join(', ')})` : ''}; pass { format } explicitly. Known formats: ${[...effective.keys()].join(', ')}`,
      );
    }
    return ranked.map((c) => ({ candidate: c, source: target(c.format) }));
  }

  async function plans(input: Input | unknown, options: DecodeOptions): Promise<{ plans: Plan[]; attempts: Attempt[] }> {
    const attempts: Attempt[] = [];
    const out: Plan[] = [];
    if (!isInput(input)) {
      // an in-memory value: its kind must be given
      if (options.format === undefined)
        throw new FormatcastError('BAD_INPUT', 'Input is not a string, bytes or Blob; say what kind it is with { format: <kind> }');
      const t = target(options.format);
      const candidate: Candidate = { format: t.kind, score: Infinity, evidence: { explicit: 1 } };
      const goal = options.to === undefined ? undefined : target(options.to);
      const route = routeOrThrow(t.kind, goal?.kind ?? defaultKind);
      const ctx: Ctx = { filename: options.filename, mimeType: options.mimeType, context: options.context };
      return { plans: [{ format: t.kind, candidate, route, run: () => runRoute(route, input, { target: goal }, ctx) }], attempts };
    }
    const source = await readSource(input, options);
    for (const { candidate, source: t } of await candidatesFor(source, options)) {
      try {
        out.push(planFor(source, candidate, t, options.to, options.context));
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

  async function decode<T>(input: Input | unknown, options: DecodeOptions = {}): Promise<T> {
    const { plans: ps, attempts } = await plans(input, options);
    for (const plan of ps) {
      try {
        return (await plan.run()) as T;
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
      return rank(await readSource(input, hints), effective.values(), { weights, headSize });
    },
    route(from, to) {
      return cheapestRoute(edges, target(from).kind, target(to).kind)?.map(({ from, to, cost, format, op }) => ({ from, to, cost, format, op }));
    },
    async resolve(input, options = {}) {
      const { plans: ps, attempts } = await plans(input, options);
      if (!ps.length) throw failure(attempts);
      return ps[0];
    },
    decode,
    async encode<T>(value: unknown, options: EncodeOptions): Promise<T> {
      const goal = target(options.format);
      const from = options.from ?? (goal.format ? (effective.get(goal.format)!.kind ?? defaultKind) : defaultKind);
      const route = routeOrThrow(from, goal.kind);
      return (await runRoute(route, value, { target: goal }, { context: options.context })) as T;
    },
    async convert<T>(input: Input, options: ConvertOptions): Promise<T> {
      const { to, from, ...rest } = options;
      return decode<T>(input, { ...rest, format: from, to });
    },
    async preload(ids) {
      const fs = ids ? ids.map((id) => effective.get(formatIdOf(id.toLowerCase()) ?? id)) : [...effective.values()];
      await Promise.all(
        fs.map((f, i) => {
          if (!f) throw new FormatcastError('NO_FORMAT', `Cannot preload unknown format '${ids![i]}'`);
          return codecOf(f);
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
