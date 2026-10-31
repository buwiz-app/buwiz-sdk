// Tickets: what a subject (a taxpayer, a book, a document) is called
// everywhere outside the plugin process.
//
// A ticket is `tkt_` and 26 Crockford base32 characters, 130 random bits.
// The Bot, the model and the apps see only tickets; the plugin maps them
// back to its own subjects. buwiz.ticket.resolve answers a title for a
// ticket, never the subject.
//
// Tickets keeps the map in memory, so tickets die with the process. A
// plugin that needs them to outlive a restart keeps them in its own store
// and calls newTicket itself.

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHAPE = /^tkt_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A fresh ticket. */
export function newTicket(): string {
  let n = BigInt(`0x${randomBytes(17).toString("hex")}`) >> 6n;
  let s = "";
  for (let i = 0; i < 26; i++, n >>= 5n) s = CROCKFORD[Number(n & 31n)] + s;
  return `tkt_${s}`;
}

/** Whether `text` has a ticket's shape. */
export const isTicket = (text: unknown): text is string => typeof text === "string" && SHAPE.test(text);

/** Subject ↔ ticket, in this process only. One ticket per subject. */
export class Tickets<S> {
  readonly #bySubject = new Map<S, string>();
  readonly #byTicket = new Map<string, S>();

  /** The subject's ticket, issued on first use. */
  issue(subject: S): string {
    let ticket = this.#bySubject.get(subject);
    if (ticket === undefined) {
      ticket = newTicket();
      this.#bySubject.set(subject, ticket);
      this.#byTicket.set(ticket, subject);
    }
    return ticket;
  }

  /** The subject of a ticket this store issued. */
  subject(ticket: unknown): S | undefined {
    return typeof ticket === "string" ? this.#byTicket.get(ticket) : undefined;
  }

  /** Forget every ticket (buwiz.uninstall). */
  clear(): void {
    this.#bySubject.clear();
    this.#byTicket.clear();
  }
}
