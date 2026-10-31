export class CredentialError extends Error {
  constructor(message, status = 400, code = 'invalid', extra = {}) {
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}
export const credentialFailure = error => error instanceof CredentialError
  ? { status: error.status, body: { ok: false, error: error.message, code: error.code, ...error.extra } }
  : { status: 500, body: { ok: false, code: 'store', error: 'Could not access saved credentials. Check the state volume and its permissions.' } };
export const validId = value => typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validText = (value, max) => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
