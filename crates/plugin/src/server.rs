//! MCP over stdio: JSON-RPC 2.0, one message per line.
//!
//! Methods: `initialize`, `ping`, `tools/list`, `tools/call`,
//! `resources/list`, `resources/templates/list`, `resources/read`.
//! Notifications get no answer. Resources (the manifest and the TSX app
//! sources) are readable before `buwiz.provision`; tools are not (P7).
//!
//! The reserved tools are answered here: `buwiz.provision`,
//! `buwiz.session.open`, `buwiz.session.close`, `buwiz.ticket.resolve`,
//! `buwiz.uninstall`, `buwiz.account.set` and `buwiz.account.clear`; any
//! other `buwiz.*` name is -32601. Pushed account tokens stay in memory
//! and reach a tool through [`Caller::account`]. Before a
//! plugin's own tool runs, [`Server`] checks its caller against the served
//! manifest (see [`Server::authorize`]).
//!
//! Nothing is logged: no argument, no subject and never the key (P4).

use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{Map, Value, json};

use crate::accounts::{Account, Accounts};
use crate::key::PluginKey;
use crate::manifest::{self, Served};
use crate::{b64, fail, ok};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// The MCP revision this server speaks (the broker's).
pub const MCP_PROTOCOL: &str = "2025-11-25";

/// The reserved tools.
pub const RESERVED: [&str; 7] = [
    "buwiz.provision",
    "buwiz.session.open",
    "buwiz.session.close",
    "buwiz.ticket.resolve",
    "buwiz.uninstall",
    "buwiz.account.set",
    "buwiz.account.clear",
];

/// The longest session a certificate may cover: 8 hours.
pub const CERT_MAX_MS: i64 = 8 * 3600 * 1000;

/// A tool's arguments.
pub type Args = Map<String, Value>;

/// One of the plugin's own tools, as `tools/list` shows it.
#[derive(Debug, Clone)]
pub struct Tool {
    /// `<short>_<name>`.
    pub name: &'static str,
    /// What the model reads to choose it.
    pub description: &'static str,
    /// JSON Schema of the arguments.
    pub input_schema: Value,
    /// Changes nothing. Resolve tools, a routine's query and a routine's
    /// turn may call only read-only tools (and a routine's declared writes).
    pub read_only: bool,
}

/// Who asked: `_meta["buwiz/caller"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// An app, through `buwiz.call`.
    App,
    /// The model.
    Agent,
    /// A routine's query.
    Routine,
    /// A command's or scope's resolve.
    Resolve,
    /// No caller: the broker sent none.
    Unknown,
}

/// The caller of a tool call.
#[derive(Debug, Clone)]
pub struct Caller {
    pub origin: Origin,
    /// The app, for [`Origin::App`].
    pub app: Option<String>,
    /// The open the app call came from, for [`Origin::App`].
    pub open_id: Option<String>,
    /// The routine whose turn or query this is.
    pub routine: Option<String>,
    /// The accounts the host has pushed (in memory; `Debug` hides tokens).
    pub accounts: Accounts,
}

impl Caller {
    /// `_meta["buwiz/caller"]` of a `tools/call`.
    pub fn of(params: &Value) -> Self {
        let caller = params
            .get("_meta")
            .and_then(|meta| meta.get("buwiz/caller"));
        let text = |key: &str| {
            caller
                .and_then(|c| c.get(key))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let origin = match text("origin").as_deref() {
            Some("app") => Origin::App,
            Some("agent") => Origin::Agent,
            Some("routine") => Origin::Routine,
            Some("resolve") => Origin::Resolve,
            _ => Origin::Unknown,
        };
        Self {
            origin,
            app: text("app"),
            open_id: text("open_id"),
            routine: text("routine"),
            accounts: Accounts::default(),
        }
    }

    /// `account`'s live token: its `default` sign-in, else any live one.
    /// `None`: answer [`crate::account_required`] so the host asks the
    /// person to sign in.
    pub fn account(&self, account: &str) -> Option<&Account> {
        self.accounts.get(account)
    }
}

/// A mini app's own half: its manifest, app sources and tools. [`Server`]
/// does the rest.
pub trait Plugin {
    /// The plugin id: reverse DNS, `app.buwiz.<name>` for Buwiz's own.
    const ID: &'static str;
    /// The MCP server name (`serverInfo.name`), e.g. the binary's name.
    const NAME: &'static str;
    /// The MCP server version (`serverInfo.version`).
    const VERSION: &'static str;
    /// The publisher key id a release manifest is signed under.
    const RELEASE_KEY_ID: &'static str;
    /// MCP `instructions`: approved text the model reads.
    const INSTRUCTIONS: &'static str = "";

    /// The unsigned manifest under publisher key id `key_id`.
    fn manifest(key_id: &str) -> Value;

    /// A TSX app's source exactly as served; `None` for a native screen or
    /// an unknown id.
    fn app_source(_id: &str) -> Option<&'static str> {
        None
    }

    /// The plugin's own tools, in `tools/list` order.
    fn tools(&self) -> Vec<Tool>;

    /// Run one of [`Plugin::tools`]. The caller has been checked against
    /// the served manifest; checks of your own subjects are yours (P1).
    fn call(&mut self, tool: &str, args: &Args, caller: &Caller) -> Value;

    /// `buwiz.ticket.resolve`: the title of a ticket this plugin issued,
    /// never its subject.
    fn ticket_title(&mut self, ticket: &str) -> Option<String>;

    /// `buwiz.uninstall`: forget every ticket and subject.
    fn uninstall(&mut self);
}

/// The server: the plugin, the manifest it serves, the provisioned key
/// and the opens it certified.
pub struct Server<P: Plugin> {
    plugin: P,
    served: Served,
    key: Option<PluginKey>,
    /// open_id -> app id, for opens this process certified.
    sessions: HashMap<String, String>,
    /// Tokens the host pushed (`buwiz.account.set`).
    accounts: Accounts,
}

impl<P: Plugin> Server<P> {
    /// Serve the manifest [`Served::from_env`] finds.
    pub fn new(plugin: P) -> Self {
        let served = Served::from_env(P::ID, &P::manifest(P::RELEASE_KEY_ID));
        Self::with_manifest(plugin, served)
    }

    /// Serve `served`.
    pub fn with_manifest(plugin: P, served: Served) -> Self {
        Self {
            plugin,
            served,
            key: None,
            sessions: HashMap::new(),
            accounts: Accounts::default(),
        }
    }

    pub fn plugin(&self) -> &P {
        &self.plugin
    }

    pub fn plugin_mut(&mut self) -> &mut P {
        &mut self.plugin
    }

    /// One line in; the line to answer, if any.
    pub fn handle_line(&mut self, line: &str) -> Option<String> {
        if line.trim().is_empty() {
            return None;
        }
        let reply = match serde_json::from_str::<Value>(line) {
            Ok(message) => self.handle(&message),
            Err(_) => Some(error_response(Value::Null, PARSE_ERROR, "parse error")),
        };
        reply.map(|value| value.to_string())
    }

    /// One JSON-RPC message; `None` for a notification.
    pub fn handle(&mut self, message: &Value) -> Option<Value> {
        let Some(object) = message.as_object() else {
            return Some(error_response(
                Value::Null,
                INVALID_REQUEST,
                "expected a single JSON-RPC object",
            ));
        };
        let id = object.get("id").cloned();
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return id.map(|id| error_response(id, INVALID_REQUEST, "missing method"));
        };
        let id = id?;
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        let outcome = match method {
            "initialize" => Ok(self.initialize()),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(self.tool_list()),
            "tools/call" => self.tools_call(&params),
            "resources/list" => Ok(self.resource_list()),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "resources/read" => self.resource_read(&params),
            other => {
                let shown: String = other.chars().take(60).collect();
                Err((METHOD_NOT_FOUND, format!("method not found: {shown}")))
            }
        };
        Some(match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => error_response(id, code, &message),
        })
    }

    fn initialize(&self) -> Value {
        let mut result = json!({
            "protocolVersion": MCP_PROTOCOL,
            "capabilities": {
                "tools": { "listChanged": false },
                "resources": { "listChanged": false, "subscribe": false },
            },
            "serverInfo": { "name": P::NAME, "version": P::VERSION },
        });
        if !P::INSTRUCTIONS.is_empty() {
            result["instructions"] = json!(P::INSTRUCTIONS);
        }
        result
    }

    fn tool_list(&self) -> Value {
        let mut list: Vec<Value> = RESERVED
            .iter()
            .map(|name| json!({ "name": name, "description": "Reserved for the Buwiz Bot.", "inputSchema": { "type": "object" } }))
            .collect();
        list.extend(self.plugin.tools().into_iter().map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "annotations": { "readOnlyHint": tool.read_only },
            })
        }));
        json!({ "tools": list })
    }

    fn tools_call(&mut self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).ok_or((
            INVALID_PARAMS,
            "tools/call requires params.name".to_string(),
        ))?;
        let empty = Map::new();
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => &empty,
            Some(Value::Object(arguments)) => arguments,
            Some(_) => return Ok(fail("invalid_args", "arguments must be a JSON object")),
        };
        if name.starts_with("buwiz.") {
            return self.reserved(name, arguments);
        }
        // P7: nothing before a successful provision
        if self.key.is_none() {
            return Err((INVALID_REQUEST, "buwiz.provision must come first".into()));
        }
        let Some(tool) = self.plugin.tools().into_iter().find(|t| t.name == name) else {
            return Err((INVALID_PARAMS, "no such tool".into()));
        };
        let mut caller = Caller::of(params);
        caller.accounts = self.accounts.clone();
        if let Err(message) = self.authorize(&tool, &caller) {
            return Ok(fail("permission_denied", &message));
        }
        Ok(self.plugin.call(name, arguments, &caller))
    }

    /// The checks every plugin makes before its own tool runs:
    ///
    /// - an app's call comes from an open this process certified for that
    ///   app, and names a tool in the app's `permissions.tools`;
    /// - a resolve and a routine's query only read;
    /// - a routine's turn only reads, or calls a write its routine declares.
    pub fn authorize(&self, tool: &Tool, caller: &Caller) -> Result<(), String> {
        let name = tool.name;
        let served = self.served.value()?;
        if caller.origin == Origin::App {
            let app = caller.app.as_deref().ok_or("an app call names no app")?;
            let open = caller.open_id.as_deref().unwrap_or("");
            if self.sessions.get(open).map(String::as_str) != Some(app) {
                return Err("this app open was not certified by this plugin".into());
            }
            let entry = manifest::app(&served, app).ok_or("no such app")?;
            if !manifest::app_tools(entry).any(|t| t == name) {
                return Err(format!("{name} is not in this app's permissions"));
            }
        }
        if tool.read_only {
            return Ok(());
        }
        if matches!(caller.origin, Origin::Resolve | Origin::Routine) {
            return Err(format!("{name} changes data, so it does not run here"));
        }
        if let Some(routine) = &caller.routine
            && !manifest::routine_writes(&served, routine).any(|w| w == name)
        {
            return Err(format!("{name} is not a write this routine declares"));
        }
        Ok(())
    }

    fn reserved(&mut self, name: &str, arguments: &Args) -> Result<Value, (i64, String)> {
        if !RESERVED.contains(&name) {
            return Err((
                METHOD_NOT_FOUND,
                "not a reserved tool of this plugin".into(),
            ));
        }
        if name == "buwiz.provision" {
            return Ok(self.provision(arguments));
        }
        if self.key.is_none() {
            return Err((INVALID_REQUEST, "buwiz.provision must come first".into()));
        }
        Ok(match name {
            "buwiz.session.open" => self.session_open(arguments, now_ms()),
            "buwiz.session.close" => {
                if let Some(open_id) = arguments.get("open_id").and_then(Value::as_str) {
                    self.sessions.remove(open_id);
                }
                ok(json!({ "ok": true }))
            }
            "buwiz.ticket.resolve" => {
                let ticket = arguments
                    .get("ticket")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match self.plugin.ticket_title(ticket) {
                    Some(title) => {
                        let title: String = title.chars().take(120).collect();
                        ok(json!({ "valid": true, "title": title }))
                    }
                    None => ok(json!({ "valid": false })),
                }
            }
            "buwiz.account.set" => self.accounts.set(arguments),
            "buwiz.account.clear" => self.accounts.clear(arguments),
            _ => {
                self.plugin.uninstall();
                self.sessions.clear();
                self.accounts.forget();
                ok(json!({ "ok": true }))
            }
        })
    }

    fn provision(&mut self, arguments: &Args) -> Value {
        if arguments.get("plugin").and_then(Value::as_str) != Some(P::ID) {
            return fail("invalid_args", &format!("this is {}", P::ID));
        }
        // `protocol` is not checked: the Bot decides compatibility from the
        // manifest's `protocol`
        let key = match PluginKey::from_provision(arguments) {
            Ok(key) => key,
            Err(message) => return fail("invalid_args", &message),
        };
        if let Some(held) = &self.key
            && !held.same_as(&key)
        {
            return fail("invalid_args", "already provisioned with another key");
        }
        let sha256 = match self.served.sha256() {
            Ok(sha256) => sha256,
            Err(message) => return fail("manifest_invalid", &message),
        };
        self.key = Some(key);
        ok(json!({ "ok": true, "manifest_sha256": sha256 }))
    }

    fn session_open(&mut self, arguments: &Args, now_ms: i64) -> Value {
        let request = match OpenRequest::read(arguments, now_ms) {
            Ok(request) => request,
            Err(message) => return fail("invalid_args", &message),
        };
        let served = match self.served.value() {
            Ok(served) => served,
            Err(message) => return fail("manifest_invalid", &message),
        };
        let Some(app) = manifest::app(&served, &request.app) else {
            let id: String = request.app.chars().take(60).collect();
            return fail("invalid_args", &format!("no app {id}"));
        };
        match manifest::permissions_digest(app) {
            Ok(digest) if digest == request.perms_sha256 => {}
            Ok(_) => return fail("invalid_args", "perms_sha256 does not match the manifest"),
            Err(message) => return fail("manifest_invalid", &message),
        }
        let cert = request.certificate(P::ID);
        let key = self.key.as_ref().expect("provisioned before any open");
        let signature = match key.sign(&cert) {
            Ok(signature) => signature,
            Err(message) => return fail("invalid_args", &message),
        };
        self.sessions.insert(request.open_id, request.app);
        ok(json!({ "cert": cert, "cert_sig": signature }))
    }

    fn resource_list(&self) -> Value {
        let mut resources = vec![json!({
            "uri": manifest::MANIFEST_URI,
            "name": "manifest",
            "mimeType": manifest::MANIFEST_MIME,
        })];
        for id in tsx_apps::<P>() {
            resources.push(json!({
                "uri": format!("{}{id}", manifest::APP_URI_PREFIX),
                "name": id,
                "mimeType": manifest::APP_MIME,
            }));
        }
        json!({ "resources": resources })
    }

    fn resource_read(&self, params: &Value) -> Result<Value, (i64, String)> {
        let uri = params.get("uri").and_then(Value::as_str).ok_or((
            INVALID_PARAMS,
            "resources/read requires params.uri".to_string(),
        ))?;
        if uri == manifest::MANIFEST_URI {
            let text = self
                .served
                .text()
                .map_err(|error| (INVALID_PARAMS, error))?;
            return Ok(
                json!({ "contents": [{ "uri": uri, "mimeType": manifest::MANIFEST_MIME, "text": text }] }),
            );
        }
        let source = uri
            .strip_prefix(manifest::APP_URI_PREFIX)
            .and_then(P::app_source)
            .ok_or((INVALID_PARAMS, "no such resource".to_string()))?;
        Ok(json!({ "contents": [{ "uri": uri, "mimeType": manifest::APP_MIME, "text": source }] }))
    }
}

/// The ids of the TSX apps the manifest lists (those with an `entry`).
fn tsx_apps<P: Plugin>() -> Vec<String> {
    let manifest = P::manifest(P::RELEASE_KEY_ID);
    manifest["apps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|app| app.get("entry").is_some())
        .filter_map(|app| app["id"].as_str().map(str::to_string))
        .collect()
}

/// `buwiz.session.open`'s request, checked.
struct OpenRequest {
    app: String,
    open_id: String,
    ks_pub: String,
    perms_sha256: String,
    not_after: i64,
}

impl OpenRequest {
    fn read(arguments: &Args, now_ms: i64) -> Result<Self, String> {
        let text = |key: &str| -> Result<String, String> {
            arguments
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("`{key}` must be a string"))
        };
        let app = text("app")?;
        let open_id = text("open_id")?;
        if b64::decode_exact(&open_id, 16).is_none() {
            return Err("`open_id` must be 128 bits of base64url".into());
        }
        let ks_pub = text("ks_pub")?;
        if b64::decode_exact(&ks_pub, 32).is_none() {
            return Err("`ks_pub` must be a 32-byte ed25519 key in base64url".into());
        }
        let perms_sha256 = text("perms_sha256")?;
        let not_after = arguments
            .get("not_after")
            .and_then(Value::as_i64)
            .ok_or("`not_after` must be an integer (unix ms)")?;
        if not_after <= now_ms || not_after > now_ms + CERT_MAX_MS {
            return Err("not_after must be within 8 h".into());
        }
        Ok(Self {
            app,
            open_id,
            ks_pub,
            perms_sha256,
            not_after,
        })
    }

    /// The session certificate.
    fn certificate(&self, plugin: &str) -> Value {
        json!({
            "v": 1,
            "typ": "buwiz-session",
            "plugin": plugin,
            "app": self.app,
            "open_id": self.open_id,
            "ks_pub": self.ks_pub,
            "perms_sha256": self.perms_sha256,
            "not_after": self.not_after,
        })
    }
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

/// Serve stdin to stdout until stdin closes.
pub fn serve_stdio<P: Plugin>(server: &mut Server<P>) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        if let Some(reply) = server.handle_line(&line?) {
            stdout.write_all(reply.as_bytes())?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_requests_hold_not_after_to_eight_hours() {
        let base = json!({
            "app": "home", "open_id": b64::encode(&[1; 16]), "ks_pub": b64::encode(&[2; 32]),
            "perms_sha256": "0".repeat(64), "not_after": 1_000 + CERT_MAX_MS,
        });
        let args = base.as_object().unwrap();
        assert!(OpenRequest::read(args, 1_000).is_ok());
        assert!(OpenRequest::read(args, 999).is_err());
    }
}
