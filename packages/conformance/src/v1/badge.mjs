// v1/badge.mjs: a tool result's `_meta["buwiz/badge"]` as the host reads it (spec 16.4).
import { isV1 } from "../grammar.mjs";
import { isObject, isString } from "./jcs.mjs";

// a badge's dots and its text's longest (16.4)
const BADGE_DOTS = ["red", "amber", "green", "none"];
export const BADGE_TEXT_MAX = 8;

/** A hidden character (spec 4.2): one that changes how a text reads, or whether it is one line, without
 *  showing. Explicit ranges, so no Unicode table decides it: the C0 and C1 controls and U+007F, U+00AD,
 *  U+061C, U+180E, U+200B to U+200F, U+2028 to U+202E (the line and paragraph separators and the bidi
 *  overrides), U+2060 to U+206F, U+FE00 to U+FE0F, U+FEFF, U+FFF9 to U+FFFB and U+E0000 to U+E0FFF. */
export const HIDDEN =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E0FFF}]/u;

/** Why a tool result's `_meta["buwiz/badge"]` `b` is malformed (16.4), or `null`.
 *  `m` is the plugin's manifest: the app is one of its own. The host drops a
 *  malformed badge and the result still goes through. The text is taken as
 *  written: nothing is trimmed here. */
export function badgeProblem(m, b) {
  if (!isObject(b)) return "it is not an object";

  if (!isString(b.app)) return "app is not a string";

  if (!(m.apps || []).some((a) => a.id === b.app)) return "app is not an app of this plugin";

  if (b.ticket !== undefined && b.ticket !== null && !isV1("ticket", b.ticket)) return "ticket breaks the ticket grammar";

  if ("clear" in b) {
    if (b.clear !== true) return "clear is not true";

    return "dot" in b || "text" in b ? "a clear carries only app and ticket" : null;
  }

  if ("dot" in b && !BADGE_DOTS.includes(b.dot)) return "dot is not red, amber, green or none";

  if ("text" in b) {
    if (!isString(b.text)) return "text is not a string";

    if (b.text === "") return "text is empty";

    if (HIDDEN.test(b.text)) return "text has a hidden character";

    if (b.text.startsWith(" ") || b.text.endsWith(" ")) return "text starts or ends with a space";

    if ([...b.text].length > BADGE_TEXT_MAX) return "text is over 8 characters";
  }

  return !("text" in b) && (!("dot" in b) || b.dot === "none") ? "it sets nothing: a badge shows a dot or text, and a clear is clear: true" : null;
}
