//! A test harness for a mini app's own tests: a provisioned [`Server`]
//! serving the unsigned manifest, and calls as the model, a resolve, a
//! routine or an app, through the same JSON-RPC path the Bot uses.
//!
//! ```ignore
//! use buwiz_plugin::testing::Harness;
//!
//! let mut h = Harness::new(Hello::default());
//! let greeting = h.agent("hello_greet", serde_json::json!({})).unwrap();
//! assert_eq!(greeting["greeting"], "Hello, world");
//! ```

use serde_json::{Value, json};

use crate::key::PluginKey;
use crate::manifest::{self, Served};
use crate::{Plugin, Server, b64};

/// A test seed: 32 bytes of 7. Never a real key.
const SEED: [u8; 32] = [7; 32];

pub struct Harness<P: Plugin> {
    server: Server<P>,
    next: i64,
    opens: u8,
}

impl<P: Plugin> Harness<P> {
    /// `plugin` behind a server serving its unsigned manifest (release key
    /// id), already provisioned.
    pub fn new(plugin: P) -> Self {
        let served = Served::new(None, &P::manifest(P::RELEASE_KEY_ID));
        let mut harness = Self {
            server: Server::with_manifest(plugin, served),
            next: 0,
            opens: 0,
        };
        let key = PluginKey::from_seed(&SEED);
        let reply = harness.call(
            "buwiz.provision",
            json!({ "protocol": manifest::PROTOCOL, "plugin": P::ID,
                    "key": { "alg": "ed25519", "seed": b64::encode(&SEED) }, "pub": key.public() }),
            Value::Null,
        );
        assert!(
            matches!(&reply, Ok(r) if r["ok"] == true),
            "provision: {reply:?}"
        );
        harness
    }

    pub fn plugin(&self) -> &P {
        self.server.plugin()
    }

    pub fn plugin_mut(&mut self) -> &mut P {
        self.server.plugin_mut()
    }

    /// One JSON-RPC request; the whole reply.
    pub fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let line = json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
        let reply = self
            .server
            .handle_line(&line.to_string())
            .expect("a request is answered");
        serde_json::from_str(&reply).expect("the reply is JSON")
    }

    /// `tools/call` with `caller` as `_meta["buwiz/caller"]`: `Ok` with the
    /// result's `structuredContent`, or `Err` with it (`{code, message}`)
    /// for an `isError` result. A JSON-RPC error panics.
    pub fn call(&mut self, tool: &str, args: Value, caller: Value) -> Result<Value, Value> {
        let reply = self.rpc(
            "tools/call",
            json!({ "name": tool, "arguments": args, "_meta": { "buwiz/caller": caller } }),
        );
        let result = match reply.get("result") {
            Some(result) => result,
            None => panic!("{tool}: JSON-RPC error {}", reply["error"]),
        };
        let data = result["structuredContent"].clone();
        if result["isError"] == true {
            Err(data)
        } else {
            Ok(data)
        }
    }

    /// A call as the model.
    pub fn agent(&mut self, tool: &str, args: Value) -> Result<Value, Value> {
        self.call(
            tool,
            args,
            json!({ "origin": "agent", "plugin": P::ID, "ts": 1 }),
        )
    }

    /// A call as a command's or scope's resolve.
    pub fn resolve(&mut self, tool: &str, args: Value) -> Result<Value, Value> {
        self.call(
            tool,
            args,
            json!({ "origin": "resolve", "plugin": P::ID, "ts": 1 }),
        )
    }

    /// A call from routine `routine`'s turn (as the model in that turn).
    pub fn routine(&mut self, routine: &str, tool: &str, args: Value) -> Result<Value, Value> {
        self.call(
            tool,
            args,
            json!({ "origin": "agent", "plugin": P::ID, "routine": routine, "ts": 1 }),
        )
    }

    /// A call from app `app`, from a fresh open the server certified.
    pub fn app(&mut self, app: &str, tool: &str, args: Value) -> Result<Value, Value> {
        let open_id = self.open(app);
        self.call(
            tool,
            args,
            json!({ "origin": "app", "plugin": P::ID, "app": app, "open_id": open_id, "ts": 1 }),
        )
    }

    /// Open `app` (`buwiz.session.open`); its open id.
    pub fn open(&mut self, app: &str) -> String {
        self.opens = self.opens.wrapping_add(1);
        let open_id = b64::encode(&[self.opens; 16]);
        let manifest = P::manifest(P::RELEASE_KEY_ID);
        let entry = manifest::app(&manifest, app).unwrap_or_else(|| panic!("no app {app}"));
        let not_after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
            + 3_600_000;
        let reply = self.call(
            "buwiz.session.open",
            json!({ "app": app, "open_id": open_id, "ks_pub": b64::encode(&[2; 32]),
                    "perms_sha256": manifest::permissions_digest(entry).unwrap(), "not_after": not_after }),
            Value::Null,
        );
        assert!(reply.is_ok(), "open {app}: {reply:?}");
        open_id
    }
}
