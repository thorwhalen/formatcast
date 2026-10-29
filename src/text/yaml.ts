/** YAML through the `yaml` package (imported only when a YAML file is decoded or encoded). Params are its parse/stringify options. */
import { parse, stringify } from 'yaml';
import type { Params } from '../types.js';

export const decode = (text: string, p: Params): unknown => parse(text, p);
export const encode = (value: unknown, p: Params): string => stringify(value, p);
