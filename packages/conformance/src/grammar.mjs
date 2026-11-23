// grammar.mjs — the names of Mini App Protocol 1.0 (spec section 4), as the
// spec writes them: ECMAScript sources over the whole string. The runner's
// host, the probe plugin and the tests read this one table, so host and
// plugin cannot drift apart.
export const V1 = Object.freeze({
  pluginId: "^[a-z][a-z0-9-]{0,62}(\\.[a-z][a-z0-9-]{0,62}){2,7}$",
  short: "^[a-z][a-z0-9]{1,15}$",
  appId: "^[a-z][a-z0-9-]{0,47}$",
  command: "^[a-z][a-z0-9-]{0,31}$",
  scope: "^[a-z][a-z0-9-]{0,31}$",
  routineId: "^[a-z][a-z0-9-]{0,47}$",
  tool: "^[a-z][a-z0-9_]{0,62}$",
  propKey: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$",
  ticket: "^tkt_[0-9A-HJKMNP-TV-Z]{26}$",
  canonicalToken: "^@([a-z][a-z0-9]{1,15}):([a-z][a-z0-9-]{0,31}):(tkt_[0-9A-HJKMNP-TV-Z]{26})$",
  typedToken: "(?<![\\w@.])@([a-z][a-z0-9]{1,15}):([a-z][a-z0-9-]{0,31}):(\\S*)",
  slash: "^/(?:([a-z][a-z0-9]{1,15}):)?([a-z][a-z0-9-]{0,31})(?:\\s+(.*))?$",
  reservedTool: "^buwiz\\.[a-z.]+$",
  publisherId: "^[a-z][a-z0-9-]{1,62}(\\.[a-z0-9-]{1,62})*$",
  keyId: "^[a-z0-9][a-z0-9-]{0,63}$",
});

// Names no plugin may take: reserved id prefixes, shorts and the built-in
// slash commands (3, 3.1).
export const V1_RESERVED = Object.freeze({
  // the app's bundle id (com.buwiz.bot), itself and under it
  idPrefixes: ["buwiz.", "com.buwiz.bot.", "com.buwiz.bot"],
  shorts: ["buwiz", "app", "chat", "mcp", "nsh", "all", "office", "skill", "routine", "bot"],
  commands: ["status", "messages"],
});

const v1Re = Object.fromEntries(Object.entries(V1).map(([k, src]) => [k, new RegExp(src)]));

/** Whether `s` is a whole `kind` name of the v1 table (V1's keys). */
export const isV1 = (kind, s) => v1Re[kind].test(String(s ?? "")) && (kind !== "pluginId" || String(s).length <= 255);
