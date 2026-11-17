// A badge on a pin: _meta["buwiz/badge"] (spec 16.4).
//
// Any tool result may carry one badge for one of the plugin's apps: a dot and
// up to 8 characters the host shows on the pins of that app. A badge is
// checked as it is made, so a plugin cannot put a malformed one on a result
// by accident; withBadge puts it there.

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
export type BadgeReason = "app" | "dot" | "empty" | "text_too_long" | "text_not_one_line" | "ticket";

const WHY: Record<BadgeReason, string> = {
  app: "the app id breaks the app id grammar",
  dot: "a badge's dot is red, amber, green or none",
  empty: "a badge sets a dot or text; to remove one use clearBadge",
  text_too_long: "a badge's text is at most 8 characters",
  text_not_one_line: "a badge's text is one line, with no control character",
  ticket: "the ticket breaks the ticket grammar",
};

export class BadgeError extends Error {
  constructor(readonly reason: BadgeReason) {
    super(WHY[reason]);
    this.name = "BadgeError";
  }
}

/** The value of `_meta["buwiz/badge"]`. */
export type Badge = { app: string; dot?: Dot; text?: string; ticket?: string; clear?: true };

const DOTS: readonly string[] = ["red", "amber", "green", "none"];
const APP_ID = /^[a-z][a-z0-9-]{0,47}$/;
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

/** A badge for `app`: a dot, text, or both. The text is trimmed; more than 8
 *  characters, a control character or a line break throws, the text is never
 *  cut. At least one of `dot` and `text` is needed. `ticket` narrows the badge
 *  to the pins that carry it. */
export function badge(app: string, opts: { dot?: Dot; text?: string; ticket?: string }): Badge {
  if (!APP_ID.test(app)) throw new BadgeError("app");
  if (opts.dot !== undefined && !DOTS.includes(opts.dot)) throw new BadgeError("dot");
  if (opts.dot === undefined && opts.text === undefined) throw new BadgeError("empty");
  const out: Badge = { app };
  if (opts.dot !== undefined) out.dot = opts.dot;
  if (opts.text !== undefined) {
    const text = opts.text.trim();
    if (NOT_ONE_LINE.test(text)) throw new BadgeError("text_not_one_line");
    if ([...text].length > BADGE_TEXT_MAX) throw new BadgeError("text_too_long");
    out.text = text;
  }
  if (opts.ticket !== undefined) {
    if (!isTicket(opts.ticket)) throw new BadgeError("ticket");
    out.ticket = opts.ticket;
  }
  return out;
}

/** The badge that removes `app`'s badge, or the one of the pins with `ticket`. */
export function clearBadge(app: string, ticket?: string): Badge {
  if (!APP_ID.test(app)) throw new BadgeError("app");
  if (ticket !== undefined && !isTicket(ticket)) throw new BadgeError("ticket");
  return ticket === undefined ? { app, clear: true } : { app, clear: true, ticket };
}

/** `result` with `_meta["buwiz/badge"]` set to `b`; the rest of its `_meta`
 *  stays. A result that fails (`isError`) has its badge ignored by the host. */
export const withBadge = (result: Result, b: Badge): Result => ({ ...result, _meta: { ...result._meta, [BADGE_KEY]: b as Json } });
