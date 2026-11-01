//! The manifest: the constants every mini app's manifest uses, the hashes
//! the protocol takes of it, and the file a running plugin serves.
//!
//! A plugin builds its manifest in code ([`crate::Plugin::manifest`]), so a
//! TSX app's fingerprint is always the hash of the source this build serves.
//! The `manifest` subcommand prints it as JCS text; the publisher signs that
//! text, and the signed file is what the plugin serves at
//! [`MANIFEST_URI`], byte for byte, read again on every request. Without a
//! signed file the unsigned manifest is served, and the Bot refuses it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::jcs;

/// The protocol this SDK implements. A 2.0 host accepts `2.0.x` only.
pub const PROTOCOL: &str = "2.0.0";
/// Where the manifest is served.
pub const MANIFEST_URI: &str = "buwiz://manifest";
pub const MANIFEST_MIME: &str = "application/json";
/// A TSX app's entry is `buwiz-app://<id>`.
pub const APP_URI_PREFIX: &str = "buwiz-app://";
/// A TSX app's `mime`.
pub const APP_MIME: &str = "text/x-nsh-tsx";
/// A TSX app's `sdk`.
pub const APP_SDK: &str = "1";
/// A native screen's `abi` (first-party publishers only).
pub const NATIVE_ABI: u32 = 1;
/// The variable naming the signed manifest to serve.
pub const MANIFEST_ENV: &str = "BUWIZ_PLUGIN_MANIFEST";

/// `sha256:<hex>` of an app source as served (`apps[].fingerprint`).
pub fn fingerprint(source: &str) -> String {
    format!("sha256:{}", jcs::sha256_hex(source.as_bytes()))
}

/// `sha256(JCS(permissions))` of a manifest app entry, `{}` when absent.
pub fn permissions_digest(app: &Value) -> Result<String, String> {
    let empty = Value::Object(Map::new());
    jcs::sha256_jcs(app.get("permissions").unwrap_or(&empty)).map_err(|error| error.to_string())
}

/// The file name a signed manifest ships under, next to the executable.
pub fn file_name(plugin_id: &str) -> String {
    format!("{plugin_id}.manifest.json")
}

/// The manifest a running plugin serves.
#[derive(Debug, Clone)]
pub struct Served {
    /// The signed file; `None` serves `unsigned`.
    pub signed: Option<PathBuf>,
    /// The unsigned manifest as JCS text, under the release key id.
    pub unsigned: String,
}

impl Served {
    /// [`MANIFEST_ENV`] when set, else `<plugin id>.manifest.json` next to
    /// the executable when it exists, else the unsigned manifest.
    pub fn from_env(plugin_id: &str, unsigned: &Value) -> Self {
        let beside = || {
            let exe = std::env::current_exe().ok()?;
            let path = exe.parent()?.join(file_name(plugin_id));
            path.is_file().then_some(path)
        };
        let signed = std::env::var_os(MANIFEST_ENV)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(beside);
        Self::new(signed, unsigned)
    }

    pub fn new(signed: Option<PathBuf>, unsigned: &Value) -> Self {
        Self {
            signed,
            unsigned: jcs::canonical(unsigned).expect("a manifest carries integers only"),
        }
    }

    /// The manifest text this process serves.
    pub fn text(&self) -> Result<String, String> {
        match &self.signed {
            Some(path) => read(path),
            None => Ok(self.unsigned.clone()),
        }
    }

    /// The served manifest, parsed as I-JSON.
    pub fn value(&self) -> Result<Value, String> {
        let value = jcs::parse(&self.text()?).map_err(|error| format!("the manifest: {error}"))?;
        if value.is_object() {
            Ok(value)
        } else {
            Err("the manifest is not a JSON object".into())
        }
    }

    /// `manifest_sha256`: SHA-256 of the served manifest's JCS bytes.
    pub fn sha256(&self) -> Result<String, String> {
        jcs::sha256_jcs(&self.value()?).map_err(|error| error.to_string())
    }
}

fn read(path: &Path) -> Result<String, String> {
    // the path is the operator's; the error names the variable, not the file
    std::fs::read_to_string(path).map_err(|error| format!("{MANIFEST_ENV}: {error}"))
}

/// An entry of the manifest's `apps`.
pub fn app<'m>(manifest: &'m Value, id: &str) -> Option<&'m Value> {
    manifest["apps"]
        .as_array()?
        .iter()
        .find(|app| app["id"] == id)
}

/// The tools an app's `permissions.tools` grants.
pub fn app_tools(app: &Value) -> impl Iterator<Item = &str> {
    app["permissions"]["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

/// The tools a routine's `writes` lets its turn call.
pub fn routine_writes<'m>(manifest: &'m Value, routine: &str) -> impl Iterator<Item = &'m str> {
    manifest["routines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(move |r| r["id"] == routine)
        .flat_map(|r| r["writes"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
}

/// What a manifest gets wrong against the tools a plugin lists, by the
/// rules a mistake usually breaks: the protocol, the tool prefix, and every
/// tool a command, scope, routine or app names. The Bot's conformance
/// runner checks everything; this is the quick local check for tests.
pub fn problems(manifest: &Value, tools: &[crate::Tool]) -> Vec<String> {
    let mut out = Vec::new();
    if manifest["protocol"] != PROTOCOL {
        out.push(format!("protocol must be {PROTOCOL}"));
    }
    let short = manifest["short"].as_str().unwrap_or_default();
    let prefix = format!("{short}_");
    for tool in tools {
        if !tool.name.starts_with(&prefix) {
            out.push(format!("tool {} must start with {prefix}", tool.name));
        }
    }
    let find = |name: &str| tools.iter().find(|tool| tool.name == name);
    let mut named = |name: &str, at: String, read_only: bool| match find(name) {
        None => out.push(format!("{at} names {name}, which is not a tool")),
        Some(tool) if read_only && !tool.read_only => {
            out.push(format!("{at} names {name}, which is not read-only"))
        }
        Some(_) => {}
    };
    for kind in ["commands", "scopes"] {
        for (i, entry) in manifest[kind].as_array().into_iter().flatten().enumerate() {
            if let Some(name) = entry["resolve"].as_str() {
                named(name, format!("{kind}[{i}].resolve"), true);
            }
        }
    }
    for (i, routine) in manifest["routines"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(name) = routine["query"]["tool"].as_str() {
            named(name, format!("routines[{i}].query"), true);
        }
        for name in routine["writes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            named(name, format!("routines[{i}].writes"), false);
        }
    }
    for (i, app) in manifest["apps"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        for name in app_tools(app) {
            named(name, format!("apps[{i}].permissions.tools"), false);
        }
    }
    out
}
