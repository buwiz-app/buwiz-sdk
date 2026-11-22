//! A badge on a pin: `_meta["buwiz/badge"]` (spec 16.4).
//!
//! Any tool result may carry one badge for one of the plugin's apps: a dot and
//! up to [`TEXT_MAX`] characters the host shows on the pins of that app. A
//! [`Badge`] is checked as it is made, so a plugin cannot put a malformed one
//! on a result by accident; [`with_badge`] puts it there.
//!
//! The host takes a `text` as written (1 to 8 characters, no hidden
//! character (spec 4.2), no space at either end). [`Badge::new`] trims
//! plain spaces (U+0020 only) from the text it is given before it checks it,
//! and refuses what the host would call malformed; the TypeScript `badge` does
//! the same, so both accept and refuse exactly the same inputs.
//!
//! ```
//! use buwiz_plugin::{Badge, Dot, ok, with_badge};
//! use serde_json::json;
//!
//! let badge = Badge::new("board", Some(Dot::Amber), Some("18h")).unwrap();
//! let result = with_badge(ok(json!({ "due": 18 })), &badge).unwrap();
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
    /// A set that shows nothing: no dot (or `none`) and no text. Use [`Badge::clear`].
    Empty,
    /// A text that is empty once its spaces are trimmed; leave the text out.
    TextEmpty,
    /// The result is not an object, or its `_meta` is neither absent, null nor an object.
    Meta,
    /// More than [`TEXT_MAX`] characters.
    TextTooLong,
    /// A hidden character (spec 4.2): a control, a line separator, a bidi override, a zero-width one.
    TextHidden,
    /// The ticket breaks the ticket grammar.
    Ticket,
}

impl std::fmt::Display for BadgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            BadgeError::App => "the app id breaks the app id grammar",
            BadgeError::Empty => {
                "a badge shows a dot other than none, or text; to remove one use Badge::clear"
            }
            BadgeError::TextEmpty => "a badge's text is empty; leave it out",
            BadgeError::Meta => "the result is not an object, or its _meta is not",
            BadgeError::TextTooLong => "a badge's text is at most 8 characters",
            BadgeError::TextHidden => "a badge's text has a hidden character (spec 4.2)",
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

/// A hidden character (spec 4.2): one that changes how a text reads, or whether it is one line,
/// without showing. Explicit ranges, so no Unicode table decides it: the C0 and C1 controls and
/// U+007F, U+00AD, U+061C, U+180E, U+200B to U+200F, U+2028 to U+202E (the line and paragraph
/// separators and the bidi overrides), U+2060 to U+206F, U+FE00 to U+FE0F, U+FEFF, U+FFF9 to
/// U+FFFB and U+E0000 to U+E0FFF.
pub fn hidden(c: char) -> bool {
    matches!(c as u32,
        0x00..=0x1F | 0x7F..=0x9F | 0xAD | 0x61C | 0x180E | 0x200B..=0x200F | 0x2028..=0x202E
        | 0x2060..=0x206F | 0xFE00..=0xFE0F | 0xFEFF | 0xFFF9..=0xFFFB | 0xE0000..=0xE0FFF)
}

/// `^[a-z][a-z0-9-]{0,47}$`.
fn is_app_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 48
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl Badge {
    /// A badge for `app`: a dot other than `none`, text, or both. Plain spaces
    /// (U+0020, nothing else) are trimmed from the text's ends; what is left
    /// must be 1 to [`TEXT_MAX`] characters with no hidden character (spec 4.2), or it is refused, never cut.
    pub fn new(app: &str, dot: Option<Dot>, text: Option<&str>) -> Result<Badge, BadgeError> {
        if !is_app_id(app) {
            return Err(BadgeError::App);
        }
        let text = match text.map(|t| t.trim_matches(' ')) {
            None => None,
            Some("") => return Err(BadgeError::TextEmpty),
            Some(t) if t.chars().any(hidden) => return Err(BadgeError::TextHidden),
            Some(t) if t.chars().count() > TEXT_MAX => return Err(BadgeError::TextTooLong),
            Some(t) => Some(t.to_owned()),
        };
        if matches!(dot, None | Some(Dot::None)) && text.is_none() {
            return Err(BadgeError::Empty);
        }
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
/// stays. A result with no `_meta`, or a null one, gets one. A `_meta` that is
/// anything but an object (or a result that is not an object) is the author's
/// error: [`BadgeError::Meta`]. A result that fails (`isError`) has its badge
/// ignored by the host.
pub fn with_badge(mut result: Value, badge: &Badge) -> Result<Value, BadgeError> {
    let o = result.as_object_mut().ok_or(BadgeError::Meta)?;
    let meta = o.entry("_meta").or_insert(Value::Null);
    if meta.is_null() {
        *meta = json!({});
    }
    meta.as_object_mut()
        .ok_or(BadgeError::Meta)?
        .insert(KEY.into(), badge.to_value());
    Ok(result)
}
