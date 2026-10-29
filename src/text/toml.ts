/** TOML through `smol-toml` (imported only when a TOML file is decoded or encoded). */
import { parse, stringify } from 'smol-toml';

export const decode = (text: string): unknown => parse(text);
export const encode = (value: unknown): string => stringify(value);
