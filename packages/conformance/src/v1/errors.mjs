// v1/errors.mjs — the spec's error codes (22.1) as one error type.
//
// Every refusal the broker hands Buwiz Bot is {ok:false, code, message,
// retryable} with a code from the spec, so Buwiz Bot can map it to a BuwizError
// or a plugin state without parsing messages. Whether a code is retryable
// is the spec's table, not the thrower's choice.

const RETRYABLE = new Set(["rate_limited", "timeout", "plugin_unavailable", "plugin_restarted", "internal"]);

export class V1Error extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.retryable = RETRYABLE.has(code);

    if (details) this.details = details;
  }
}

/** Throws V1Error(code, message). */
export const refuse = (code, message, details) => {
  throw new V1Error(code, message, details);
};
