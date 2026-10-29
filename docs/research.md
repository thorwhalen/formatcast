# Format codecs in JavaScript: detection, lazy codec registries and conversion graphs

Research for a light, headless, pure-JS tool that resolves the right decoder or encoder for a format conversion (from an explicit format with parameters, a file extension, a MIME type or the first bytes), loads codec implementations only when needed, and can chain conversions. First consumer: a music game importing songs (MIDI, MusicXML, ABC) and game specs (JSON, YAML, TOML).

All versions, dates, licences and sizes were checked on **2026-10-29** against the npm registry and the projects' own repositories. Sizes are minified + gzipped bundles of the named imports, built with esbuild for the browser platform (`--bundle --minify`, then `gzip -9`). They agree with bundlephobia [55] to within about 10%.

## Key takeaways

- **The problem has well-established names and a long history.** Detection is *content sniffing* or *type detection* (WHATWG MIME Sniffing [1], shared-mime-info [2], libmagic [3][4], Apache Tika [5], FFmpeg probing [6], GStreamer typefind [7]). Resolving a name to an implementation is a *codec registry* with *search functions* (Python `codecs` [9]) or *service providers* (Java `ServiceLoader` and ImageIO SPIs [10][11]). Choosing an output format is *content negotiation* [12]. A–B–C chaining is a *conversion graph*, or *autoplugging* in GStreamer [8]. The internal schema at the centre is a *canonical data model* [19], used as an *anti-corruption layer* [20], and pandoc's reader → AST → writer design is the classic example [17].
- **No JS library covers the whole brief.** Detection libraries (file-type, magic-bytes.js, mime) only detect. Format libraries (yaml, smol-toml, midi-file, musicxml-io) only convert. unified is a pipeline built around one AST family. loaders.gl comes closest (loader objects carrying extensions, MIME types and magic tests, plus `selectLoader`, `parse` and `encode`), but its selection is first-match with no scores, `encode` needs the writer named explicitly, it cannot chain, and its core pulls in geospatial and Arrow dependencies.
- **loaders.gl v5 (beta, published 2026-10-28) has adopted exactly the lazy-loading pattern wanted here.** Root exports are now *metadata-only loaders* whose `preload()` does `await import(...)` of the parser, and the core gains `preload(loader)` [24][25]. That validates the design, but v5 core installs 84 MB of `node_modules` (math.gl geospatial, apache-arrow, zod) and bundles to 19.6 kB gzipped, which is heavy for a "very light" tool used in a game.
- **Every mature detector ranks its evidence, and each uses a different mechanism:** FFmpeg uses numeric scores (extension = 50, MIME match adds 30, max 100, retry with more bytes below 25) [6]; GStreamer uses probabilities from 1 to 100 plus plugin rank [7]; shared-mime-info uses glob weights and magic priorities, with a *subclass* tie-break [2]; libmagic uses entry strength [4]. loaders.gl is the outlier: it takes the first hit in a fixed order.
- **The text formats this project needs (JSON, YAML, TOML, CSV, ABC) have no magic bytes.** Detecting them is heuristic, so the resolver must return ranked candidates with confidences and must be able to fall back to the next candidate when a parse fails. MIDI (`MThd`), MXL (a zip whose first entry is `mimetype`) and MusicXML (an XML root of `score-partwise` or `score-timewise`) are reliably sniffable [51].
- **Verdict:** build a small core of a few kB, and adopt the per-format libraries as lazily imported extras. Use the shape of loaders.gl's format descriptor so its loaders could be adapted later, file-type as an *optional* binary detector plugin, and dol/castgraph semantics for codecs and routing. Do not adopt loaders.gl core as the engine.

## 1. Terminology: what this problem is called

| Concept in the brief | Established names | Where the literature lives |
|---|---|---|
| Guess the format from bytes, extension or declared type | content sniffing, MIME sniffing, type detection, file identification, *magic numbers* | WHATWG MIME Sniffing [1]; freedesktop shared-mime-info [2]; `file(1)`/libmagic [3][4]; Tika `Detector` [5]; FFmpeg `read_probe` [6]; GStreamer typefind [7] |
| Look up an implementation by name | codec registry, search function, service provider interface (SPI), plugin registry | Python `codecs.register`/`lookup` and the lazy `encodings` package [9]; Java `ServiceLoader` [10]; ImageIO `ImageReaderSpi` [11] |
| Format plus options (`csv` with `;` as delimiter) | media type *parameters*, structured syntax suffixes (`+json`, `+xml`, `+zip`) | RFC 6838 [13]; RFC 4180 `text/csv; header=present; charset=…` [14]; RFC 6839 [15] |
| Choose the output encoding from what the caller accepts | proactive content negotiation, quality values (`q`) | RFC 9110 §12 [12]; `negotiator` [54] |
| Encoder/decoder pair, composable and invertible | codec, bidirectional transform, isomorphism (lossless) or lens / round-trip | dol `Codec` (`+` composes, `~` inverts); Zod 4.1 `z.codec()` [21] |
| A→B→C chaining | conversion graph, type-directed coercion, autoplugging, transcoding pipeline, layered codecs | castgraph; Spring `ConversionService` [18]; GStreamer `decodebin` [8]; HTTP `Content-Encoding` stacking [12]; p2r3/convert [36] |
| Internal schema in the middle | canonical data model, hub-and-spoke, intermediate representation, anti-corruption layer | EIP Canonical Data Model [19]; ACL [20]; pandoc reader → AST → writer [17]; unified parser → syntax tree → compiler [35] |

The castgraph module docstring already names most of these (Type Converter / Conversion Service, Adapter, Strategy, Canonical Data Model, ACL, multimethod dispatch). This brief adds two that castgraph does not cover: **detection from external evidence** (bytes, extension, MIME type), which castgraph's `isa` predicates do only for in-memory objects, and **lazy materialisation of edges**.

## 2. Survey of existing JS/TS tools

### 2.1 Machinery: detection, registries, pipelines

| Package | Version (date) | Licence | Size (min+gz, measured) | Detect | Decode | Encode | Lazy loading | Chaining | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `@loaders.gl/core` [22][23] | 4.5.4 (2026-10-10) | MIT | 12.0 kB for `parse, selectLoader, encode, registerLoaders`; installs 19 MB incl. apache-arrow (as a dependency, tree-shaken out) | ext, MIME, magic `tests` (string, bytes or predicate); first match in fixed order | yes (`parse`, `parseSync`, `parseInBatches`) | yes, but `encode(data, writer)` needs the writer named explicitly | parsers run in Web Workers loaded from a CDN (`https://unpkg.com/@loaders.gl` by default) | no | `Loader` (metadata) vs `LoaderWithParser`; `options[loader.id]` holds per-format parameters |
| `@loaders.gl/core` 5.0.0-beta.1 [24] | 2026-10-28 (beta) | MIT | 19.6 kB; installs **84 MB** (math.gl geospatial, apache-arrow, zod 4) | same order, plus "source" matching | yes | same | **metadata-only loaders + `preload()` doing `import()`**; sync APIs need the parser-bearing loader | no | new `@loaders.gl/config` adds YAML and TOML loaders with their own parsers [25] |
| `file-type` [26] | 22.3.0 (2026-10-29) | MIT | 21.0 kB | binary magic only ("not text-based formats like .txt, .csv, .svg"); detects MIDI (`audio/midi`) | – | – | – | – | ESM, Node ≥ 22; `customDetectors` plugins; `@file-type/xml` [27] (1.2.0) detects MusicXML among other XML types |
| `magic-bytes.js` [28] | 1.13.1 (2026-07-24) | MIT | 4.3 kB | magic signature tree, returns several candidates | – | – | – | – | zero deps, synchronous, browser-friendly |
| `mime` [29] | 4.1.2 (2026-10-27) | MIT | 11.0 kB (full) / 4.0 kB (`mime/lite`) | ext ↔ MIME | – | – | – | – | uses `mime-score` to break ties between types claiming the same extension |
| `mime-types` + `mime-db` [30][31] | 3.0.2 (2025-11) / 1.54.0 (2025-03) | MIT | 24 kB | ext ↔ MIME, charset | – | – | – | – | **no extension for `text/vnd.abc` or `application/yaml`**, although both are IANA-registered [56]: formats must own their extension tables |
| `whatwg-mimetype` [32] | 5.0.0 (2026-01-20) | MIT | small | parses and serialises `type/subtype; k=v` per WHATWG | – | – | – | – | the correct parser for parameterised format strings |
| `magika` [33] | 1.0.0 (2025-10-21) | Apache-2.0 | depends on `@tensorflow/tfjs` (MBs) | deep-learning classifier for more than 200 content types, **text formats included** | – | – | – | – | the only option that classifies YAML, TOML or CSV by content; far too heavy for the core, possible as an opt-in detector |
| `wasmagic` [34] | 1.0.12 (2026-10-13) | BSD-2 | 1.8 MB unpacked (WASM) | full libmagic database | – | – | – | – | browser + node; heavy |
| `unified` [35] | 11.0.5 (2024-06-19) | MIT | 4.7 kB | – | parser plugin | compiler plugin | – | yes, through transformer plugins and bridges between tree types (e.g. `remark-rehype`) | an excellent pipeline model, but tied to unist trees and `vfile` |
| p2r3/convert [36] | app, not a library (pushed 2026-10-28) | **GPL-2.0** | – | ext + MIME | via handlers | via handlers | handler `init()` / `ready`; format list precomputed into `cache.json` | **yes: Dijkstra over a format graph**, step cost 1, lossy ×1.4, category-change costs | the clearest JS precedent for cost-weighted, lossy-aware multi-hop routing. Take the ideas only: GPL code cannot be copied |
| `fconvert` | 0.1.8 (2026-03-30) | MIT | 4.9 MB unpacked | – | – | – | – | "graph-based anything-to-anything routing" (CLI) | a CLI, not a library |

Considered and ruled out: Uppy (an upload UI, no codec logic); Apache Arrow JS (a columnar data format, not a registry); `mmmagic` (a native Node binding, last released 2019); `negotiator` and `accepts` (Accept-header parsing only, but a useful model for encode-side negotiation).

### 2.2 Extras: the per-format codecs that would be loaded lazily

| Format | Library | Version (date) | Licence | Size (min+gz) | Decode | Encode | Notes |
|---|---|---|---|---|---|---|---|
| JSON | native `JSON` | – | – | 0 | yes | yes | JSON5/JSONC via `confbox` if wanted |
| YAML | `yaml` (eemeli) [38] | 2.9.1 (2026-09-11) | ISC | 30.6 kB | yes | yes (keeps comments through its Document API) | 0 deps, full YAML 1.2/1.1 |
| YAML | `js-yaml` [39] | 5.5.0 (2026-10-15) | MIT | 17.3 kB | yes | yes (`dump`) | smaller, simpler |
| YAML/TOML/JSON5/JSONC/INI | `confbox` (unjs) [37] | 0.3.2 (2026-10-29) | MIT | YAML 18.0 kB, TOML 6.3 kB (subpath imports) | yes | yes | one dependency-free package with per-format subpaths, which suits lazy subpath imports |
| TOML | `smol-toml` [40] | 1.9.1 (2026-10-09) | BSD-3 | 6.5 kB | yes | yes (`stringify`) | spec-compliant, 0 deps; **recommended** |
| TOML | `@iarna/toml` [41] | 2.2.5 (**2020-04-22**) | ISC | 8.4 kB | yes | yes | unmaintained; avoid |
| CSV/DSV | `papaparse` [42] | 5.7.0 (2026-08-24) | MIT | 7.3 kB | yes (delimiter auto-detection, workers, streaming) | yes (`unparse`) | its delimiter *guessing* is itself a parameter sniffer |
| CSV/DSV | `d3-dsv` [43] | 3.0.1 (2021-06-05) | ISC | 1.0 kB | yes | yes (`dsvFormat(delim).format`) | the declared deps (commander, iconv-lite, rw) are for its CLI and are tree-shaken out |
| MIDI | `midi-file` [45] | 1.2.4 (2023-03-15) | MIT | 3.1 kB | yes (`parseMidi`) | yes (`writeMidi`) | low-level event lists |
| MIDI | `@tonejs/midi` [44] | 2.0.28 (**2022-02-04**) | MIT | 9.5 kB | yes (higher-level tracks and notes) | yes (`toArray()`) | built on midi-file; stale but stable; already used by thoremin |
| MusicXML (.musicxml/.xml) | `musicxml-io` [47] | 0.12.2 (2026-10-20) | MIT | 26.7 kB (`/musicxml`) | yes | yes (`serialize`) | its `Score` model is a hub with spokes to MusicXML, ABC and MIDI; already used by thoremin |
| MXL (zipped) | `musicxml-io/musicxml-compressed` | same | MIT | 33.4 kB (incl. fflate) | yes (`parseAuto`, `parseCompressed`) | yes (`serializeCompressed`) | – |
| ABC | `musicxml-io/abc` | same | MIT | 21.2 kB | yes (`parseAbc`, multi-tune `parseAbcTunes`) | yes (`serializeAbc`) | far lighter than abcjs for a pure codec |
| ABC (render/synth) | `abcjs` [46] | 6.7.2 (2026-10-16) | MIT | **153 kB** | yes | MIDI export through its synth | a renderer, not a codec; load only for display |
| Score → MIDI | `musicxml-io/midi` | same | MIT | 5.2 kB | – | yes (`exportMidi`) | a cross-format edge, useful for chaining |
| MusicXML | `musicxml-interfaces` [48] | 0.0.21 (2022-08-18) | **AGPL-3.0** | – | yes | yes | licence and staleness rule it out |
| MusicXML render | `opensheetmusicdisplay` [49] | 2.2.1 (2026-10-12) | BSD-3 | **360 kB** | – | – | a renderer; never a codec dependency |
| MEI/MusicXML/ABC/Humdrum | `verovio` [50] | 6.3.0 (2026-08-19) | LGPL-3.0+ | 27 MB unpacked (WASM) | yes | MEI, MIDI, SVG | the heavyweight "convert anything musical" engine; a candidate *plugin pack*, never core |

Two observations follow from the extras table. First, every recommended extra both decodes and encodes, so a bidirectional registry costs nothing extra in dependencies. Second, `musicxml-io` already provides a small hub-and-spoke design for music notation (MusicXML ↔ Score ↔ ABC, Score → MIDI). The app's own `ScoreDoc` then sits one hop beyond it, so ABC → ScoreDoc is naturally a two-hop route (ABC → musicxml-io Score → ScoreDoc).

## 3. Patterns worth borrowing

### 3.1 Ranking competing candidates

| System | Evidence and order | Ranking mechanism |
|---|---|---|
| WHATWG MIME Sniffing [1] | The declared type is kept if it is XML or HTML, or if `X-Content-Type-Options: nosniff` is set. It is sniffed if unknown (`unknown/unknown`, `*/*`, missing). If it is an image, audio or video type, the sniffer checks within that family and a match overrides the declaration. The "apache bug" (`text/plain` served for binaries) triggers a text-or-binary check. Reads at most 1445 bytes. | Ordered byte patterns with a **mask** (0xFF exact, 0xDF case-insensitive ASCII, 0x00 ignore) and a set of ignorable leading bytes (whitespace, BOM) |
| shared-mime-info [2] | (1) An **explicitly provided type wins.** (2) Glob match, keeping only the highest weight and then the longest pattern; if all hits agree, done. (3) Otherwise, or on conflict, sniff magic. (4) If a glob result **equals or is a subclass of** the magic result, use the glob result. (5) Otherwise use the highest-weight glob. Fallback is `text/plain` for text and `application/octet-stream` for binary. | glob `weight` and magic `priority` (default 50, max 100); case-insensitive globs; `sub-class-of` hierarchy |
| libmagic / file(1) [3][4] | filesystem tests, then magic tests (binary patterns first; for text, the encoding is determined and then text patterns tried), then language tests; the first match wins | each entry has a computed **strength**, adjustable with `!:strength +/-/*// n`; entries are tried strongest first; `!:mime` and `!:ext` annotate the result |
| Apache Tika [5] | magic first (for XML, also the root element), then the **filename refines** the result (e.g. text → CSV), then the declared content type refines it further; a user override key (`CONTENT_TYPE_USER_OVERRIDE`) beats everything; container-aware detectors look inside zip and OLE2 | `DefaultDetector` composes the detectors found through the service loader; the type hierarchy decides "refinement" |
| FFmpeg [6] | every demuxer's `read_probe` scores the buffer; an extension match is worth `AVPROBE_SCORE_EXTENSION` = 50 and a MIME match adds `AVPROBE_SCORE_MIME_BONUS` = 30; the highest score wins | 0–100; if the best score is ≤ 25 (`AVPROBE_SCORE_RETRY`), **retry with a larger probe buffer** |
| GStreamer [7][8] | typefind functions `suggest(caps, probability)`; `decodebin` then autoplugs elements whose sink caps match, preferring higher plugin **rank** | probability NONE 0 / MINIMUM 1 / POSSIBLE 50 / LIKELY 80 / NEARLY_CERTAIN 99 / MAXIMUM 100; rank for implementations |
| loaders.gl [22][23] | forced `options.core.mimeType`, then URL extension, then response MIME type, then initial-bytes `tests`, then `fallbackMimeType`; for a Blob, the first 10 bytes are read asynchronously | **first match in list order**; no scores (a source comment reads "TODO … Use heuristics to grade matches?"); logs a `reason` string |

**The order these imply for this tool:**

1. **The explicit format named by the caller** is authoritative, as in shared-mime-info step 1, Tika's user override and loaders.gl's forced MIME type.
2. **Strong content evidence** (unambiguous magic: `MThd`, a zip with an MXL `mimetype` entry, an XML root of `score-partwise`) comes next. When the content contradicts the extension, believe the content; it is what the decoder will actually see.
3. **Extension** and **declared MIME type** add weight but do not override strong magic. A declared `application/octet-stream` or `text/plain` is the "apache bug" case and is ignored. FFmpeg's numbers are a reasonable calibration: extension = 50, MIME match adds 30, strong magic = 100.
4. **Weak content heuristics** (text that looks like YAML or TOML) are low-probability suggestions. They decide only when nothing else is available, and they are used to *refine* a generic result (Tika: `text/plain` + `.csv` → CSV).
5. **Specialisation** settles agreement: if one candidate is a subtype of another (`application/vnd.recordare.musicxml+xml` under `application/xml`; MXL under zip), pick the more specific one (shared-mime-info step 4, Tika refinement).
6. Return a **ranked list with reasons**, not a single answer. A decode that throws then tries the next candidate (as FFmpeg's retry and Tika's composite detectors do), and every failure message lists what was considered (the loaders.gl `reason` log).

### 3.2 Parameters attached to a format

- Media types already carry parameters: `text/csv; header=present; charset=utf-8` (RFC 4180 defines `charset` and `header=present|absent` as optional parameters) [14]. RFC 6838 governs how parameters are defined and says they must not change the fundamental nature of the type [13]. Structured syntax suffixes (`+json`, `+xml`, `+zip`) say "this is also parseable as X" [15], which is how specialisation can be derived automatically.
- loaders.gl puts per-format options under `options[loader.id]` (e.g. `options.csv.delimiter`), merged with the loader's defaults. dol's `ValueCodecs.csv` takes the `csv.writer` keyword arguments (delimiter, …), so a parameterised format is a **codec factory** `(params) → Codec`.
- Recommendation: accept the format reference in three equivalent forms: `'csv'`, `'text/csv;delimiter=";";header=present'` (parsed with `whatwg-mimetype` semantics [32]), or `{format: 'csv', delimiter: ';'}`. Each format declares a **params schema** (a Zod schema fits the house stack) with defaults. Merge in the order explicit params > sniffed params (papaparse-style delimiter guessing, a BOM's charset) > defaults. The same mechanism covers MIDI options (e.g. `ppq`) and YAML options (e.g. `version`).

### 3.3 Lazy loading with preload: separate the descriptor from the implementation

Every system that loads codecs lazily splits a cheap, always-present **descriptor** from an expensive **implementation**:

- Python's `encodings` search function imports `encodings.<name>` only on the first `lookup`, caches the resulting `CodecInfo` and registers aliases from `getaliases()` [9].
- Java's `ServiceLoader.stream()` yields `Provider` objects whose `type()` can be inspected *without instantiating* the provider [10]. ImageIO SPIs expose `getFormatNames`, `getFileSuffixes`, `getMIMETypes` and `canDecodeInput` before any reader is created [11].
- loaders.gl v5 root exports are "metadata-only loaders" with `preload: async () => (await import('…/yaml-loader')).YAMLLoaderWithParser`. Async APIs call it automatically, `preload(loader)` warms it, and sync APIs require the parser-bearing loader [24][25].
- p2r3/convert precomputes each handler's supported formats into `cache.json`, so the routing graph exists before any handler's `init()` runs [36].
- On the bundler side, a codec is lazy only if the code contains the literal `import('./x')` inside a thunk. Vite's `import.meta.glob('./codecs/*.ts')` produces exactly a map of such thunks [53]. That is the same seam thoremin's `defaultParsers` uses.

So a format descriptor is `{id, extensions, mimeTypes, magic, detect?, params, load: () => import(...)}`, and the registry memoises `load()` (one in-flight promise per id). `preload(ids)` calls those thunks early, for example on hover over an "Import" button or at app idle. Detection must run on descriptors only; otherwise sniffing would defeat the laziness.

### 3.4 Chaining: hub-and-spoke first, a general graph as the escape hatch

- **pandoc** avoids n² converters with a hub: readers produce the pandoc AST and writers consume it, so a new format needs one reader and/or one writer. It warns that conversions from formats richer than its AST are lossy [17]. unified does the same with mdast and hast, and with bridges (`remark-rehype`) as explicit edges between hubs [35]. EIP calls the hub a Canonical Data Model [19].
- **Spring's ConversionService** is a registry of `(source type, target type)` converters with conditional matching and type-hierarchy search, but **single hop** [18]. castgraph extends that idea to multi-hop routing with costs and a context dict.
- **GStreamer `decodebin`** is a multi-hop search driven by capabilities: after typefind it repeatedly picks the highest-ranked element whose sink caps accept the current caps, until it reaches raw media [8].
- **p2r3/convert** runs Dijkstra over formats. Each step costs `DEPTH_COST = 1`, lossy edges are multiplied by `LOSSY_COST_MULTIPLIER = 1.4`, category changes such as audio → image have their own costs, and a generic "any input" handler is penalised (`ANY_INPUT_COST = 2`) so that specific routes win [36].
- **Layered codecs** are chaining too. HTTP `Content-Encoding` is an ordered list of codings applied in sequence [12]. `.mxl` is zip ∘ MusicXML (its first zip entry, `mimetype`, holds `application/vnd.recordare.musicxml` [51]), and `.json.gz` is gzip ∘ JSON. Composing these is exactly what dol's `Codec.__add__` does (`encoder = Pipe(a.enc, b.enc)`, `decoder = Pipe(b.dec, a.dec)`).

Recommendation for this tool: model **every** edge as a codec-like object `{from, to, cost, lossy, load}`. Format decoders are edges `bytes:fmt → model:X`, encoders are `model:X → bytes:fmt`, and transforms are `model:X → model:Y`. Routing is Dijkstra over descriptors only, so no implementation is loaded until the route is chosen, and the edges on the chosen path are then preloaded in parallel. In the common case there is one hub (the app's internal schema) and routes are one or two hops. Expose `allowLossy: false` and `maxHops` options, and return the chosen route for display ("imported via ABC → Score → ScoreDoc, lossy: ornaments dropped").

### 3.5 Encoding: choosing the target is content negotiation

For export, the caller may name a format exactly (the common case) or state preferences: "something the user's DAW opens: MIDI, else MusicXML". HTTP's `Accept: audio/midi, application/vnd.recordare.musicxml+xml;q=0.8` is the standard vocabulary for that: q-values from 0 to 1 and more-specific ranges beating wildcards [12]. A tiny `negotiate(accept, registry)` that scores `q × (1 / route cost)` turns the same graph into an export picker, which is also how the UI's "Export as…" menu can be generated: list the formats reachable from `ScoreDoc`.

### 3.6 Sniffing the project's actual formats

| Format | Evidence | Strength |
|---|---|---|
| MIDI | bytes 0–3 `MThd`; RIFF-wrapped `RIFF....RMID` | certain |
| MXL | zip `PK\x03\x04`, first entry `mimetype` = `application/vnd.recordare.musicxml`, `META-INF/container.xml` [51] | certain once the zip is opened; "zip, unknown kind" from the first bytes alone (Tika's container-aware detection) |
| MusicXML | `<?xml` and/or a `<!DOCTYPE score-partwise`, or a root element `score-partwise`/`score-timewise` within the first ~1 KB | near-certain. Plain "starts with `<`" (the current thoremin rule) also matches SVG, HTML and any other XML, so it must specialise |
| ABC | first line `%abc` or `%abc-2.1`; a tune starts with `X:` followed by `T:` and ends its header with `K:` [52]; MIME `text/vnd.abc` | likely |
| JSON | after an optional BOM and whitespace, `{` or `[`, and `JSON.parse` succeeds | likely, certain if the parse succeeds (cheap for small game specs) |
| TOML | `[table]` headers and `key = value` lines | possible |
| YAML | `---` or `%YAML` at the start, `key: value` lines; note that most JSON is valid YAML; MIME `application/yaml` [16] | possible; lowest priority, and it loses ties to JSON |
| CSV | consistent delimiter counts across lines (papaparse's guesser) | possible; also yields the `delimiter` parameter |

## 4. Relation to the in-house precedents

- **castgraph** already is the routing core: kinds with `isa` predicates, edges with `cost`, multi-hop `transform`, a `context` dict, and `get_transformer` returning a composed function. What the JS tool adds: (a) `isa` returns a **confidence** with a reason (castgraph's `KindMatch` is already a truthy result carrying metadata, so this is a small step); (b) kinds for *serialised* forms are detected from external evidence (extension, MIME type, first bytes), not only from in-memory objects; (c) edges are **lazy** (`load()` thunks); (d) edges carry a `lossy` flag in addition to cost.
- **dol `Codec`** is the edge value type: an encoder/decoder pair, `+` to compose (the encoder pipes forward, the decoder pipes backward) and `~` to invert. `ValueCodecs.csv` shows that parameterised formats are codec factories. The JS equivalent is a `Codec<D, E>` with `encode`/`decode` that may be async, plus `compose` and `invert`. Zod 4.1's `z.codec(in, out, {decode, encode})` [21] is the same idea at the schema level and the natural place to validate the decoded result against the internal schema.
- **thoremin `score/load.ts`** is the ad hoc instance this tool generalises. It has hard-coded magic → extension precedence, a closed `ScoreFormat` union, an injectable `ScoreParsers` seam whose default is `() => import('./midi')`, and the shared `LoadStatus` narration. Keep the injectable seam and the status narration. Replace the closed union with registered descriptors, and the `if` chain with scored detection that specialises XML and zip.

## 5. Adopt vs build

**Option A: adopt `@loaders.gl/core` as the engine.** It fits the *shape* of the problem well: loader objects with `extensions`, `mimeTypes` and `tests`; `selectLoader`; per-loader option namespaces; `encode` with writers; and in v5, metadata-only loaders with `preload()`. Its costs:

- **Weight.** 12 kB gzipped (v4.5.4) or 19.6 kB (v5 beta) for the core functions alone, before any format, and 19 MB or 84 MB of installed dependencies (apache-arrow, math.gl geospatial, zod, probe.gl). The tree-shaken bundle stays moderate, but the dependency surface is a geospatial and Arrow stack.
- **Gaps against the brief.** Selection is first-match with no confidences and no fallback to the next candidate. `encode` has no writer selection by name, extension or MIME type, and no negotiation. There is no chaining or routing. Parameters live in `options[id]` but there is no parameterised format *reference* (`text/csv;delimiter=;`).
- **Timing.** v5 is the version with the lazy pattern, and it is a beta published the day before this check, with packages consolidated and moved.
- **No coverage for these formats.** There are no MIDI, MusicXML or ABC loaders, and its YAML and TOML loaders are new, home-grown parsers. Every music codec would be written anyway.

**Option B: adopt and wrap.** Wrap loaders.gl `selectLoader` for detection and add scoring, routing and writer selection on top. The wrapper would end up replacing most of what it wraps (selection is the part being redesigned), while still carrying the dependency weight. Not recommended.

**Option C: build a small core and adopt the extras (recommended).** The core is a registry of descriptors, a scored resolver, a memoised lazy loader with `preload`, a Dijkstra router over descriptors, and codec composition. That is a few hundred lines with no dependencies and an estimated 2–4 kB gzipped. Everything heavy stays a lazily imported extra (§2.2), registered by consumers as **plugin packs** (e.g. `music` = midi + musicxml + mxl + abc; `config` = json + yaml + toml + csv). Optional detectors plug in through the same seam: `file-type` for broad binary coverage, and `magika` for ML text classification only when a host opts in. Make the descriptor field names match loaders.gl's (`id`, `name`, `extensions`, `mimeTypes`, `tests`, `binary`, `text`, `options`) so that a loaders.gl loader can be adapted into a descriptor with a ten-line shim. That keeps loaders.gl's catalogue reachable as a plugin pack without making it the engine.

**What to take from each:**

| From | Take |
|---|---|
| loaders.gl | descriptor field names; `tests` as string, bytes or predicate; `options[formatId]` parameter namespace; metadata-only descriptor + `preload()`; a `reason` string for every selection; sync vs async parse variants |
| shared-mime-info / Tika | explicit-type-wins rule; weights/priorities; **subclass specialisation** for ties; filename and declared type *refine* a magic result; container-aware detection for zip |
| FFmpeg / GStreamer | numeric confidences (ext 50, MIME bonus 30, strong magic 100, heuristic 50 or below); retry with more bytes when the best score is low; plugin rank as the tie-break between implementations of the same format |
| WHATWG | masked byte patterns with ignorable leading bytes (BOM, whitespace); ignore generic declared types (`text/plain`, `application/octet-stream`); a hard cap on bytes read (1445 there; ~4 KB is fine here) |
| Python `codecs` / ServiceLoader | name normalisation and aliases; first-lookup lazy import plus cache; a search-function hook for dynamic families (e.g. any `*+json`) |
| HTTP | parameterised media types as the reference syntax; `Accept`/q-values for export; `Content-Encoding`-style layered codecs (zip, gzip) |
| pandoc / castgraph / p2r3 | hub-and-spoke around the app schema; Dijkstra with cost, `lossy` multiplier and hop limit; return the route |
| dol / Zod | `Codec` with `compose` (+) and `invert` (~); codec factories for parameters; validate the decoded result against the internal schema at the hub |

## 6. Decision: what was built (formatcast v0)

The recommendation (option C) was taken. The package is **formatcast** ([github.com/thorwhalen/formatcast](https://github.com/thorwhalen/formatcast)): a registry of format descriptors and transforms, scored detection, a Dijkstra router, and memoised lazy codecs, with no runtime dependency in the core (about 5 kB gzipped, error messages included) and a built-in text pack (json, ndjson, yaml via `yaml`, toml via `smol-toml`, csv/tsv with its own parser) whose codecs are separate lazy chunks.

How the patterns above landed:

- **Descriptor separate from implementation (§3.3).** A format is a descriptor (`id`, `extensions`, `mimeTypes`, `magic`, `sniff`, `params`, `kind`, `binary`) plus either inline `decode`/`encode` or `load: () => import(...)`, memoised; `preload(ids)` and `createRegistry({ preload })` load early. Detection and routing read descriptors only. A lazy descriptor can declare a direction its module lacks (`encodes: false`), so no route counts on an encoder that is not there. Field names differ from loaders.gl's (`magic` and `sniff` instead of one `tests`, because they are weighted differently); a loaders.gl loader could be mapped onto a descriptor with a short shim (not written).
- **Scored detection with fallback (§3.1).** Evidence adds up: magic 1, sniff 0.8 × confidence, extension 0.5, MIME 0.3 (configurable `weights`), read from the first 4096 bytes. An explicit format bypasses detection. `detect()` returns the ranked candidates with their evidence; `decode()` tries them best first, but never falls back past a candidate the magic, extension or MIME type vouches for unless the next one shares that evidence (so a broken `config.toml` is a TOML error, not CSV rows); `decodeWithInfo()` says which format won. If all fail, one error lists every attempt. A missing codec dependency is never masked by the fallback: it fails at once, naming the npm package to install.
- **Parameterised format references (§3.2).** `'csv'`, `'csv;delimiter=";"'`, `'text/csv; header=absent'` and `{ id: 'csv', delimiter: ';' }` are all accepted wherever a format is named, resolved by id, then extension, then MIME type. `extends` makes parameterised aliases (`tsv` is `csv` with a tab). Not yet: a validating schema per format, and sniffed params (a guessed delimiter).
- **Edges as codecs, routes as data (§3.4).** A format is two edges, `id → kind` (decode) and `kind → id` (encode); transforms are extra edges with a `cost`. Requests route along the cheapest path (castgraph), so `mxl → musicxml → song` and `yaml → data → toml` need no special code; `route()` and `resolve()` return the steps before anything runs. Not yet: a `lossy` flag and a hop limit (cost covers the first need for now).
- **Content negotiation for export (§3.5).** Not in v0: `encode` takes one target format. An Accept-style list is a natural later addition at the same option.

The music formats (MIDI, MusicXML, MXL, ABC → thoremin's `Song`) are a plugin pack owned by the consumer, registered with `createRegistry({ packs: [musicPack] })`; the README shows its shape.

## REFERENCES

1. WHATWG. [MIME Sniffing Standard](https://mimesniff.spec.whatwg.org/) (Living Standard, last updated 2026-10-19).
2. freedesktop.org. [Shared MIME-info Database specification v0.21, §2 "Unified system"](https://specifications.freedesktop.org/shared-mime-info/latest/ar01s02.html).
3. [file(1) manual page](https://man7.org/linux/man-pages/man1/file.1.html).
4. [magic(5) / magic(4) manual page](https://man7.org/linux/man-pages/man4/magic.4.html).
5. Apache Tika. [Content Detection](https://tika.apache.org/3.2.0/detection.html).
6. FFmpeg. [libavformat/avformat.h (AVPROBE_SCORE_*, av_probe_input_buffer2)](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/avformat.h).
7. GStreamer. [GstTypeFind](https://gstreamer.freedesktop.org/documentation/gstreamer/gsttypefind.html).
8. GStreamer. [decodebin](https://gstreamer.freedesktop.org/documentation/playback/decodebin.html).
9. Python. [codecs — Codec registry and base classes](https://docs.python.org/3/library/codecs.html).
10. Oracle. [java.util.ServiceLoader (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html).
11. Oracle. [javax.imageio.spi.ImageReaderSpi (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/javax/imageio/spi/ImageReaderSpi.html).
12. IETF. [RFC 9110: HTTP Semantics (§12 Content Negotiation, §8.4 Content-Encoding)](https://www.rfc-editor.org/rfc/rfc9110).
13. IETF. [RFC 6838: Media Type Specifications and Registration Procedures](https://www.rfc-editor.org/rfc/rfc6838).
14. IETF. [RFC 4180: Common Format and MIME Type for CSV Files](https://www.rfc-editor.org/rfc/rfc4180).
15. IETF. [RFC 6839: Additional Media Type Structured Syntax Suffixes](https://www.rfc-editor.org/rfc/rfc6839).
16. IETF. [RFC 9512: YAML Media Type](https://www.rfc-editor.org/rfc/rfc9512).
17. [Pandoc User's Guide](https://pandoc.org/MANUAL.html).
18. Spring Framework. [Spring Type Conversion](https://docs.spring.io/spring-framework/reference/core/validation/convert.html).
19. Hohpe & Woolf. [Enterprise Integration Patterns: Canonical Data Model](https://www.enterpriseintegrationpatterns.com/patterns/messaging/CanonicalDataModel.html).
20. Microsoft. [Anti-corruption Layer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer).
21. Zod. [Codecs (z.codec, z.encode, z.decode; introduced in Zod 4.1)](https://zod.dev/codecs).
22. loaders.gl. [selectLoader API reference](https://loaders.gl/docs/modules/core/api-reference/select-loader).
23. loaders.gl. [@loaders.gl/core on npm](https://www.npmjs.com/package/@loaders.gl/core) and [source repository](https://github.com/visgl/loaders.gl).
24. loaders.gl. [What's New (v5 in development: metadata-only loaders, lazy parser subpaths, preload)](https://loaders.gl/docs/whats-new).
25. loaders.gl. [@loaders.gl/config module (YAML/TOML; metadata-only, bundled, unbundled entry points)](https://github.com/visgl/loaders.gl/tree/master/modules/config).
26. Sindre Sorhus. [file-type](https://github.com/sindresorhus/file-type).
27. Borewit. [@file-type/xml](https://github.com/Borewit/file-type-xml).
28. Lars Kölpin. [magic-bytes.js](https://github.com/LarsKoelpin/magic-bytes).
29. Robert Kieffer. [mime](https://github.com/broofa/mime).
30. jshttp. [mime-db](https://github.com/jshttp/mime-db).
31. jshttp. [mime-types](https://github.com/jshttp/mime-types).
32. jsdom. [whatwg-mimetype](https://github.com/jsdom/whatwg-mimetype).
33. Google. [Magika](https://github.com/google/magika).
34. moshen. [wasmagic (libmagic compiled to WASM)](https://github.com/moshen/wasmagic).
35. unifiedjs. [unified](https://github.com/unifiedjs/unified).
36. p2r3. [convert (Convert to it!): src/TraversionGraph.ts, src/FormatHandler.ts](https://github.com/p2r3/convert).
37. unjs. [confbox](https://github.com/unjs/confbox).
38. Eemeli Aro. [yaml](https://eemeli.org/yaml/).
39. nodeca. [js-yaml](https://github.com/nodeca/js-yaml).
40. squirrelchat. [smol-toml](https://github.com/squirrelchat/smol-toml).
41. Rebecca Turner. [@iarna/toml](https://github.com/iarna/iarna-toml).
42. [Papa Parse](https://www.papaparse.com/).
43. d3. [d3-dsv](https://github.com/d3/d3-dsv).
44. Tone.js. [@tonejs/midi](https://github.com/Tonejs/Midi).
45. Carter Thaxton. [midi-file](https://github.com/carter-thaxton/midi-file).
46. Paul Rosen. [abcjs](https://github.com/paulrosen/abcjs).
47. tan-z-tan. [musicxml-io](https://github.com/tan-z-tan/musicxml-io).
48. ripieno. [musicxml-interfaces](https://github.com/ripieno/musicxml-interfaces).
49. [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay).
50. [Verovio](https://www.verovio.org/).
51. W3C Music Notation CG. [MusicXML 4.0: Compressed .mxl files](https://www.w3.org/2021/06/musicxml40/tutorial/compressed-mxl-files/).
52. [The abc music standard 2.1](https://abcnotation.com/wiki/abc:standard:v2.1).
53. Vite. [Features: Glob Import](https://vite.dev/guide/features#glob-import).
54. jshttp. [negotiator](https://github.com/jshttp/negotiator).
55. [Bundlephobia](https://bundlephobia.com/).
56. IANA. [Media Types registry](https://www.iana.org/assignments/media-types/media-types.xhtml).
