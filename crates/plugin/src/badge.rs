//! A badge on a pin: `_meta["buwiz/badge"]` (spec 16.4).
//!
//! Any tool result may carry one badge for one of the plugin's apps: a dot and
//! up to [`TEXT_MAX`] characters the host shows on the pins of that app. A
//! [`Badge`] is checked as it is made, so a plugin cannot put a malformed one
//! on a result by accident; [`with_badge`] puts it there.
//!
//! ```
//! use buwiz_plugin::{Badge, Dot, ok, with_badge};
//! use serde_json::json;
//!
//! let badge = Badge::new("board", Some(Dot::Amber), Some("18h")).unwrap();
//! let result = with_badge(ok(json!({ "due": 18 })), &badge);
//! assert_eq!(result["_meta"]["buwiz/badge"]["dot"], "amber");
//! ```

use serde_json::{Map, Value, json};

use crate::tickets::is_ticket;

/// The `_meta` key.
pub const KEY: &str = "buwiz/badge";
/// The most characters a badge's text has.
pub const TEXT_MAX: usize = 8;

/// A badge's dot. `None` shows no dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dot {
    Red,
    Amber,
    Green,
    None,
}

impl Dot {
    /// The word the protocol uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Dot::Red => "red",
            Dot::Amber => "amber",
            Dot::Green => "green",
            Dot::None => "none",
        }
    }
}

/// Why a badge was refused as it was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeError {
    /// The app id breaks the app id grammar.
    App,
    /// A set with neither a dot nor text.
    Empty,
    /// More than [`TEXT_MAX`] characters.
    TextTooLong,
    /// A control character or a line break.
    TextNotOneLine,
    /// The ticket breaks the ticket grammar.
    Ticket,
}

impl std::fmt::Display for BadgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            BadgeError::App => "the app id breaks the app id grammar",
            BadgeError::Empty => "a badge sets a dot or text; to remove one use Badge::clear",
            BadgeError::TextTooLong => "a badge's text is at most 8 characters",
            BadgeError::TextNotOneLine => "a badge's text is one line, with no control character",
            BadgeError::Ticket => "the ticket breaks the ticket grammar",
        })
    }
}

impl std::error::Error for BadgeError {}

/// A badge for the pins of one of the plugin's apps, or its removal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Badge {
    app: String,
    dot: Option<Dot>,
    text: Option<String>,
    ticket: Option<String>,
    clear: bool,
}

/// `^[a-z][a-z0-9-]{0,47}$`.
fn is_app_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 48
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl Badge {
    /// A badge for `app`: a dot, text, or both. The text is trimmed; more than
    /// [`TEXT_MAX`] characters, a control character or a line break is refused,
    /// never cut. At least one of the two is needed.
    pub fn new(app: &str, dot: Option<Dot>, text: Option<&str>) -> Result<Badge, BadgeError> {
        if !is_app_id(app) {
            return Err(BadgeError::App);
        }
        if dot.is_none() && text.is_none() {
            return Err(BadgeError::Empty);
        }
        let text = match text.map(str::trim) {
            None => None,
            Some(t)
                if t.chars()
                    .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}') =>
            {
                return Err(BadgeError::TextNotOneLine);
            }
            Some(t) if t.chars().count() > TEXT_MAX => return Err(BadgeError::TextTooLong),
            Some(t) => Some(t.to_owned()),
        };
        Ok(Badge {
            app: app.to_owned(),
            dot,
            text,
            ticket: None,
            clear: false,
        })
    }

    /// The badge that removes `app`'s badge.
    pub fn clear(app: &str) -> Result<Badge, BadgeError> {
        if !is_app_id(app) {
            return Err(BadgeError::App);
        }
        Ok(Badge {
            app: app.to_owned(),
            dot: None,
            text: None,
            ticket: None,
            clear: true,
        })
    }

    /// Narrows the badge (or the clear) to the pins that carry `ticket`.
    pub fn for_ticket(mut self, ticket: &str) -> Result<Badge, BadgeError> {
        if !is_ticket(ticket) {
            return Err(BadgeError::Ticket);
        }
        self.ticket = Some(ticket.to_owned());
        Ok(self)
    }

    /// The value of `_meta["buwiz/badge"]`.
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("app".into(), json!(self.app));
        if self.clear {
            o.insert("clear".into(), json!(true));
        }
        if let Some(dot) = self.dot {
            o.insert("dot".into(), json!(dot.as_str()));
        }
        if let Some(text) = &self.text {
            o.insert("text".into(), json!(text));
        }
        if let Some(ticket) = &self.ticket {
            o.insert("ticket".into(), json!(ticket));
        }
        Value::Object(o)
    }
}

/// `result` with `_meta["buwiz/badge"]` set to `badge`; the rest of its `_meta`
/// stays. A result that fails (`isError`) has its badge ignored by the host.
pub fn with_badge(mut result: Value, badge: &Badge) -> Value {
    if let Some(o) = result.as_object_mut() {
        let meta = o.entry("_meta").or_insert_with(|| json!({}));
        if let Some(m) = meta.as_object_mut() {
            m.insert(KEY.into(), badge.to_value());
        }
    }
    result
}
