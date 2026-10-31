//! The plugin key the Bot provisions.
//!
//! The Bot generates one ed25519 key per install and sends its seed in
//! `buwiz.provision`, the first call of every spawn. The seed lives in
//! [`PluginKey`] and nowhere else: never written, logged, echoed or put in an
//! error message (P4), and `Debug` is not derived.

use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{Map, Value};

use crate::{b64, jcs};

/// The provisioned plugin key.
pub struct PluginKey {
    signing: SigningKey,
}

impl PluginKey {
    /// `buwiz.provision`'s `key` and `pub`. The error never quotes either.
    pub fn from_provision(arguments: &Map<String, Value>) -> Result<Self, String> {
        let key = arguments
            .get("key")
            .and_then(Value::as_object)
            .ok_or("`key` must be {alg, seed}")?;
        if key.get("alg").and_then(Value::as_str) != Some("ed25519") {
            return Err("`key.alg` must be ed25519".into());
        }
        let seed: [u8; 32] = key
            .get("seed")
            .and_then(Value::as_str)
            .and_then(|seed| b64::decode_exact(seed, 32))
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("`key.seed` must be 32 bytes of base64url")?;
        let key = Self::from_seed(&seed);
        if arguments.get("pub").and_then(Value::as_str) != Some(key.public().as_str()) {
            return Err("the key and pub do not match".into());
        }
        Ok(key)
    }

    /// A key from its 32-byte seed (tests and vectors; the Bot provisions
    /// the real one).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self {
            signing: SigningKey::from_bytes(seed),
        }
    }

    /// The public key, base64url.
    pub fn public(&self) -> String {
        b64::encode(self.signing.verifying_key().as_bytes())
    }

    /// Whether `other` is the same key.
    pub fn same_as(&self, other: &PluginKey) -> bool {
        self.signing.to_bytes() == other.signing.to_bytes()
    }

    /// base64url signature over the JCS bytes of `value`.
    pub fn sign(&self, value: &Value) -> Result<String, String> {
        let bytes = jcs::canonical(value).map_err(|error| error.to_string())?;
        Ok(b64::encode(&self.signing.sign(bytes.as_bytes()).to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
    use serde_json::json;

    fn provision_args(seed: [u8; 32]) -> Map<String, Value> {
        let public = PluginKey::from_seed(&seed).public();
        json!({ "key": {"alg": "ed25519", "seed": b64::encode(&seed)}, "pub": public })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn a_provisioned_key_signs_what_its_public_key_verifies() {
        let key = PluginKey::from_provision(&provision_args([7; 32])).unwrap();
        let cert = json!({"v": 1, "typ": "buwiz-session", "not_after": 5});
        let sig: [u8; 64] = b64::decode_exact(&key.sign(&cert).unwrap(), 64)
            .unwrap()
            .try_into()
            .unwrap();
        let bytes = jcs::canonical(&cert).unwrap();
        let ours: [u8; 32] = b64::decode_exact(&key.public(), 32)
            .unwrap()
            .try_into()
            .unwrap();
        let verify = |public: [u8; 32]| {
            VerifyingKey::from_bytes(&public)
                .unwrap()
                .verify(bytes.as_bytes(), &Signature::from_bytes(&sig))
                .is_ok()
        };
        assert!(verify(ours));
        assert!(!verify(
            SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes()
        ));
    }

    #[test]
    fn a_mismatched_pub_or_bad_seed_is_refused_without_quoting_the_seed() {
        let seed = b64::encode(&[7; 32]);
        let mut args = provision_args([7; 32]);
        args.insert("pub".into(), json!(b64::encode(&[1; 32])));
        assert_eq!(
            PluginKey::from_provision(&args).err().unwrap(),
            "the key and pub do not match"
        );
        let mut args = provision_args([7; 32]);
        args["key"]["seed"] = json!("short");
        assert!(
            !PluginKey::from_provision(&args)
                .err()
                .unwrap()
                .contains(&seed)
        );
    }
}
