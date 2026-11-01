//! Accounts the Bot signs the person in to (protocol 1.0 §20). The host
//! pushes an access token with `buwiz.account.set` after provision, after
//! each sign-in and after each refresh, and takes it back with
//! `buwiz.account.clear` after sign-out, removal or a failed refresh. The
//! plugin never asks.
//!
//! Tokens live in memory only: never logged, written, echoed or shown by
//! `Debug`. A tool reads one through [`crate::Caller::account`].

use std::collections::BTreeMap;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::server::Args;
use crate::{fail, ok};

/// The label the host gives an account's first sign-in.
pub const DEFAULT_LABEL: &str = "default";

/// A pushed account: one sign-in of an account the package declares.
#[derive(Clone, PartialEq, Eq)]
pub struct Account {
    /// The declared account id (`buwiz.accounts[].id`).
    pub account: String,
    /// The sign-in's label (`default` for the first).
    pub label: String,
    /// `google` or `oauth:<issuer>`.
    pub provider: String,
    /// The signed-in subject the host shows (an email or a `sub`).
    pub subject: String,
    pub scopes: Vec<String>,
    /// `Bearer` unless the host says otherwise.
    pub token_type: String,
    /// Unix seconds; `None` when the host sent none.
    pub expires_at: Option<i64>,
    access_token: String,
}

impl Account {
    /// The access token. Never log it, write it or put it in an answer.
    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    /// An `Authorization` header value: `Bearer <token>` (RFC 6750's scheme
    /// is case-insensitive; this spells it `Bearer`).
    pub fn authorization(&self) -> String {
        let scheme = if self.token_type.eq_ignore_ascii_case("bearer") {
            "Bearer"
        } else {
            self.token_type.as_str()
        };
        format!("{scheme} {}", self.access_token)
    }

    /// Whether the token is still good at unix second `now`.
    pub fn live_at(&self, now: i64) -> bool {
        self.expires_at.is_none_or(|at| at > now)
    }
}

impl fmt::Debug for Account {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Account")
            .field("account", &self.account)
            .field("label", &self.label)
            .field("provider", &self.provider)
            .field("expires_at", &self.expires_at)
            .field("access_token", &"…")
            .finish_non_exhaustive()
    }
}

/// The pushed accounts, by `(account, label)`.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Accounts(BTreeMap<(String, String), Account>);

impl fmt::Debug for Accounts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.0.values()).finish()
    }
}

fn text(args: &Args, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Unix seconds now.
pub fn now_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

impl Accounts {
    /// `buwiz.account.set {account, label, provider, subject, scopes,
    /// access_token, token_type, expires_at}` → `{ok: true}`.
    pub fn set(&mut self, args: &Args) -> Value {
        let (Some(account), Some(label), Some(access_token)) = (
            text(args, "account"),
            text(args, "label"),
            text(args, "access_token"),
        ) else {
            return fail(
                "invalid_args",
                "buwiz.account.set needs account, label and access_token",
            );
        };
        let expires_at = match args.get("expires_at") {
            None | Some(Value::Null) => None,
            Some(value) => match value.as_i64() {
                Some(at) => Some(at),
                None => return fail("invalid_args", "expires_at must be unix seconds"),
            },
        };
        let scopes = args
            .get("scopes")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let held = Account {
            account: account.clone(),
            label: label.clone(),
            provider: text(args, "provider").unwrap_or_default(),
            subject: text(args, "subject").unwrap_or_default(),
            scopes,
            token_type: text(args, "token_type").unwrap_or_else(|| "Bearer".to_string()),
            expires_at,
            access_token,
        };
        self.0.insert((account, label), held);
        ok(json!({ "ok": true }))
    }

    /// `buwiz.account.clear {account, label}` → `{ok: true}`, also when
    /// nothing was held.
    pub fn clear(&mut self, args: &Args) -> Value {
        let (Some(account), Some(label)) = (text(args, "account"), text(args, "label")) else {
            return fail(
                "invalid_args",
                "buwiz.account.clear needs account and label",
            );
        };
        self.0.remove(&(account, label));
        ok(json!({ "ok": true }))
    }

    /// Forget every token (`buwiz.uninstall`).
    pub fn forget(&mut self) {
        self.0.clear();
    }

    /// `account`'s live token at unix second `now`: the `default` label's,
    /// else the first live label's.
    pub fn get_at(&self, account: &str, now: i64) -> Option<&Account> {
        self.0
            .get(&(account.to_string(), DEFAULT_LABEL.to_string()))
            .filter(|a| a.live_at(now))
            .or_else(|| {
                self.0
                    .values()
                    .filter(|a| a.account == account)
                    .find(|a| a.live_at(now))
            })
    }

    /// `account`'s live token now; see [`Accounts::get_at`].
    pub fn get(&self, account: &str) -> Option<&Account> {
        self.get_at(account, now_s())
    }

    /// One sign-in, live or not.
    pub fn labelled(&self, account: &str, label: &str) -> Option<&Account> {
        self.0.get(&(account.to_string(), label.to_string()))
    }
}

/// The answer of a tool that needs an account it does not hold (§20.4): the
/// host asks the person to sign in.
pub fn account_required(account: &str) -> Value {
    let structured = json!({ "code": "account_required", "account": account });
    json!({
        "content": [{ "type": "text", "text": structured.to_string() }],
        "structuredContent": structured,
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "ya29.synthetic-token";

    fn args(value: Value) -> Args {
        value.as_object().unwrap().clone()
    }

    fn set(accounts: &mut Accounts, label: &str, token: &str, expires_at: Value) -> Value {
        accounts.set(&args(json!({
            "account": "google", "label": label, "provider": "google",
            "subject": "person@example.com", "scopes": ["https://example.com/read"],
            "access_token": token, "token_type": "bearer", "expires_at": expires_at
        })))
    }

    #[test]
    fn set_holds_a_token_and_clear_drops_it() {
        let mut a = Accounts::default();
        assert!(a.get_at("google", 100).is_none());
        let answer = set(&mut a, "default", TOKEN, json!(200));
        assert_eq!(answer, ok(json!({ "ok": true })));
        assert!(!answer.to_string().contains(TOKEN), "never echoed");
        let held = a.get_at("google", 100).unwrap();
        assert_eq!(held.authorization(), format!("Bearer {TOKEN}"));
        assert_eq!(held.subject, "person@example.com");
        assert!(!format!("{a:?}").contains(TOKEN), "Debug never shows it");
        // expired: no token
        assert!(a.get_at("google", 200).is_none());
        assert_eq!(
            a.clear(&args(json!({ "account": "google", "label": "default" }))),
            ok(json!({ "ok": true }))
        );
        assert!(a.labelled("google", "default").is_none());
        // clearing what is not held is fine
        assert_eq!(
            a.clear(&args(json!({ "account": "google", "label": "work" }))),
            ok(json!({ "ok": true }))
        );
    }

    #[test]
    fn the_default_label_comes_first_then_any_live_one() {
        let mut a = Accounts::default();
        set(&mut a, "work", "t-work", json!(500));
        set(&mut a, "default", "t-default", json!(150));
        assert_eq!(a.get_at("google", 100).unwrap().label, "default");
        assert_eq!(a.get_at("google", 160).unwrap().label, "work");
        assert!(a.get_at("other", 100).is_none());
    }

    #[test]
    fn bad_pushes_are_refused() {
        let mut a = Accounts::default();
        for bad in [
            json!({ "label": "default", "access_token": TOKEN }),
            json!({ "account": "google", "access_token": TOKEN }),
            json!({ "account": "google", "label": "default" }),
            json!({ "account": "google", "label": "default", "access_token": TOKEN, "expires_at": "soon" }),
            json!({ "account": "google", "label": "default", "access_token": TOKEN, "expires_at": 1.5 }),
        ] {
            let answer = a.set(&args(bad.clone()));
            assert_eq!(answer["isError"], true, "{bad}");
            assert!(!answer.to_string().contains(TOKEN), "{bad}");
        }
        assert_eq!(
            a.clear(&args(json!({ "account": "google" })))["isError"],
            true
        );
    }

    #[test]
    fn account_required_names_the_account() {
        let r = account_required("google");
        assert_eq!(r["isError"], true);
        assert_eq!(
            r["structuredContent"],
            json!({ "code": "account_required", "account": "google" })
        );
    }
}
