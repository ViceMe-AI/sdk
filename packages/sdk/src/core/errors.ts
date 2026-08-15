/**
 * Public error model.
 *
 * Consumers branch on the stable `code` only — never on `message` text.
 * Error payloads must never contain provider responses, tokens, cookies, or
 * internal stack traces; `toJSON()` exposes the safe diagnostic subset.
 */

export type ViceMeErrorCode =
  | 'CONFIG_INVALID'
  | 'WORK_NOT_FOUND'
  | 'ORIGIN_NOT_ALLOWED'
  | 'CAPABILITY_DISABLED'
  | 'CLIENT_DESTROYED'
  | 'SESSION_EXPIRED'
  | 'AUTH_REQUIRED'
  | 'AUTH_POPUP_BLOCKED'
  | 'AUTH_CANCELLED'
  | 'RETURN_URL_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'NETWORK_TIMEOUT'
  | 'CHECKOUT_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ViceMeErrorInit {
  code: ViceMeErrorCode;
  message: string;
  retryable?: boolean;
  /** Server-assigned request id echoed back for support correlation. */
  requestId?: string;
  /** Capability the error belongs to, when scoped to one. */
  capability?: string;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<ViceMeErrorCode> = new Set([
  'RATE_LIMITED',
  'NETWORK_TIMEOUT',
  'CHECKOUT_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export class ViceMeError extends Error {
  readonly code: ViceMeErrorCode;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly capability?: string;

  constructor(init: ViceMeErrorInit) {
    super(init.message);
    this.name = 'ViceMeError';
    this.code = init.code;
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT.has(init.code);
    this.requestId = init.requestId;
    this.capability = init.capability;
  }

  /** Safe, stable-shape serialization for logs and `viceme:error` events. */
  toJSON(): {
    code: ViceMeErrorCode;
    retryable: boolean;
    requestId?: string;
    capability?: string;
  } {
    const json: {
      code: ViceMeErrorCode;
      retryable: boolean;
      requestId?: string;
      capability?: string;
    } = { code: this.code, retryable: this.retryable };
    if (this.requestId !== undefined) json.requestId = this.requestId;
    if (this.capability !== undefined) json.capability = this.capability;
    return json;
  }
}

export function isViceMeError(value: unknown): value is ViceMeError {
  return value instanceof ViceMeError;
}

/** Build a CONFIG_INVALID error with a stable, non-sensitive message. */
export function configInvalid(message: string): ViceMeError {
  return new ViceMeError({ code: 'CONFIG_INVALID', message, retryable: false });
}

/** Build a CLIENT_DESTROYED error for post-destroy calls. */
export function clientDestroyed(): ViceMeError {
  return new ViceMeError({
    code: 'CLIENT_DESTROYED',
    message: 'ViceMe client has been destroyed.',
    retryable: false,
  });
}
