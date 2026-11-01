//! The server against a toy plugin, through JSON-RPC lines: the provision
//! gate, session certificates, the caller checks, the reserved tools and
//! the resources.

use buwiz_plugin::key::PluginKey;
use buwiz_plugin::manifest::{self, Served};
use buwiz_plugin::{
    Args, Caller, Plugin, Server, Tickets, Tool, account_required, b64, fail, jcs, ok,
};
use serde_json::{Value, json};

const APP: &str = "export default function Board() {\n  return null;\n}\n";

#[derive(Default)]
struct Toy {
    tickets: Tickets<String>,
    calls: Vec<String>,
}

impl Plugin for Toy {
    const ID: &'static str = "app.buwiz.toy";
    const NAME: &'static str = "toy-mini-app";
    const VERSION: &'static str = "0.1.0";
    const RELEASE_KEY_ID: &'static str = "toy-test-01";
    const INSTRUCTIONS: &'static str = "Toy keeps a list.";

    fn manifest(key_id: &str) -> Value {
        json!({
            "protocol": manifest::PROTOCOL,
            "id": Self::ID,
            "short": "toy",
            "version": Self::VERSION,
            "title": "Toy",
            "publisher": { "id": "app.buwiz", "key_id": key_id, "name": "Buwiz" },
            "scopes": [{ "name": "item", "description": "Item", "resolve": "toy_resolve" }],
            "routines": [{ "id": "tidy", "name": "Tidy", "description": "Tidies.", "every_s": 3600,
                           "query": { "tool": "toy_list", "field": "text" }, "prompt": "Tidy up.",
                           "reads": [], "writes": ["toy_add"] }],
            "apps": [
                { "id": "board", "title": "Board", "description": "The list.",
                  "entry": format!("{}board", manifest::APP_URI_PREFIX), "mime": manifest::APP_MIME,
                  "sdk": manifest::APP_SDK, "fingerprint": manifest::fingerprint(APP),
                  "placement": ["full"], "permissions": { "tools": ["toy_list"] } },
                { "id": "fast", "title": "Fast", "description": "Native.",
                  "native": { "screen": "toy.fast", "abi": manifest::NATIVE_ABI },
                  "placement": ["full"], "permissions": { "tools": ["toy_list", "toy_add"] } }
            ]
        })
    }

    fn app_source(id: &str) -> Option<&'static str> {
        (id == "board").then_some(APP)
    }

    fn tools(&self) -> Vec<Tool> {
        let object = json!({ "type": "object" });
        vec![
            Tool {
                name: "toy_list",
                description: "List.",
                input_schema: object.clone(),
                read_only: true,
            },
            Tool {
                name: "toy_add",
                description: "Add.",
                input_schema: object.clone(),
                read_only: false,
            },
            Tool {
                name: "toy_resolve",
                description: "Resolve.",
                input_schema: object,
                read_only: true,
            },
        ]
    }

    fn call(&mut self, tool: &str, args: &Args, caller: &Caller) -> Value {
        self.calls.push(tool.to_string());
        if let Some(account) = args.get("needs").and_then(Value::as_str) {
            // a tool that reads with a pushed token answers its subject, never the token
            return match caller.account(account) {
                Some(held) => ok(
                    json!({ "subject": held.subject, "scheme": held.authorization().split(' ').next() }),
                ),
                None => account_required(account),
            };
        }
        match tool {
            "toy_resolve" => {
                let value = args.get("value").and_then(Value::as_str).unwrap_or("");
                ok(
                    json!({ "result": "token", "ticket": self.tickets.issue(&value.to_string()), "title": value }),
                )
            }
            "toy_add" => ok(json!({ "added": true })),
            _ => match args.get("ticket").and_then(Value::as_str) {
                Some(ticket) if self.tickets.subject(ticket).is_none() => {
                    fail("not_found", "That item is no longer available.")
                }
                _ => ok(json!({ "text": "milk" })),
            },
        }
    }

    fn ticket_title(&mut self, ticket: &str) -> Option<String> {
        self.tickets
            .subject(ticket)
            .map(|s| format!("Item {}", s.len()))
    }

    fn uninstall(&mut self) {
        self.tickets.clear();
    }
}

const SEED: [u8; 32] = [9; 32];

struct Run {
    server: Server<Toy>,
    next: i64,
}

impl Run {
    fn new() -> Self {
        let served = Served::new(None, &Toy::manifest(Toy::RELEASE_KEY_ID));
        Self {
            server: Server::with_manifest(Toy::default(), served),
            next: 0,
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let line = json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
        let reply = self
            .server
            .handle_line(&line.to_string())
            .expect("a request is answered");
        serde_json::from_str(&reply).unwrap()
    }

    fn call(&mut self, name: &str, args: Value, caller: Value) -> Value {
        self.rpc(
            "tools/call",
            json!({ "name": name, "arguments": args, "_meta": { "buwiz/caller": caller } }),
        )
    }

    fn provision(&mut self) -> Value {
        let key = PluginKey::from_seed(&SEED);
        self.call(
            "buwiz.provision",
            json!({ "protocol": "2.0.1", "plugin": Toy::ID, "key": { "alg": "ed25519", "seed": b64::encode(&SEED) }, "pub": key.public() }),
            json!(null),
        )
    }

    fn open(&mut self, app: &str, open_byte: u8) -> Value {
        let entry = manifest::app(&Toy::manifest(Toy::RELEASE_KEY_ID), app)
            .cloned()
            .unwrap_or(json!({}));
        self.call(
            "buwiz.session.open",
            json!({
                "app": app, "open_id": b64::encode(&[open_byte; 16]), "ks_pub": b64::encode(&[2; 32]),
                "perms_sha256": manifest::permissions_digest(&entry).unwrap(),
                "not_after": now() + 3_600_000,
            }),
            json!(null),
        )
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn result(reply: &Value) -> &Value {
    &reply["result"]["structuredContent"]
}

fn app_caller(app: &str, open_byte: u8) -> Value {
    json!({ "origin": "app", "plugin": Toy::ID, "app": app, "open_id": b64::encode(&[open_byte; 16]), "ts": 1 })
}

#[test]
fn nothing_runs_before_provision_and_provision_answers_the_manifest_hash() {
    let mut run = Run::new();
    let early = run.call("toy_list", json!({}), json!({ "origin": "agent" }));
    assert_eq!(early["error"]["code"], -32600);
    let early = run.call("buwiz.session.open", json!({}), json!(null));
    assert_eq!(early["error"]["code"], -32600);

    let reply = run.provision();
    let served = jcs::sha256_jcs(&Toy::manifest(Toy::RELEASE_KEY_ID)).unwrap();
    assert_eq!(result(&reply)["manifest_sha256"], served.as_str());
    // the same key again is fine; another key is refused
    assert_eq!(result(&run.provision())["ok"], true);
    let other = PluginKey::from_seed(&[3; 32]);
    let again = run.call(
        "buwiz.provision",
        json!({ "protocol": "1.0.0", "plugin": Toy::ID, "key": { "alg": "ed25519", "seed": b64::encode(&[3; 32]) }, "pub": other.public() }),
        json!(null),
    );
    assert_eq!(again["result"]["isError"], true);
}

#[test]
fn provision_refuses_another_plugin_and_leaves_the_protocol_to_the_manifest() {
    let mut run = Run::new();
    let key = PluginKey::from_seed(&SEED);
    let args = |plugin: &str, protocol: &str| json!({ "protocol": protocol, "plugin": plugin, "key": { "alg": "ed25519", "seed": b64::encode(&SEED) }, "pub": key.public() });
    let other = run.call(
        "buwiz.provision",
        args("app.buwiz.other", "1.0.0"),
        json!(null),
    );
    assert_eq!(other["result"]["isError"], true);
    // the Bot decides compatibility from the manifest's protocol
    let newer = run.call("buwiz.provision", args(Toy::ID, "2.1.0"), json!(null));
    assert_eq!(result(&newer)["ok"], true);
}

#[test]
fn a_session_certificate_is_the_request_signed_with_the_provisioned_key() {
    let mut run = Run::new();
    run.provision();
    let reply = run.open("board", 1);
    let cert = &result(&reply)["cert"];
    assert_eq!(cert["typ"], "buwiz-session");
    assert_eq!(cert["plugin"], Toy::ID);
    assert_eq!(cert["app"], "board");
    let sig = result(&reply)["cert_sig"].as_str().unwrap();
    assert_eq!(PluginKey::from_seed(&SEED).sign(cert).unwrap(), sig);

    // an unknown app, a wrong digest and a long session are refused
    assert_eq!(run.open("nope", 2)["result"]["isError"], true);
    let wrong = run.call(
        "buwiz.session.open",
        json!({ "app": "board", "open_id": b64::encode(&[3; 16]), "ks_pub": b64::encode(&[2; 32]),
                "perms_sha256": "0".repeat(64), "not_after": now() + 1000 }),
        json!(null),
    );
    assert_eq!(wrong["result"]["isError"], true);
}

#[test]
fn an_app_reaches_only_the_tools_its_certified_open_grants() {
    let mut run = Run::new();
    run.provision();
    // no open yet
    let refused = run.call("toy_list", json!({}), app_caller("board", 1));
    assert_eq!(result(&refused)["code"], "permission_denied");

    run.open("board", 1);
    let granted = run.call("toy_list", json!({}), app_caller("board", 1));
    assert_eq!(result(&granted)["text"], "milk");
    let not_granted = run.call("toy_add", json!({}), app_caller("board", 1));
    assert_eq!(result(&not_granted)["code"], "permission_denied");
    // the open is the board's, not the native screen's
    let wrong_app = run.call("toy_add", json!({}), app_caller("fast", 1));
    assert_eq!(result(&wrong_app)["code"], "permission_denied");

    // a native screen opens and calls like any app
    run.open("fast", 4);
    let native = run.call("toy_add", json!({}), app_caller("fast", 4));
    assert_eq!(result(&native)["added"], true);

    // closed, the open is gone
    run.call(
        "buwiz.session.close",
        json!({ "open_id": b64::encode(&[1; 16]) }),
        json!(null),
    );
    let closed = run.call("toy_list", json!({}), app_caller("board", 1));
    assert_eq!(result(&closed)["code"], "permission_denied");
}

#[test]
fn resolves_and_routines_only_read_unless_the_routine_declares_the_write() {
    let mut run = Run::new();
    run.provision();
    let resolve = run.call("toy_add", json!({}), json!({ "origin": "resolve" }));
    assert_eq!(result(&resolve)["code"], "permission_denied");
    let query = run.call(
        "toy_add",
        json!({}),
        json!({ "origin": "routine", "routine": "tidy" }),
    );
    assert_eq!(result(&query)["code"], "permission_denied");
    let declared = run.call(
        "toy_add",
        json!({}),
        json!({ "origin": "agent", "routine": "tidy" }),
    );
    assert_eq!(result(&declared)["added"], true);
    let undeclared = run.call(
        "toy_add",
        json!({}),
        json!({ "origin": "agent", "routine": "other" }),
    );
    assert_eq!(result(&undeclared)["code"], "permission_denied");
    let agent = run.call("toy_add", json!({}), json!({ "origin": "agent" }));
    assert_eq!(result(&agent)["added"], true);
    assert_eq!(run.server.plugin().calls, ["toy_add", "toy_add"]);
}

#[test]
fn tickets_resolve_to_titles_and_uninstall_forgets_them() {
    let mut run = Run::new();
    run.provision();
    let token = run.call(
        "toy_resolve",
        json!({ "kind": "scope", "value": "milk" }),
        json!({ "origin": "resolve" }),
    );
    let ticket = result(&token)["ticket"].as_str().unwrap().to_string();
    assert!(buwiz_plugin::is_ticket(&ticket));
    let title = run.call(
        "buwiz.ticket.resolve",
        json!({ "ticket": ticket }),
        json!(null),
    );
    assert_eq!(result(&title), &json!({ "valid": true, "title": "Item 4" }));

    run.call("buwiz.uninstall", json!({}), json!(null));
    let gone = run.call(
        "buwiz.ticket.resolve",
        json!({ "ticket": ticket }),
        json!(null),
    );
    assert_eq!(result(&gone), &json!({ "valid": false }));
}

#[test]
fn pushed_account_tokens_reach_a_tool_and_stay_in_memory() {
    const TOKEN: &str = "ya29.synthetic-token";
    let push = json!({ "account": "google", "label": "default", "provider": "google",
                       "subject": "person@example.com", "scopes": ["https://example.com/read"],
                       "access_token": TOKEN, "token_type": "Bearer", "expires_at": now() / 1000 + 3600 });
    let mut run = Run::new();
    // nothing before provision, accounts included
    assert_eq!(
        run.call("buwiz.account.set", push.clone(), json!(null))["error"]["code"],
        -32600
    );
    run.provision();
    let ask = |run: &mut Run| {
        run.call(
            "toy_list",
            json!({ "needs": "google" }),
            json!({ "origin": "agent" }),
        )
    };
    let before = ask(&mut run);
    assert_eq!(before["result"]["isError"], true);
    assert_eq!(
        result(&before),
        &json!({ "code": "account_required", "account": "google" })
    );

    let set = run.call("buwiz.account.set", push, json!(null));
    assert_eq!(result(&set), &json!({ "ok": true }));
    assert!(
        !set.to_string().contains(TOKEN),
        "the answer never echoes the token"
    );
    let after = ask(&mut run);
    assert_eq!(
        result(&after),
        &json!({ "subject": "person@example.com", "scheme": "Bearer" })
    );
    assert!(!after.to_string().contains(TOKEN));

    let clear = run.call(
        "buwiz.account.clear",
        json!({ "account": "google", "label": "default" }),
        json!(null),
    );
    assert_eq!(result(&clear), &json!({ "ok": true }));
    assert_eq!(result(&ask(&mut run))["code"], "account_required");

    // an expired push is no token; uninstall forgets what is held
    let stale =
        json!({ "account": "google", "label": "default", "access_token": TOKEN, "expires_at": 1 });
    run.call("buwiz.account.set", stale, json!(null));
    assert_eq!(result(&ask(&mut run))["code"], "account_required");
    let fresh = json!({ "account": "google", "label": "work", "access_token": TOKEN });
    run.call("buwiz.account.set", fresh, json!(null));
    assert_eq!(result(&ask(&mut run))["scheme"], "Bearer");
    run.call("buwiz.uninstall", json!({}), json!(null));
    assert_eq!(result(&ask(&mut run))["code"], "account_required");
    // a malformed push is refused without the token
    let bad = run.call(
        "buwiz.account.set",
        json!({ "account": "google", "access_token": TOKEN }),
        json!(null),
    );
    assert_eq!(bad["result"]["isError"], true);
    assert!(!bad.to_string().contains(TOKEN));
}

#[test]
fn an_unknown_reserved_name_is_method_not_found() {
    let mut run = Run::new();
    run.provision();
    assert_eq!(
        run.call("buwiz.nope", json!({}), json!(null))["error"]["code"],
        -32601
    );
    assert_eq!(
        run.call("toy_nope", json!({}), json!(null))["error"]["code"],
        -32602
    );
}

#[test]
fn lists_tools_and_serves_the_manifest_and_tsx_sources_only() {
    let mut run = Run::new();
    let init = run.rpc("initialize", json!({ "protocolVersion": "2025-11-25" }));
    assert_eq!(init["result"]["serverInfo"]["name"], "toy-mini-app");
    assert_eq!(init["result"]["instructions"], "Toy keeps a list.");

    let tools = run.rpc("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(&names[..7], buwiz_plugin::RESERVED);
    assert_eq!(&names[7..], ["toy_list", "toy_add", "toy_resolve"]);

    let resources = run.rpc("resources/list", json!({}));
    let uris: Vec<&str> = resources["result"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["uri"].as_str().unwrap())
        .collect();
    assert_eq!(uris, ["buwiz://manifest", "buwiz-app://board"]);

    let source = run.rpc("resources/read", json!({ "uri": "buwiz-app://board" }));
    assert_eq!(source["result"]["contents"][0]["text"], APP);
    let none = run.rpc("resources/read", json!({ "uri": "buwiz-app://fast" }));
    assert_eq!(none["error"]["code"], -32602);
    let text = run.rpc("resources/read", json!({ "uri": "buwiz://manifest" }));
    let served: Value =
        serde_json::from_str(text["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(served, Toy::manifest(Toy::RELEASE_KEY_ID));
}

#[test]
fn the_local_manifest_check_finds_the_usual_mistakes() {
    let toy = Toy::default();
    assert_eq!(
        manifest::problems(&Toy::manifest("k"), &toy.tools()),
        Vec::<String>::new()
    );
    let mut bad = Toy::manifest("k");
    bad["protocol"] = json!("2.1.0");
    bad["scopes"][0]["resolve"] = json!("toy_add");
    bad["apps"][0]["permissions"]["tools"] = json!(["toy_gone"]);
    assert_eq!(
        manifest::problems(&bad, &toy.tools()),
        [
            "protocol must be 1.0.0",
            "scopes[0].resolve names toy_add, which is not read-only",
            "apps[0].permissions.tools names toy_gone, which is not a tool",
        ]
    );
}
