export const EXIT = { ok: 0, failure: 1, usage: 64, timeout: 124 } as const;

export class T3Error extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Bad flags or arguments. Exits 64 (EX_USAGE). */
export class UsageError extends T3Error {
  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

/** The command's --timeout passed. Exits 124, like timeout(1). */
export class TimeoutError extends T3Error {
  constructor(message: string) {
    super(message, EXIT.timeout);
  }
}
