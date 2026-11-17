//! `Badge` and `with_badge`: what a plugin may put on a result as
//! `_meta["buwiz/badge"]` (spec 16.4). `packages/plugin/test/badge.test.ts`
//! runs the same cases, and both read `vectors/badge.json`, which the Bot's
//! broker and the runner's host read too.

use buwiz_plugin::badge::{KEY, TEXT_MAX};
use buwiz_plugin::{Badge, BadgeError, Dot, fail, ok, with_badge};
use serde_json::{Value, json};

const VECTORS: &str = include_str!("../../../vectors/badge.json");
const TICKET: &str = "tkt_0123456789ABCDEFGHJKMNPQRS";

fn dot_of(word: &str) -> Option<Dot> {
    [Dot::Red, Dot::Amber, Dot::Green, Dot::None]
        .into_iter()
        .find(|d| d.as_str() == word)
}

/// What the helper makes of a vector's author input: `None` when it cannot even be said
/// (a dot the enum has no value for, a type the signature rules out), which is a refusal.
fn made(b: &Value) -> Option<Result<Badge, BadgeError>> {
    let o = b.as_object()?;
    if o.contains_key("clear") {
        return None;
    }
    let dot = match o.get("dot") {
        None => None,
        Some(d) => Some(dot_of(d.as_str()?)?),
    };
    let text = match o.get("text") {
        None => None,
        Some(t) => Some(t.as_str()?),
    };
    let made = Badge::new(o.get("app")?.as_str()?, dot, text);
    Some(match o.get("ticket") {
        None | Some(Value::Null) => made,
        Some(t) => made.and_then(|b| b.for_ticket(t.as_str().unwrap_or(""))),
    })
}

#[test]
fn the_helper_accepts_and_refuses_what_the_shared_vectors_say() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() > 40);
    let mut tried = 0;
    for c in cases {
        let b = &c["badge"];
        if b.as_object().is_some_and(|o| o.contains_key("clear")) || !b.is_object() {
            continue;
        }
        let want = c.get("helper_ok").unwrap_or(&c["ok"]).as_bool().unwrap();
        let got = made(b);
        tried += 1;
        assert_eq!(
            got.as_ref().is_some_and(|r| r.is_ok()),
            want,
            "{b}: {got:?}"
        );
        // what the helper makes is well formed on the wire: it is the author's input, trimmed
        if let Some(Ok(badge)) = got {
            let wire = badge.to_value();
            assert!(
                wire.get("text")
                    .and_then(Value::as_str)
                    .is_none_or(|t| !t.starts_with(' ') && !t.ends_with(' ') && !t.is_empty()),
                "{wire}"
            );
        }
    }
    assert!(tried > 30, "{tried}");
}

fn value(app: &str, dot: Option<Dot>, text: Option<&str>) -> Value {
    Badge::new(app, dot, text).unwrap().to_value()
}

#[test]
fn a_badge_shows_a_dot_text_or_both() {
    assert_eq!(
        value("board", Some(Dot::Red), Some("2 due")),
        json!({ "app": "board", "dot": "red", "text": "2 due" })
    );
    assert_eq!(
        value("board", Some(Dot::Green), None),
        json!({ "app": "board", "dot": "green" })
    );
    assert_eq!(
        value("board", None, Some("18h")),
        json!({ "app": "board", "text": "18h" })
    );
    assert_eq!(
        value("board", Some(Dot::None), Some("18h")),
        json!({ "app": "board", "dot": "none", "text": "18h" })
    );
    // nothing to show is refused: a badge is removed with `clear`
    assert_eq!(Badge::new("board", None, None), Err(BadgeError::Empty));
    assert_eq!(
        Badge::new("board", Some(Dot::None), None),
        Err(BadgeError::Empty)
    );
}

#[test]
fn the_text_is_trimmed_of_plain_spaces_only_and_never_cut() {
    assert_eq!(TEXT_MAX, 8);
    assert_eq!(
        value("board", None, Some("  ok  "))["text"],
        "ok",
        "U+0020 is trimmed"
    );
    assert_eq!(
        value("board", None, Some("12345678"))["text"],
        "12345678",
        "8 characters is the limit"
    );
    assert_eq!(
        value("board", None, Some("ÅÅÅÅÅÅÅÅ"))["text"],
        "ÅÅÅÅÅÅÅÅ",
        "characters, not bytes"
    );
    assert_eq!(
        value("board", None, Some("\u{a0}x"))["text"],
        "\u{a0}x",
        "no other space is trimmed"
    );
    assert_eq!(value("board", None, Some("\u{feff}x"))["text"], "\u{feff}x");
    assert_eq!(
        Badge::new("board", None, Some("")),
        Err(BadgeError::TextEmpty)
    );
    assert_eq!(
        Badge::new("board", None, Some("   ")),
        Err(BadgeError::TextEmpty)
    );
    assert_eq!(
        Badge::new("board", Some(Dot::Red), Some(" ")),
        Err(BadgeError::TextEmpty)
    );
    assert_eq!(
        Badge::new("board", None, Some("123456789")),
        Err(BadgeError::TextTooLong)
    );
    assert_eq!(
        Badge::new("board", None, Some("ÅÅÅÅÅÅÅÅÅ")),
        Err(BadgeError::TextTooLong)
    );
    for bad in [
        "a\nb",
        "a\rb",
        "a\tb",
        "a\u{7}b",
        "a\u{2028}b",
        "a\u{2029}b",
        "\u{85}x",
        "ok\n",
        "\nok",
        " ok\n",
    ] {
        assert_eq!(
            Badge::new("board", None, Some(bad)),
            Err(BadgeError::TextNotOneLine),
            "{bad:?}"
        );
    }
}

#[test]
fn an_app_id_and_a_ticket_are_checked() {
    for app in ["", "Board", "1board", "bo ard", "a_b", &"a".repeat(49)] {
        assert_eq!(
            Badge::new(app, Some(Dot::Red), None),
            Err(BadgeError::App),
            "{app:?}"
        );
        assert_eq!(Badge::clear(app), Err(BadgeError::App), "{app:?}");
    }
    assert!(Badge::new(&"a".repeat(48), Some(Dot::Red), None).is_ok());
    let b = Badge::new("board", Some(Dot::Red), Some("late"))
        .unwrap()
        .for_ticket(TICKET)
        .unwrap();
    assert_eq!(
        b.to_value(),
        json!({ "app": "board", "dot": "red", "text": "late", "ticket": TICKET })
    );
    assert_eq!(
        Badge::clear("board")
            .unwrap()
            .for_ticket(TICKET)
            .unwrap()
            .to_value(),
        json!({ "app": "board", "clear": true, "ticket": TICKET })
    );
    for bad in [
        "",
        "tkt_x",
        "tkt_0123456789abcdefghjkmnpqrs",
        "0123456789ABCDEFGHJKMNPQRS",
    ] {
        assert_eq!(
            Badge::new("board", Some(Dot::Red), None)
                .unwrap()
                .for_ticket(bad),
            Err(BadgeError::Ticket),
            "{bad:?}"
        );
    }
    assert_eq!(
        Badge::clear("board").unwrap().to_value(),
        json!({ "app": "board", "clear": true })
    );
}

#[test]
fn with_badge_puts_it_in_the_results_meta_and_keeps_the_rest() {
    let badge = Badge::new("board", Some(Dot::Amber), Some("18h")).unwrap();
    let r = with_badge(ok(json!({ "due": 18 })), &badge).unwrap();
    assert_eq!(
        r["_meta"][KEY],
        json!({ "app": "board", "dot": "amber", "text": "18h" })
    );
    assert_eq!(r["structuredContent"], json!({ "due": 18 }));
    assert_eq!(r["isError"], false);
    let mut other = ok(json!({}));
    other["_meta"] = json!({ "buwiz/suggest": [] });
    let r = with_badge(other, &badge).unwrap();
    assert_eq!(r["_meta"]["buwiz/suggest"], json!([]), "another key stays");
    assert_eq!(r["_meta"][KEY]["dot"], "amber");
    // a null _meta is the same as none
    let mut nulled = ok(json!({}));
    nulled["_meta"] = Value::Null;
    assert_eq!(
        with_badge(nulled, &badge).unwrap()["_meta"][KEY]["dot"],
        "amber"
    );
    // a failed result may carry one; the host ignores it
    assert_eq!(
        with_badge(fail("not_found", "No such item."), &badge).unwrap()["isError"],
        true
    );
    assert_eq!(KEY, "buwiz/badge");
}

#[test]
fn a_meta_that_is_not_an_object_is_the_authors_error() {
    let badge = Badge::new("board", Some(Dot::Amber), None).unwrap();
    for meta in [json!("x"), json!([]), json!(3), json!(true)] {
        let mut r = ok(json!({}));
        r["_meta"] = meta.clone();
        assert_eq!(with_badge(r, &badge), Err(BadgeError::Meta), "{meta}");
    }
    assert_eq!(
        with_badge(json!("not a result"), &badge),
        Err(BadgeError::Meta)
    );
}
