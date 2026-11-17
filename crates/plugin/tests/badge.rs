//! `Badge` and `with_badge`: what a plugin may put on a result as
//! `_meta["buwiz/badge"]` (spec 16.4). `packages/plugin/test/badge.test.ts`
//! runs the same cases.

use buwiz_plugin::badge::{KEY, TEXT_MAX};
use buwiz_plugin::{Badge, BadgeError, Dot, fail, ok, with_badge};
use serde_json::{Value, json};

const TICKET: &str = "tkt_0123456789ABCDEFGHJKMNPQRS";

fn value(app: &str, dot: Option<Dot>, text: Option<&str>) -> Value {
    Badge::new(app, dot, text).unwrap().to_value()
}

#[test]
fn a_badge_sets_a_dot_text_or_both() {
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
        value("board", Some(Dot::Amber), Some("")),
        json!({ "app": "board", "dot": "amber", "text": "" })
    );
    for (dot, word) in [
        (Dot::Red, "red"),
        (Dot::Amber, "amber"),
        (Dot::Green, "green"),
        (Dot::None, "none"),
    ] {
        assert_eq!(value("board", Some(dot), None)["dot"], word);
    }
}

#[test]
fn the_text_is_trimmed_and_never_cut() {
    assert_eq!(value("board", None, Some("  ok \n"))["text"], "ok");
    assert_eq!(TEXT_MAX, 8);
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
    ] {
        assert_eq!(
            Badge::new("board", None, Some(bad)),
            Err(BadgeError::TextNotOneLine),
            "{bad:?}"
        );
    }
}

#[test]
fn a_set_needs_a_dot_or_text_and_an_app_id() {
    assert_eq!(Badge::new("board", None, None), Err(BadgeError::Empty));
    for app in ["", "Board", "1board", "bo ard", "a_b", &"a".repeat(49)] {
        assert_eq!(
            Badge::new(app, Some(Dot::Red), None),
            Err(BadgeError::App),
            "{app:?}"
        );
        assert_eq!(Badge::clear(app), Err(BadgeError::App), "{app:?}");
    }
    assert!(Badge::new(&"a".repeat(48), Some(Dot::Red), None).is_ok());
}

#[test]
fn a_ticket_narrows_a_badge_or_a_clear() {
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
}

#[test]
fn a_clear_is_the_app_and_clear_only() {
    assert_eq!(
        Badge::clear("board").unwrap().to_value(),
        json!({ "app": "board", "clear": true })
    );
}

#[test]
fn with_badge_puts_it_in_the_results_meta_and_keeps_the_rest() {
    let badge = Badge::new("board", Some(Dot::Amber), Some("18h")).unwrap();
    let r = with_badge(ok(json!({ "due": 18 })), &badge);
    assert_eq!(
        r["_meta"][KEY],
        json!({ "app": "board", "dot": "amber", "text": "18h" })
    );
    assert_eq!(r["structuredContent"], json!({ "due": 18 }));
    assert_eq!(r["isError"], false);
    let mut other = ok(json!({}));
    other["_meta"] = json!({ "buwiz/suggest": [] });
    let r = with_badge(other, &badge);
    assert_eq!(r["_meta"]["buwiz/suggest"], json!([]), "another key stays");
    assert_eq!(r["_meta"][KEY]["dot"], "amber");
    // a failed result may carry one; the host ignores it
    assert_eq!(
        with_badge(fail("not_found", "No such item."), &badge)["isError"],
        true
    );
    assert_eq!(KEY, "buwiz/badge");
}
