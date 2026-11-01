//! The plugin half of a Buwiz Bot mini app, protocol 2.0.
//!
//! A mini app is a stdio MCP server the Bot spawns. Implement [`Plugin`]
//! (your manifest, your app sources, your tools) and hand it to
//! [`cli::main`]; this crate does the rest:
//!
//! - [`Server`]: MCP over stdio, the reserved `buwiz.*` tools (provision,
//!   session certificates, ticket titles, uninstall), and the caller checks
//!   before any tool of yours runs;
//! - [`tickets`]: what your subjects are called outside your process;
//! - [`manifest`]: the protocol's constants, fingerprints and digests, and
//!   the signed file a running plugin serves;
//! - [`testing`]: a provisioned server for your own tests, with calls as
//!   the model, a resolve, a routine or an app;
//! - [`jcs`], [`b64`], [`key`]: the canonical JSON, base64url and ed25519
//!   signing the protocol is built on.
//!
//! ```no_run
//! use buwiz_plugin::{Args, Caller, Plugin, Tool, ok};
//! use serde_json::{Value, json};
//!
//! struct Hello;
//!
//! impl Plugin for Hello {
//!     const ID: &'static str = "app.buwiz.hello";
//!     const NAME: &'static str = "hello-mini-app";
//!     const VERSION: &'static str = env!("CARGO_PKG_VERSION");
//!     const RELEASE_KEY_ID: &'static str = "gc-2026-01";
//!
//!     fn manifest(key_id: &str) -> Value {
//!         json!({ "protocol": buwiz_plugin::PROTOCOL, "id": Self::ID, "short": "hello" /* … */ })
//!     }
//!     fn tools(&self) -> Vec<Tool> {
//!         vec![Tool { name: "hello_greet", description: "Say hello.", input_schema: json!({"type": "object"}), read_only: true }]
//!     }
//!     fn call(&mut self, _tool: &str, _args: &Args, _caller: &Caller) -> Value {
//!         ok(json!({ "greeting": "Hello, world" }))
//!     }
//!     fn ticket_title(&mut self, _ticket: &str) -> Option<String> { None }
//!     fn uninstall(&mut self) {}
//! }
//!
//! fn main() -> std::process::ExitCode {
//!     buwiz_plugin::cli::main(|| Ok(Hello))
//! }
//! ```

use serde_json::{Value, json};

pub mod b64;
pub mod cli;
pub mod jcs;
pub mod key;
pub mod manifest;
mod server;
pub mod testing;
pub mod tickets;

pub use manifest::PROTOCOL;
pub use server::{
    Args, CERT_MAX_MS, Caller, INVALID_PARAMS, INVALID_REQUEST, MCP_PROTOCOL, METHOD_NOT_FOUND,
    Origin, PARSE_ERROR, Plugin, RESERVED, Server, Tool, serve_stdio,
};
pub use tickets::{Tickets, is_ticket, new_ticket};

/// A tool result whose `structuredContent` is `structured`.
pub fn ok(structured: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": structured.to_string() }],
        "structuredContent": structured,
        "isError": false,
    })
}

/// A refusal with a protocol error code (`not_found`, `invalid_args`,
/// `permission_denied`…). The message is user-facing, comes first, and
/// carries no subject data.
pub fn fail(code: &str, message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "structuredContent": { "code": code, "message": message },
        "isError": true,
    })
}
