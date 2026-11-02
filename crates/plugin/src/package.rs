//! A release's `plugin.json` (protocol 1.0 §7): `<name> package` fills a
//! template's `buwiz.files` and `buwiz.binaries` with each file's SHA-256
//! and writes `plugin.unsigned.json` for `buwiz-broker sign-manifest
//! --block buwiz` to sign.
//!
//! The out folder holds this platform's binary as `<name>-<platform>` and
//! the signed manifest as `<plugin id>.manifest.json`. The package installs
//! them at `bin/<name>` and `bin/<plugin id>.manifest.json`, where
//! [`crate::manifest::Served::from_env`] finds the manifest without a
//! setting. Other files the template lists (`buwiz.files`: install path →
//! `{asset}`) get their SHA-256 too.
//!
//! The signed manifest decides the block's `protocol`, `id`, `short`,
//! `version` and `publisher`, and `plugin.json`'s `version`: a template
//! need not carry them, and its own values are replaced. The mini app's
//! `mcpServers` entry must run `${PLUGIN_ROOT}/bin/<name>`.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::jcs;
use crate::manifest::{self, PROTOCOL};

/// The file `<name> package` writes into the out folder.
pub const UNSIGNED: &str = "plugin.unsigned.json";

/// A release asset name for this platform's binary.
pub fn binary_asset(name: &str, platform: &str) -> String {
    format!("{name}-{platform}")
}

/// `<os>-<arch>` as Rust names them, e.g. `macos-aarch64`.
pub fn valid_platform(platform: &str) -> bool {
    let mut parts = platform.splitn(2, '-');
    let ok = |s: Option<&str>| {
        s.is_some_and(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
    };
    ok(parts.next()) && ok(parts.next())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(jcs::sha256_hex(&bytes))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// `template` filled for the plugin `id` (binary `name`) on `platform`,
/// from the files in `out`. With `published` (another platform's
/// `plugin.json` of the same version) its binaries are kept and this
/// platform's is added.
pub fn fill(
    template: &Value,
    out: &Path,
    id: &str,
    name: &str,
    platform: &str,
    published: Option<&Value>,
) -> Result<Value, String> {
    if !valid_platform(platform) {
        return Err(format!("platform {platform:?} is not <os>-<arch>"));
    }
    let mut plugin = template.clone();
    let block = plugin
        .get_mut("buwiz")
        .and_then(Value::as_object_mut)
        .ok_or("the template has no buwiz block")?;
    let text =
        |b: &Map<String, Value>, k: &str| b.get(k).and_then(Value::as_str).map(str::to_string);
    let server = text(block, "server").ok_or("the template has no buwiz.server")?;
    // the signed manifest is the one source of what both signatures name
    let served = read_json(&out.join(manifest::file_name(id)))?;
    let from_served = from_manifest(&served, id)?;
    let version = from_served["version"].clone();
    block.extend(from_served);

    let mut files = Map::new();
    let manifest_name = manifest::file_name(id);
    files.insert(
        format!("bin/{manifest_name}"),
        json!({ "asset": manifest_name, "sha256": sha256_file(&out.join(&manifest_name))? }),
    );
    if let Some(listed) = block.get("files").and_then(Value::as_object) {
        for (path, entry) in listed {
            if path == "plugin.json" || path.starts_with("bin/") {
                return Err(format!("buwiz.files cannot list {path}"));
            }
            let asset = entry
                .get("asset")
                .and_then(Value::as_str)
                .ok_or(format!("buwiz.files[{path}] names no asset"))?;
            if asset.contains('/') {
                return Err(format!(
                    "buwiz.files[{path}].asset {asset:?} is not a flat asset name"
                ));
            }
            files.insert(
                path.clone(),
                json!({ "asset": asset, "sha256": sha256_file(&out.join(asset))? }),
            );
        }
    }
    let files = Value::Object(files);

    let mut binaries = Map::new();
    if let Some(old) = published {
        let old = &old["buwiz"];
        if old.get("version") != Some(&version) {
            return Err(format!(
                "the published plugin.json is {}, this build is {version}",
                old.get("version").unwrap_or(&Value::Null)
            ));
        }
        if old.get("files") != Some(&files) {
            return Err(
                "the published files differ from this build's: release a new version".into(),
            );
        }
        if let Some(listed) = old.get("binaries").and_then(Value::as_object) {
            binaries.extend(listed.clone());
        }
    }
    let asset = binary_asset(name, platform);
    binaries.insert(
        platform.to_string(),
        json!({ "path": format!("bin/{name}"), "asset": asset, "sha256": sha256_file(&out.join(&asset))? }),
    );
    block.insert("files".into(), files);
    block.insert("binaries".into(), Value::Object(binaries));
    block.remove("signature");

    let object = plugin
        .as_object_mut()
        .ok_or("the template is not an object")?;
    object.insert("version".into(), version);
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("mcpServers is not an object")?;
    let command = format!("${{PLUGIN_ROOT}}/bin/{name}");
    let entry = servers
        .entry(server.clone())
        .or_insert_with(|| json!({ "command": command, "args": ["mcp"] }));
    check_server(&server, entry, &command)?;
    Ok(plugin)
}

/// The block fields the signed manifest decides: `protocol`, `id`,
/// `short`, `version` and `publisher` (`{id, key_id}`). A template's own
/// values for them are replaced.
fn from_manifest(served: &Value, id: &str) -> Result<Map<String, Value>, String> {
    let text = |k: &str| served.get(k).and_then(Value::as_str);
    if text("protocol") != Some(PROTOCOL) {
        return Err(format!(
            "the signed manifest's protocol is {}; this SDK packages {PROTOCOL}",
            served.get("protocol").unwrap_or(&Value::Null)
        ));
    }
    if text("id") != Some(id) {
        return Err(format!(
            "the signed manifest's id is {}; this binary serves {id}",
            served.get("id").unwrap_or(&Value::Null)
        ));
    }
    let publisher = |k: &str| {
        served
            .get("publisher")
            .and_then(|p| p.get(k))
            .and_then(Value::as_str)
            .ok_or(format!("the signed manifest has no publisher.{k}"))
    };
    let mut fields = Map::new();
    fields.insert("protocol".into(), json!(PROTOCOL));
    fields.insert("id".into(), json!(id));
    for key in ["short", "version"] {
        let value = text(key).ok_or(format!("the signed manifest has no {key}"))?;
        fields.insert(key.into(), json!(value));
    }
    fields.insert(
        "publisher".into(),
        json!({ "id": publisher("id")?, "key_id": publisher("key_id")? }),
    );
    Ok(fields)
}

/// The mini app's `mcpServers` entry (§7.2): a stdio server whose command
/// is the package's own binary, the path `buwiz.binaries` installs.
fn check_server(server: &str, entry: &Value, command: &str) -> Result<(), String> {
    let entry = entry
        .as_object()
        .ok_or(format!("mcpServers.{server} is not an object"))?;
    if entry.get("command").and_then(Value::as_str) != Some(command) {
        return Err(format!(
            "mcpServers.{server}.command must be {command}, the binary the package installs"
        ));
    }
    if entry.contains_key("url") {
        return Err(format!("mcpServers.{server} is a stdio server: no url"));
    }
    for key in ["type", "transport"] {
        if entry.get(key).is_some_and(|t| t != "stdio") {
            return Err(format!("mcpServers.{server}.{key} must be stdio"));
        }
    }
    let strings = |v: &Value| v.as_array().is_some_and(|a| a.iter().all(Value::is_string));
    if entry.get("args").is_some_and(|a| !strings(a)) {
        return Err(format!("mcpServers.{server}.args must be strings"));
    }
    let env = |v: &Value| {
        v.as_object()
            .is_some_and(|o| o.values().all(Value::is_string))
    };
    if entry.get("env").is_some_and(|e| !env(e)) {
        return Err(format!(
            "mcpServers.{server}.env must be an object of strings"
        ));
    }
    Ok(())
}

/// `<name> package <template> <out> <platform> [--published <plugin.json>]`:
/// [`fill`], then write `<out>/plugin.unsigned.json`.
pub fn run(
    template: &Path,
    out: &Path,
    id: &str,
    name: &str,
    platform: &str,
    published: Option<&Path>,
) -> Result<(), String> {
    let template = read_json(template)?;
    let published = published.map(read_json).transpose()?;
    let plugin = fill(&template, out, id, name, platform, published.as_ref())?;
    let mut text = serde_json::to_string_pretty(&plugin).map_err(|e| e.to_string())?;
    text.push('\n');
    let path = out.join(UNSIGNED);
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "app.buwiz.toy";
    const NAME: &str = "toy-mini-app";

    fn template() -> Value {
        json!({
            "name": "toy", "version": "1.2.0", "description": "Toy.",
            "buwiz": { "protocol": PROTOCOL, "id": ID, "short": "toy", "version": "1.2.0", "server": "toy",
                       "files": { "skills/tidy/SKILL.md": { "asset": "tidy-SKILL.md" } },
                       "binaries": {}, "publisher": { "id": "app.buwiz", "key_id": "toy-test-01" },
                       "signature": { "stale": true } }
        })
    }

    fn out(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("buwiz-package-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let served = json!({ "protocol": PROTOCOL, "id": ID, "short": "toy", "version": "1.2.0",
                             "publisher": { "id": "app.buwiz", "key_id": "toy-test-01" } });
        std::fs::write(dir.join(manifest::file_name(ID)), served.to_string()).unwrap();
        std::fs::write(dir.join(binary_asset(NAME, "macos-aarch64")), b"mac binary").unwrap();
        std::fs::write(
            dir.join(binary_asset(NAME, "linux-x86_64")),
            b"linux binary",
        )
        .unwrap();
        std::fs::write(dir.join("tidy-SKILL.md"), b"---\nname: tidy\n---\n").unwrap();
        dir
    }

    #[test]
    fn fills_files_binaries_and_the_server_entry() {
        let dir = out("fill");
        let p = fill(&template(), &dir, ID, NAME, "macos-aarch64", None).unwrap();
        let b = &p["buwiz"];
        assert!(b.get("signature").is_none(), "an old signature is dropped");
        let manifest_sha =
            jcs::sha256_hex(&std::fs::read(dir.join(manifest::file_name(ID))).unwrap());
        assert_eq!(
            b["files"][format!("bin/{ID}.manifest.json")]["sha256"],
            manifest_sha
        );
        assert_eq!(b["files"]["skills/tidy/SKILL.md"]["asset"], "tidy-SKILL.md");
        assert_eq!(
            b["binaries"]["macos-aarch64"]["path"],
            format!("bin/{NAME}")
        );
        assert_eq!(
            b["binaries"]["macos-aarch64"]["sha256"],
            jcs::sha256_hex(b"mac binary")
        );
        assert_eq!(
            p["mcpServers"]["toy"]["command"],
            format!("${{PLUGIN_ROOT}}/bin/{NAME}")
        );
        // another platform's run adds its binary to the published plugin.json
        let both = fill(&template(), &dir, ID, NAME, "linux-x86_64", Some(&p)).unwrap();
        let platforms: Vec<&String> = both["buwiz"]["binaries"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        assert_eq!(platforms, ["linux-x86_64", "macos-aarch64"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_signed_manifest_decides_the_block() {
        let dir = out("manifest");
        // a template that names none of it, or stale values, gets the manifest's
        let mut bare = template();
        for key in ["protocol", "id", "short", "version", "publisher"] {
            bare["buwiz"].as_object_mut().unwrap().remove(key);
        }
        bare.as_object_mut().unwrap().remove("version");
        let mut stale = template();
        stale["version"] = json!("1.1.0");
        stale["buwiz"]["version"] = json!("1.1.0");
        stale["buwiz"]["publisher"]["key_id"] = json!("old-01");
        for t in [bare, stale] {
            let p = fill(&t, &dir, ID, NAME, "macos-aarch64", None).unwrap();
            assert_eq!(p["version"], "1.2.0");
            let b = &p["buwiz"];
            assert_eq!(
                (&b["protocol"], &b["id"], &b["short"], &b["version"]),
                (&json!(PROTOCOL), &json!(ID), &json!("toy"), &json!("1.2.0"))
            );
            assert_eq!(
                b["publisher"],
                json!({ "id": "app.buwiz", "key_id": "toy-test-01" })
            );
        }
        let refuse = |served: Value| {
            std::fs::write(dir.join(manifest::file_name(ID)), served.to_string()).unwrap();
            fill(&template(), &dir, ID, NAME, "macos-aarch64", None).unwrap_err()
        };
        let good = json!({ "protocol": PROTOCOL, "id": ID, "short": "toy", "version": "1.2.0",
                           "publisher": { "id": "app.buwiz", "key_id": "toy-test-01" } });
        let edit = |key: &str, value: Value| {
            let mut m = good.clone();
            m[key] = value;
            m
        };
        assert!(refuse(edit("protocol", json!("2.1.0"))).contains("protocol"));
        assert!(refuse(edit("id", json!("app.buwiz.other"))).contains("app.buwiz.other"));
        assert!(refuse(edit("version", Value::Null)).contains("version"));
        assert!(refuse(edit("publisher", json!({ "id": "app.buwiz" }))).contains("key_id"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_mini_app_server_runs_the_packaged_binary() {
        let dir = out("server");
        let refuse = |entry: Value| {
            let mut t = template();
            t["mcpServers"] = json!({ "toy": entry });
            fill(&t, &dir, ID, NAME, "macos-aarch64", None).unwrap_err()
        };
        let command = format!("${{PLUGIN_ROOT}}/bin/{NAME}");
        assert!(refuse(json!({ "command": "/usr/local/bin/toy" })).contains("command"));
        assert!(refuse(json!({ "command": "${PLUGIN_ROOT}/bin/other" })).contains("command"));
        assert!(
            refuse(json!({ "command": command, "url": "https://example.com" })).contains("url")
        );
        assert!(refuse(json!({ "command": command, "type": "http" })).contains("type"));
        assert!(refuse(json!({ "command": command, "args": ["mcp", 1] })).contains("args"));
        assert!(refuse(json!({ "command": command, "env": { "A": 1 } })).contains("env"));
        // a template's own stdio entry is kept as written
        let mut t = template();
        t["mcpServers"] = json!({ "toy": { "command": command, "args": ["serve"], "env": { "A": "b" } },
                                  "other": { "url": "https://example.com/mcp" } });
        let p = fill(&t, &dir, ID, NAME, "macos-aarch64", None).unwrap();
        assert_eq!(p["mcpServers"], t["mcpServers"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_what_would_not_install() {
        let dir = out("refuse");
        let refuse = |edit: &dyn Fn(&mut Value), platform: &str| {
            let mut t = template();
            edit(&mut t);
            fill(&t, &dir, ID, NAME, platform, None).unwrap_err()
        };
        assert!(refuse(&|_| {}, "macOS").contains("platform"));
        assert!(
            refuse(&|_| {}, "windows-x86_64").contains("windows-x86_64"),
            "a missing binary"
        );
        assert!(
            refuse(
                &|t| t["buwiz"].as_object_mut().unwrap().clear(),
                "macos-aarch64"
            )
            .contains("buwiz.server")
        );
        assert!(
            refuse(
                &|t| t["buwiz"]["files"] = json!({ "plugin.json": { "asset": "x" } }),
                "macos-aarch64"
            )
            .contains("plugin.json")
        );
        let p = fill(&template(), &dir, ID, NAME, "macos-aarch64", None).unwrap();
        let mut older = p.clone();
        older["buwiz"]["version"] = json!("1.1.0");
        assert!(
            fill(&template(), &dir, ID, NAME, "linux-x86_64", Some(&older))
                .unwrap_err()
                .contains("1.1.0")
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
