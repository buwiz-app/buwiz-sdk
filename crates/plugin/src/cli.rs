//! The command line every mini app binary shares:
//!
//! ```text
//! <name> mcp                         serve MCP on stdio (what the Bot spawns)
//! <name> manifest [--key-id <id>]    print the unsigned manifest as JCS text
//! <name> app-source <id>             print a TSX app's source as served
//! <name> package <plugin.json> <out> <platform> [--published <plugin.json>]
//!                                    fill a release's plugin.json to sign
//! <name> --version | --help
//! ```

use std::io::Write as _;
use std::process::ExitCode;

use crate::manifest::{self, MANIFEST_ENV};
use crate::{Plugin, Server, jcs, serve_stdio};

/// Run the command line. `open` makes the plugin; only `mcp` calls it, so
/// printing the manifest never opens the plugin's data.
pub fn main<P: Plugin>(open: impl FnOnce() -> Result<P, String>) -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["mcp"] => match open() {
            Ok(plugin) => match serve_stdio(&mut Server::new(plugin)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{}: stdio: {error}", P::NAME);
                    ExitCode::FAILURE
                }
            },
            Err(error) => {
                eprintln!("{}: {error}", P::NAME);
                ExitCode::FAILURE
            }
        },
        ["manifest"] => print_manifest::<P>(P::RELEASE_KEY_ID),
        ["manifest", "--key-id", key_id] if valid_key_id(key_id) => print_manifest::<P>(key_id),
        ["package", template, out, platform] => package::<P>(template, out, platform, None),
        ["package", template, out, platform, "--published", published] => {
            package::<P>(template, out, platform, Some(published))
        }
        ["app-source", id] => match P::app_source(id) {
            Some(source) => print_text(source),
            None => {
                eprintln!("{}: no TSX app {id}", P::NAME);
                ExitCode::from(2)
            }
        },
        ["--version" | "-V"] => print_text(&format!("{} {}\n", P::NAME, P::VERSION)),
        ["--help" | "-h"] => print_text(&usage::<P>()),
        _ => {
            eprint!("{}", usage::<P>());
            ExitCode::from(2)
        }
    }
}

fn usage<P: Plugin>() -> String {
    let name = P::NAME;
    let id = P::ID;
    let key = P::RELEASE_KEY_ID;
    let file = manifest::file_name(id);
    format!(
        "{name}: the {id} mini app for the Buwiz Bot.

Usage: {name} mcp                       speak MCP on stdin/stdout (what the Bot spawns)
       {name} manifest [--key-id <id>]  print the unsigned manifest as JCS text, under
                                        publisher key id {key} unless a test id is named
       {name} app-source <id>           print a TSX app's source exactly as served
       {name} package <plugin.json> <out> <platform> [--published <plugin.json>]
                                        fill the template's buwiz.files and buwiz.binaries
                                        from <out> ({name}-<platform> and {file}, the signed
                                        manifest) and write <out>/plugin.unsigned.json for
                                        `buwiz-broker sign-manifest --block buwiz`; with a
                                        published plugin.json its other platforms stay
       {name} --version | --help

Environment:
  {MANIFEST_ENV}  the signed manifest to serve (default: {file} next to this
                         executable; without either the unsigned one is served, and the
                         Bot refuses the plugin)
"
    )
}

/// `^[a-z0-9][a-z0-9-]{0,63}$`.
fn valid_key_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0] != b'-'
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn package<P: Plugin>(
    template: &str,
    out: &str,
    platform: &str,
    published: Option<&str>,
) -> ExitCode {
    let result = crate::package::run(
        std::path::Path::new(template),
        std::path::Path::new(out),
        P::ID,
        P::NAME,
        platform,
        published.map(std::path::Path::new),
    );
    match result {
        Ok(()) => {
            eprintln!("{}: wrote {out}/{}", P::NAME, crate::package::UNSIGNED);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}: package: {error}", P::NAME);
            ExitCode::FAILURE
        }
    }
}

fn print_manifest<P: Plugin>(key_id: &str) -> ExitCode {
    match jcs::canonical(&P::manifest(key_id)) {
        Ok(text) => print_text(&text),
        Err(error) => {
            eprintln!("{}: the manifest: {error}", P::NAME);
            ExitCode::FAILURE
        }
    }
}

/// Exactly these bytes on stdout (the signer fingerprints them).
fn print_text(text: &str) -> ExitCode {
    let mut out = std::io::stdout().lock();
    match out.write_all(text.as_bytes()).and_then(|()| out.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
