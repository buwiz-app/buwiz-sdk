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
    if text(block, "protocol").as_deref() != Some(PROTOCOL) {
        return Err(format!("buwiz.protocol must be {PROTOCOL}"));
    }
    if text(block, "id").as_deref() != Some(id) {
        return Err(format!("buwiz.id must be {id}"));
    }
    let served = read_json(&out.join(manifest::file_name(id)))?;
    for key in ["id", "short", "version"] {
        if block.get(key) != served.get(key) {
            return Err(format!(
                "buwiz.{key} is {}; the signed manifest's is {}",
                block.get(key).unwrap_or(&Value::Null),
                served.get(key).unwrap_or(&Value::Null)
            ));
        }
    }
    if block.get("publisher").and_then(|p| p.get("key_id"))
        != served.get("publisher").and_then(|p| p.get("key_id"))
    {
        return Err("buwiz.publisher.key_id differs from the signed manifest's".into());
    }
    let version = block.get("version").cloned();
    let server = text(block, "server").ok_or("the template has no buwiz.server")?;

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
        if old.get("version") != version.as_ref() {
            return Err(format!(
                "the published plugin.json is {}, this build is {}",
                old.get("version").unwrap_or(&Value::Null),
                version.as_ref().unwrap_or(&Value::Null)
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
    if object.get("version") != version.as_ref() {
        return Err("plugin.json's version must equal buwiz.version".into());
    }
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("mcpServers is not an object")?;
    servers.entry(server).or_insert_with(
        || json!({ "command": format!("${{PLUGIN_ROOT}}/bin/{name}"), "args": ["mcp"] }),
    );
    Ok(plugin)
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
    fn refuses_what_would_not_install() {
        let dir = out("refuse");
        let refuse = |edit: &dyn Fn(&mut Value), platform: &str| {
            let mut t = template();
            edit(&mut t);
            fill(&t, &dir, ID, NAME, platform, None).unwrap_err()
        };
        assert!(
            refuse(
                &|t| t["buwiz"]["protocol"] = json!("2.1.0"),
                "macos-aarch64"
            )
            .contains("protocol")
        );
        assert!(
            refuse(&|t| t["buwiz"]["version"] = json!("1.3.0"), "macos-aarch64")
                .contains("buwiz.version")
        );
        assert!(
            refuse(&|t| t["version"] = json!("1.3.0"), "macos-aarch64")
                .contains("plugin.json's version")
        );
        assert!(
            refuse(
                &|t| t["buwiz"]["publisher"]["key_id"] = json!("other-01"),
                "macos-aarch64"
            )
            .contains("key_id")
        );
        assert!(refuse(&|_| {}, "macOS").contains("platform"));
        assert!(
            refuse(&|_| {}, "windows-x86_64").contains("windows-x86_64"),
            "a missing binary"
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
