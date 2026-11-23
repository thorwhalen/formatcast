/** YAML through the `yaml` package (imported only when a YAML file is decoded or encoded). Params are its parse/stringify options. */
import { parse, stringify } from 'yaml';
import type { Params } from '../types.js';

export const decode = (text: string, p: Params): unknown => parse(text, p);
/**
 * Output is 1.1-safe by default: strings a YAML 1.1 reader takes as booleans or null (`y`, `n`, `yes`, `no`, `on`, `off`, ...)
 * are quoted, so a file written here keeps its meaning in PyYAML, editors and linters. Pass `version: '1.2'` to opt out.
 */
export const encode = (value: unknown, p: Params): string => stringify(value, { version: '1.1', ...p });
