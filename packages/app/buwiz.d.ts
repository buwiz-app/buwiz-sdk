// Types for TSX mini apps: the `buwiz` bridge (Mini App Protocol 2.0, sdk
// "1"), as the Bot's server/sdk/mini-app/docs/bridge.md describes it.
//
// An app imports `{ buwiz } from "buwiz"` (also the global `buwiz`), and
// only `nsh`, `nsh/base` and `buwiz`. A method whose permission the
// manifest does not grant is absent (undefined), so the optional members
// below are the granted ones; test for them (`if (buwiz.copy) …`).
//
// nsh's own types come from nsh (`.nsh/types`, generated from its Rust
// sources); until they ship here, `nsh` and `nsh/base` are untyped.

declare module "nsh";
declare module "nsh/base";

declare module "buwiz" {
  /** A JSON value. */
  export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

  /** Every rejection. Retryable: rate_limited, timeout, plugin_unavailable,
   *  plugin_restarted, internal. */
  export interface BuwizError extends Error {
    code:
      | "permission_denied"
      | "disabled"
      | "not_found"
      | "invalid_args"
      | "tool_error"
      | "result_too_large"
      | "timeout"
      | "rate_limited"
      | "plugin_unavailable"
      | "plugin_restarted"
      | "closed"
      | "not_declared"
      | "consent_declined"
      | "not_supported"
      | "no_chat"
      | "quota_exceeded"
      | "internal"
      | (string & {});
    retryable: boolean;
    message: string;
    details?: Json;
  }

  export interface Viewport {
    width: number;
    height: number;
    placement: "full" | "inline";
  }

  /** A footer button of an inline card (at most 3, one primary). */
  export interface Action {
    /** 1 to 64 of A-Z a-z 0-9 _ . : - */
    id: string;
    /** One line, 1 to 24 characters. */
    label: string;
    primary?: boolean;
    disabled?: boolean;
  }

  export interface PickedFile {
    name: string;
    size: number;
    type: string;
    read(): Promise<Uint8Array>;
  }

  export interface Buwiz {
    /** The open's props, validated against apps[].props; read-only. */
    readonly props: Readonly<Record<string, Json>>;
    readonly app: { plugin: string; app: string; version: string; fingerprint: string; protocol: string; sdk: string };
    /** A signal: call it for the current viewport. */
    viewport(): Viewport;
    /** Inline: size the card to `height` points (within inline.min_height ..
     *  max_height). Full screen: ignored. */
    fit(height: number): void;
    /** Inline: up to 3 footer buttons; [] removes them. */
    actions(list: Action[]): Promise<void>;
    /** A press of an enabled button calls `handler` with its id. Returns a
     *  function that removes the handler. */
    onAction(handler: (id: string) => void): () => void;
    /** Inline: a short status after the card's title (32 characters);
     *  null removes it. */
    meta(meta: { text: string; pill?: boolean } | null): Promise<void>;
    /** Inline: collapse the card to one outcome line (120 characters) and
     *  unmount the app. There is no undo. */
    settle(text: string): Promise<void>;
    ticket: {
      /** A ticket's title, or null. */
      title(ticket: string): Promise<string | null>;
    };

    /** permissions.tools: call one of your plugin's tools. Resolves to its
     *  structuredContent, else its text. */
    call?<T = Record<string, Json>>(tool: string, args?: Record<string, Json>): Promise<T>;
    /** permissions.open: push one of your apps, or open an https URL of a
     *  listed origin after the user agrees. */
    open?(target: { app: string; props?: Record<string, Json>; ticket?: string } | { url: string }): Promise<void>;
    /** permissions.attach: "Attach … to this chat?" */
    attach?(scope: string, value: string): Promise<{ token: string; title: string; attached: boolean }>;
    /** permissions.pick_file: [] on cancel; never a path. */
    pickFile?(options?: { extensions?: string[]; multiple?: boolean }): Promise<PickedFile[]>;
    /** permissions.storage: strings, private to this app. */
    storage?: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<void>;
      remove(key: string): Promise<void>;
      keys(): Promise<string[]>;
    };
    /** permissions.copy */
    copy?(text: string): Promise<void>;
    /** permissions.preview: show the document `tool` makes, with Print. */
    preview?(request: { tool: string; args?: Record<string, Json>; title?: string }): Promise<void>;
  }

  export const buwiz: Buwiz;
}

declare const buwiz: import("buwiz").Buwiz;
