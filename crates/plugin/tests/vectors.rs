//! The shared vectors (`vectors/`) that the Rust and TypeScript halves of
//! the SDK must both reproduce byte for byte:
//!
//! - `jcs.json`: RFC 8785 text, copied from the Bot
//!   (`server/test/fixtures/jcs-vectors.json`);
//! - `signing.json`: a provisioned key's public key, a session certificate
//!   and its signature, an app fingerprint and a permissions digest.

use buwiz_plugin::jcs::{self, JcsError};
use buwiz_plugin::key::PluginKey;
use buwiz_plugin::{b64, manifest};
use serde_json::Value;

const JCS: &str = include_str!("../../../vectors/jcs.json");
const SIGNING: &str = include_str!("../../../vectors/signing.json");

#[test]
fn every_jcs_vector_gives_its_text_or_its_refusal() {
    let all: Value = serde_json::from_str(JCS).unwrap();
    let vectors = all["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 15);
    for v in vectors {
        let name = v["name"].as_str().unwrap();
        let out = jcs::canonical_text(v["input"].as_str().unwrap());
        if v["error"] == true {
            assert!(matches!(out, Err(JcsError::NotIJson(_))), "{name}: {out:?}");
        } else if v["signable"] == true {
            assert_eq!(out.as_deref(), Ok(v["jcs"].as_str().unwrap()), "{name}");
        } else {
            assert!(
                matches!(out, Err(JcsError::NotSignable(_))),
                "{name}: {out:?}"
            );
        }
    }
}

#[test]
fn the_signing_vectors_are_reproduced() {
    let v: Value = serde_json::from_str(SIGNING).unwrap();
    let seed: [u8; 32] = b64::decode_exact(v["seed"].as_str().unwrap(), 32)
        .unwrap()
        .try_into()
        .unwrap();
    let key = PluginKey::from_seed(&seed);
    assert_eq!(key.public(), v["pub"]);
    assert_eq!(jcs::canonical(&v["cert"]).unwrap(), v["cert_jcs"]);
    assert_eq!(key.sign(&v["cert"]).unwrap(), v["cert_sig"]);
    assert_eq!(
        manifest::fingerprint(v["app_source"].as_str().unwrap()),
        v["fingerprint"]
    );
    assert_eq!(
        manifest::permissions_digest(&v["app"]).unwrap(),
        v["perms_sha256"]
    );
    assert_eq!(
        manifest::permissions_digest(&serde_json::json!({})).unwrap(),
        v["perms_sha256_none"]
    );
}
