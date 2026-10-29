/** The one error type formatcast throws, with a machine-readable `code`. */

export type ErrorCode =
  | 'NO_FORMAT' // detection found nothing, or an explicit spec names nothing registered
  | 'NO_ROUTE' // no chain of edges from the source kind to the target
  | 'MISSING_DEPENDENCY' // a lazy codec's npm package is not installed
  | 'NO_CODEC' // a format has neither an inline codec nor a loader for this direction
  | 'DECODE_FAILED' // every candidate failed; `attempts` says how
  | 'BAD_INPUT'; // an input type formatcast cannot read

export interface Attempt {
  format: string;
  error: unknown;
}

export class FormatcastError extends Error {
  readonly code: ErrorCode;
  readonly attempts?: Attempt[];

  constructor(code: ErrorCode, message: string, options: { cause?: unknown; attempts?: Attempt[] } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FormatcastError';
    this.code = code;
    if (options.attempts) this.attempts = options.attempts;
  }
}

const _MISSING_MODULE = /Cannot find (package|module)|Failed to resolve|Failed to fetch dynamically imported module|ERR_MODULE_NOT_FOUND/i;

/** Whether an import failure looks like "that package is not installed". */
export function isMissingModuleError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | undefined;
  return e?.code === 'ERR_MODULE_NOT_FOUND' || _MISSING_MODULE.test(String(e?.message ?? ''));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
