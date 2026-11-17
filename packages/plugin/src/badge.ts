// A badge on a pin: _meta["buwiz/badge"] (spec 16.4).
//
// Any tool result may carry one badge for one of the plugin's apps: a dot and
// up to 8 characters the host shows on the pins of that app. A badge is
// checked as it is made, so a plugin cannot put a malformed one on a result
// by accident; withBadge puts it there.
//
// The host takes a text as written (1 to 8 characters, no hidden character
// (spec 4.2), no space at either end). badge() trims plain spaces (U+0020
// only) from the text it is given before it checks it and refuses what the host
// would call malformed; the Rust Badge::new does the same, so both halves
// accept and refuse exactly the same inputs.

import { type Json } from "./jcs";
import type { Result } from "./server";
import { isTicket } from "./tickets";

/** The `_meta` key. */
export const BADGE_KEY = "buwiz/badge";

/** The most characters a badge's text has. */
export const BADGE_TEXT_MAX = 8;

/** A badge's dot. "none" shows no dot. */
export type Dot = "red" | "amber" | "green" | "none";

/** Why a badge was refused as it was made. */
export type BadgeReason = "app" | "dot" | "empty" | "text_empty" | "text_too_long" | "text_hidden" | "ticket" | "meta" | "badge";

const WHY: Record<BadgeReason, string> = {
  app: "the app id breaks the app id grammar",
  dot: "a badge's dot is red, amber, green or none",
  empty: "a badge shows a dot other than none, or text; to remove one use clearBadge",
  text_empty: "a badge's text is empty; leave it out",
  text_too_long: "a badge's text is at most 8 characters",
  text_hidden: "a badge's text has a hidden character (spec 4.2)",
  ticket: "the ticket breaks the ticket grammar",
  meta: "the result is not an object, or its _meta is not",
  badge: "withBadge takes a Badge made by badge() or clearBadge()",
};

export class BadgeError extends Error {
  constructor(readonly reason: BadgeReason) {
    super(WHY[reason]);
    this.name = "BadgeError";
  }
}

type Wire = { app: string; dot?: Dot; text?: string; ticket?: string; clear?: true };

const MADE = Symbol("badge");

/** A badge made by `badge()` or `clearBadge()`: the only values `withBadge` takes, so a malformed one
 *  cannot be built by hand. `toJSON()` is the value of `_meta["buwiz/badge"]`. */
export class Badge {
  readonly #wire: Wire;

  /** Use `badge()` or `clearBadge()`. */
  private constructor(made: typeof MADE, wire: Wire) {
    if (made !== MADE) throw new TypeError("make a Badge with badge() or clearBadge()");
    this.#wire = wire;
  }

  /** @internal */
  static make(wire: Wire): Badge {
    return new Badge(MADE, wire);
  }

  /** @internal Whether `x` was made by `badge()` or `clearBadge()` (it holds the private wire value). */
  static is(x: unknown): x is Badge {
    return typeof x === "object" && x !== null && #wire in x;
  }

  toJSON(): Json {
    return { ...this.#wire };
  }
}

const DOTS: readonly string[] = ["red", "amber", "green", "none"];
const isApp = (app: unknown): boolean => typeof app === "string" && APP_ID.test(app);
const APP_ID = /^[a-z][a-z0-9-]{0,47}$/;
/** A hidden character (spec 4.2): one that changes how a text reads, or whether it is one line, without
 *  showing. Explicit ranges, so no Unicode table decides it: the C0 and C1 controls and U+007F, U+00AD, U+061C,
 *  U+180E, U+200B to U+200F, U+2028 to U+202E (the line and paragraph separators and the bidi overrides),
 *  U+2060 to U+206F, U+FE00 to U+FE0F, U+FEFF, U+FFF9 to U+FFFB and U+E0000 to U+E0FFF. */
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E0FFF}]/u;

/** A badge for `app`: a dot other than "none", text, or both. Plain spaces (U+0020, nothing else) are
 *  trimmed from the text's ends; what is left must be 1 to 8 characters with no hidden character (spec 4.2), or this throws a BadgeError: the text is never cut. `ticket` narrows the
 *  badge to the pins that carry it. */
export function badge(app: string, opts: { dot?: Dot; text?: string; ticket?: string }): Badge {
  if (!isApp(app)) throw new BadgeError("app");
  if (opts.dot !== undefined && !DOTS.includes(opts.dot)) throw new BadgeError("dot");
  const wire: Wire = { app };
  if (opts.dot !== undefined) wire.dot = opts.dot;
  if (opts.text !== undefined) {
    const text = opts.text.replace(/^ +| +$/g, "");
    if (text === "") throw new BadgeError("text_empty");
    if (HIDDEN.test(text)) throw new BadgeError("text_hidden");
    if ([...text].length > BADGE_TEXT_MAX) throw new BadgeError("text_too_long");
    wire.text = text;
  }
  if (wire.text === undefined && (wire.dot === undefined || wire.dot === "none")) throw new BadgeError("empty");
  if (opts.ticket !== undefined) {
    if (!isTicket(opts.ticket)) throw new BadgeError("ticket");
    wire.ticket = opts.ticket;
  }
  return Badge.make(wire);
}

/** The badge that removes `app`'s badge, or the one of the pins with `ticket`. */
export function clearBadge(app: string, ticket?: string): Badge {
  if (!isApp(app)) throw new BadgeError("app");
  if (ticket !== undefined && !isTicket(ticket)) throw new BadgeError("ticket");
  return Badge.make(ticket === undefined ? { app, clear: true } : { app, clear: true, ticket });
}

/** `result` with `_meta["buwiz/badge"]` set to `b`; the rest of its `_meta` stays. A result with no
 *  `_meta`, or a null one, gets one. A result that is not an object, a `_meta` that is anything but an object, or a
 *  `b` that is not a Badge made by `badge()` or `clearBadge()` is the author's error: this throws a BadgeError
 *  ("meta" or "badge"). A result that fails (`isError`) has its badge ignored by the host. */
export function withBadge(result: Result, b: Badge): Result {
  if (!Badge.is(b)) throw new BadgeError("badge");
  const r: unknown = result;
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new BadgeError("meta");
  const meta: unknown = (r as { _meta?: unknown })._meta;
  if (meta !== undefined && meta !== null && (typeof meta !== "object" || Array.isArray(meta))) throw new BadgeError("meta");
  return { ...result, _meta: { ...(meta as Record<string, Json> | undefined | null), [BADGE_KEY]: b.toJSON() } };
}
