/** An error with a stable machine code, safe to show a user and safe to log. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 500,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UpstreamError extends AppError {
  constructor(
    readonly upstream: string,
    message: string,
    status = 502,
    details?: unknown,
  ) {
    super("upstream_error", message, status, details);
    this.name = "UpstreamError";
  }
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
