// Accounts the Bot signs the person in to (protocol 1.0 §20). The host
// pushes an access token with buwiz.account.set after provision, after each
// sign-in and after each refresh, and takes it back with buwiz.account.clear
// after sign-out, removal or a failed refresh. The plugin never asks.
//
// Tokens live in memory only: never logged, written, echoed or shown by
// JSON.stringify or console.log. A tool reads one through Caller.account.

import type { Args, Result } from "./server";

// server.ts imports this module, so these two are local (same shapes as its ok/fail)
const ok = (data: { ok: true }): Result => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
const fail = (code: string, message: string): Result => ({ content: [{ type: "text", text: message }], structuredContent: { code, message }, isError: true });

/** The label the host gives an account's first sign-in. */
export const DEFAULT_LABEL = "default";

/** Unix seconds now. */
export const nowS = (): number => Math.floor(Date.now() / 1000);

/** A pushed account: one sign-in of an account the package declares. */
export class Account {
  readonly #accessToken: string;

  constructor(
    /** The declared account id (buwiz.accounts[].id). */
    readonly account: string,
    /** The sign-in's label ("default" for the first). */
    readonly label: string,
    /** "google" or "oauth:<issuer>". */
    readonly provider: string,
    /** The signed-in subject the host shows (an email or a sub). */
    readonly subject: string,
    readonly scopes: readonly string[],
    /** "Bearer" unless the host says otherwise. */
    readonly tokenType: string,
    /** Unix seconds; undefined when the host sent none. */
    readonly expiresAt: number | undefined,
    accessToken: string,
  ) {
    this.#accessToken = accessToken;
  }

  /** The access token. Never log it, write it or put it in an answer. */
  accessToken(): string {
    return this.#accessToken;
  }

  /** An Authorization header value: "Bearer <token>" (RFC 6750's scheme is
   *  case-insensitive; this spells it Bearer). */
  authorization(): string {
    const scheme = this.tokenType.toLowerCase() === "bearer" ? "Bearer" : this.tokenType;
    return `${scheme} ${this.#accessToken}`;
  }

  /** Whether the token is still good at unix second `now`. */
  liveAt(now: number): boolean {
    return this.expiresAt === undefined || this.expiresAt > now;
  }

  toJSON(): Record<string, unknown> {
    return { account: this.account, label: this.label, provider: this.provider, expiresAt: this.expiresAt, accessToken: "…" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Account(${this.account}/${this.label}, …)`;
  }
}

const text = (args: Args, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/** The pushed accounts, by (account, label). */
export class Accounts {
  readonly #held = new Map<string, Account>();

  static #key(account: string, label: string): string {
    return JSON.stringify([account, label]);
  }

  /** buwiz.account.set {account, label, provider, subject, scopes,
   *  access_token, token_type, expires_at} → {ok: true}. */
  set(args: Args): Result {
    const account = text(args, "account");
    const label = text(args, "label");
    const accessToken = text(args, "access_token");
    if (!account || !label || !accessToken) return fail("invalid_args", "buwiz.account.set needs account, label and access_token");
    let expiresAt: number | undefined;
    const e = args.expires_at;
    if (e !== undefined && e !== null) {
      if (typeof e !== "number" || !Number.isSafeInteger(e)) return fail("invalid_args", "expires_at must be unix seconds");
      expiresAt = e;
    }
    const scopes = Array.isArray(args.scopes) ? args.scopes.filter((s): s is string => typeof s === "string") : [];
    const held = new Account(
      account,
      label,
      text(args, "provider") ?? "",
      text(args, "subject") ?? "",
      scopes,
      text(args, "token_type") ?? "Bearer",
      expiresAt,
      accessToken,
    );
    this.#held.set(Accounts.#key(account, label), held);
    return ok({ ok: true });
  }

  /** buwiz.account.clear {account, label} → {ok: true}, also when nothing
   *  was held. */
  clear(args: Args): Result {
    const account = text(args, "account");
    const label = text(args, "label");
    if (!account || !label) return fail("invalid_args", "buwiz.account.clear needs account and label");
    this.#held.delete(Accounts.#key(account, label));
    return ok({ ok: true });
  }

  /** Forget every token (buwiz.uninstall). */
  forget(): void {
    this.#held.clear();
  }

  /** `account`'s live token at unix second `now`: the "default" label's,
   *  else the first live label's (labels in order). */
  get(account: string, now: number = nowS()): Account | undefined {
    const first = this.#held.get(Accounts.#key(account, DEFAULT_LABEL));
    if (first?.liveAt(now)) return first;
    return [...this.#held.values()]
      .filter((a) => a.account === account)
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
      .find((a) => a.liveAt(now));
  }

  /** One sign-in, live or not. */
  labelled(account: string, label: string): Account | undefined {
    return this.#held.get(Accounts.#key(account, label));
  }

  /** A copy, for a caller. */
  snapshot(): Accounts {
    const copy = new Accounts();
    for (const [k, v] of this.#held) copy.#held.set(k, v);
    return copy;
  }

  toJSON(): unknown[] {
    return [...this.#held.values()].map((a) => a.toJSON());
  }
}

/** The answer of a tool that needs an account it does not hold (§20.4): the
 *  host asks the person to sign in. */
export const accountRequired = (account: string): Result => {
  const data = { code: "account_required", account };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
};
