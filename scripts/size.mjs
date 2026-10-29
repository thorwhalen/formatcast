// Bundle size of the entry (what a consumer pays before any codec loads), minified + gzipped.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const entries = { core: 'dist/index.js', csv: 'dist/text/csv.js', yaml: 'dist/text/yaml.js', toml: 'dist/text/toml.js' };
for (const [name, entry] of Object.entries(entries)) {
  const out = await build({ entryPoints: [entry], bundle: true, minify: true, format: 'esm', write: false, splitting: false, outdir: 'x', platform: 'browser', external: name === 'core' ? ['./text/csv.js', './text/yaml.js', './text/toml.js', './csv.js', './yaml.js', './toml.js'] : [] });
  const js = out.outputFiles.find((f) => f.path.endsWith('.js')).contents;
  console.log(`${name.padEnd(5)} ${(js.length / 1024).toFixed(1)} kB min, ${(gzipSync(js).length / 1024).toFixed(1)} kB gzip`);
}
