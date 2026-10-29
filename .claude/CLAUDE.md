# formatcast — dev map

Seams (each one option or field; defaults are real implementations):

| seam | default | replacement in sight |
| --- | --- | --- |
| which formats exist: `createRegistry({ packs })` | built-in text pack (json, ndjson, yaml, toml, csv, tsv) | thoremin's music pack (MIDI, MusicXML, ABC → Song) |
| how a codec is obtained: a format's `load` | dynamic `import()`, cached; `preload` for eager | a consumer re-registering an id with another library |
| detection scoring: `weights`, `headSize` | magic 1, sniff 0.8, extension 0.5, MIME 0.3; 4096 bytes | per-app tuning from real misdetections |
| where decoding ends: `to` | the format's kind, followed through container formats | an app kind (`song`) reached by routing |

NOT seams: the route algorithm (Dijkstra over a handful of edges), the spec string syntax, text decoding (TextDecoder), error formatting.

Surface: JS library only. CLI/MCP would need no core change (bytes + hints in, string/bytes/JSON out); not built.

Check before committing: `npm run typecheck && npm test && npm run build && npm run size`.
