//! JSON Canonicalization Scheme (RFC 8785) and I-JSON parsing for the
//! objects the protocol signs and hashes: the manifest, session certificates
//! and permissions.
//!
//! The bytes must match the Buwiz Bot's broker (`server/src/v1/jcs.mjs`) exactly, so
//! this follows its signing form (`canonicalSigned`): object keys sorted by
//! UTF-16 code units, strings escaped as `JSON.stringify` escapes them, and
//! numbers that are safe integers only. A number that is not a safe integer
//! is refused (`NotSignable`) rather than printed, so no float is ever
//! parsed or formatted here: `1e3`, `1.0` and `100E-2` are normalised as
//! exact decimals, and `0.5` or `1e21` are refused.
//!
//! [`parse`] is the I-JSON reader (RFC 7493): duplicate keys, lone
//! surrogates and malformed text are `NotIJson`, where `serde_json` would
//! keep the last duplicate. Both behaviours are checked against the Bot's
//! shared vectors (`vectors/jcs.json`, run by `tests/vectors.rs`).

use std::fmt;

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

/// `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE: u64 = (1 << 53) - 1;

/// Why a text has no signable canonical form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JcsError {
    /// Not I-JSON: malformed, a duplicate key or a lone surrogate.
    NotIJson(String),
    /// Valid JSON, but it holds a number that is not a safe integer.
    NotSignable(String),
}

impl fmt::Display for JcsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JcsError::NotIJson(why) => write!(f, "not I-JSON: {why}"),
            JcsError::NotSignable(why) => write!(f, "not signable: {why}"),
        }
    }
}

impl std::error::Error for JcsError {}

/// The JCS text of `value`. Numbers must be safe integers.
pub fn canonical(value: &Value) -> Result<String, JcsError> {
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}

/// The JCS text of a JSON text: [`parse`] then [`canonical`].
pub fn canonical_text(text: &str) -> Result<String, JcsError> {
    canonical(&parse(text)?)
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Lowercase hex SHA-256 of the JCS bytes of `value`.
pub fn sha256_jcs(value: &Value) -> Result<String, JcsError> {
    Ok(sha256_hex(canonical(value)?.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    out
}

fn write(value: &Value, out: &mut String) -> Result<(), JcsError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&integer(number)?),
        Value::String(text) => string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // RFC 8785 3.2.3: by UTF-16 code units, not by UTF-8 bytes
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                string(key, out);
                out.push(':');
                write(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// A safe integer as JS prints it; anything else is refused.
fn integer(number: &Number) -> Result<String, JcsError> {
    let refuse = || {
        JcsError::NotSignable(format!(
            "signed objects carry safe integers only, not {number}"
        ))
    };
    if let Some(n) = number.as_i64() {
        return if n.unsigned_abs() <= MAX_SAFE {
            Ok(n.to_string())
        } else {
            Err(refuse())
        };
    }
    if let Some(n) = number.as_u64() {
        return if n <= MAX_SAFE {
            Ok(n.to_string())
        } else {
            Err(refuse())
        };
    }
    Err(refuse())
}

/// A string as `JSON.stringify` writes it: `"` and `\` escaped, the five
/// short escapes, other controls as lowercase `\u00xx`, the rest as is.
fn string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                const DIGITS: &[u8; 16] = b"0123456789abcdef";
                let n = u32::from(c) as usize;
                out.push_str("\\u00");
                out.push(char::from(DIGITS[n >> 4]));
                out.push(char::from(DIGITS[n & 15]));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ------------------------------------------------------------ I-JSON

const MAX_DEPTH: usize = 512;

/// JSON text to a value, refusing duplicate keys, lone surrogates, raw
/// control characters, trailing text and any number that is not a safe
/// integer (after exact normalisation: `1e3` is 1000).
pub fn parse(text: &str) -> Result<Value, JcsError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        at: 0,
    };
    let value = parser.value(0)?;
    parser.skip();
    if parser.at != parser.bytes.len() {
        return Err(parser.fail("trailing text"));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn fail(&self, why: &str) -> JcsError {
        JcsError::NotIJson(format!("{why} at offset {}", self.at))
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn skip(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), JcsError> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(self.fail(&format!("expected {}", char::from(byte))))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, JcsError> {
        if depth > MAX_DEPTH {
            return Err(self.fail("nested too deep"));
        }
        self.skip();
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.word("true", Value::Bool(true)),
            Some(b'f') => self.word("false", Value::Bool(false)),
            Some(b'n') => self.word("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.fail("malformed JSON")),
        }
    }

    fn word(&mut self, word: &str, value: Value) -> Result<Value, JcsError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.fail("malformed JSON"))
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, JcsError> {
        self.at += 1;
        let mut map = Map::new();
        self.skip();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.skip();
            if self.peek() != Some(b'"') {
                return Err(self.fail("expected a key"));
            }
            let key = self.string()?;
            if map.contains_key(&key) {
                let shown: String = key.chars().take(80).collect();
                return Err(self.fail(&format!("duplicate key {shown:?}")));
            }
            self.skip();
            self.expect(b':')?;
            let value = self.value(depth + 1)?;
            map.insert(key, value);
            self.skip();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Value::Object(map));
                }
                _ => return Err(self.fail("expected , or }")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, JcsError> {
        self.at += 1;
        let mut items = Vec::new();
        self.skip();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.skip();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.fail("expected , or ]")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, JcsError> {
        let digits = self
            .bytes
            .get(self.at..self.at + 4)
            .ok_or_else(|| self.fail("short \\u escape"))?;
        let mut n = 0u32;
        for &d in digits {
            let v = char::from(d)
                .to_digit(16)
                .ok_or_else(|| self.fail("bad \\u escape"))?;
            n = n * 16 + v;
        }
        self.at += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, JcsError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // the input is a &str, and we stopped on an ASCII byte
            out.push_str(
                std::str::from_utf8(&self.bytes[start..self.at])
                    .map_err(|_| self.fail("bad UTF-8"))?,
            );
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = self
                        .peek()
                        .ok_or_else(|| self.fail("unterminated string"))?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let high = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&high) {
                                if !self.bytes[self.at..].starts_with(b"\\u") {
                                    return Err(self.fail("a string holds a lone surrogate"));
                                }
                                self.at += 2;
                                let low = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err(self.fail("a string holds a lone surrogate"));
                                }
                                0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&high) {
                                return Err(self.fail("a string holds a lone surrogate"));
                            } else {
                                high
                            };
                            out.push(
                                char::from_u32(code).ok_or_else(|| self.fail("bad \\u escape"))?,
                            );
                        }
                        _ => return Err(self.fail("bad escape")),
                    }
                }
                Some(_) => return Err(self.fail("a raw control character in a string")),
                None => return Err(self.fail("unterminated string")),
            }
        }
    }

    /// `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`, normalised exactly.
    fn number(&mut self) -> Result<Value, JcsError> {
        let start = self.at;
        let negative = self.peek() == Some(b'-');
        if negative {
            self.at += 1;
        }
        let int = self.digits();
        if int.is_empty() || (int.len() > 1 && int.starts_with('0')) {
            return Err(self.fail("malformed number"));
        }
        let mut frac = String::new();
        if self.peek() == Some(b'.') {
            self.at += 1;
            frac = self.digits();
            if frac.is_empty() {
                return Err(self.fail("malformed number"));
            }
        }
        let mut exponent: i64 = 0;
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            let sign: i64 = match self.peek() {
                Some(b'-') => {
                    self.at += 1;
                    -1
                }
                Some(b'+') => {
                    self.at += 1;
                    1
                }
                _ => 1,
            };
            let digits = self.digits();
            if digits.is_empty() {
                return Err(self.fail("malformed number"));
            }
            // saturate: anything past 10^9 is far outside the safe range
            let magnitude = digits.parse::<i64>().unwrap_or(i64::MAX).min(1_000_000_000);
            exponent = sign * magnitude;
        }
        let lexeme = String::from_utf8_lossy(&self.bytes[start..self.at]).into_owned();
        let not_signable = || JcsError::NotSignable(format!("{lexeme} is not a safe integer"));

        // the value is mantissa * 10^scale, both exact
        let mut mantissa = format!("{int}{frac}");
        let mut scale = exponent - frac.len() as i64;
        let trimmed = mantissa.trim_start_matches('0');
        if trimmed.is_empty() {
            return Ok(Value::Number(Number::from(0)));
        }
        mantissa = trimmed.to_string();
        while mantissa.ends_with('0') {
            mantissa.pop();
            scale += 1;
        }
        if scale < 0 || mantissa.len() as i64 + scale > 16 {
            return Err(not_signable());
        }
        let mut n: u64 = mantissa.parse().map_err(|_| not_signable())?;
        for _ in 0..scale {
            n = n.checked_mul(10).ok_or_else(not_signable)?;
        }
        if n > MAX_SAFE {
            return Err(not_signable());
        }
        let n = n as i64;
        Ok(Value::Number(Number::from(if negative { -n } else { n })))
    }

    fn digits(&mut self) -> String {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        String::from_utf8_lossy(&self.bytes[start..self.at]).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sort_by_utf16_and_strings_escape_like_json_stringify() {
        let value = json!({"b": 1, "a": [true, null, "x\"\n\u{1}é"], "A": {"z": -2, "y": 0}});
        assert_eq!(
            canonical(&value).unwrap(),
            r#"{"A":{"y":0,"z":-2},"a":[true,null,"x\"\n\u0001é"],"b":1}"#
        );
        // U+FF61 sorts after U+1F600's surrogates in UTF-16, before it in UTF-8
        let value = json!({"\u{ff61}": 1, "\u{1f600}": 2});
        assert_eq!(
            canonical(&value).unwrap(),
            "{\"\u{1f600}\":2,\"\u{ff61}\":1}"
        );
    }

    #[test]
    fn unsafe_integers_are_refused() {
        assert!(canonical(&json!(9_007_199_254_740_992u64)).is_err());
        assert!(canonical(&json!(-9_007_199_254_740_992i64)).is_err());
        assert_eq!(
            canonical(&json!(9_007_199_254_740_991u64)).unwrap(),
            "9007199254740991"
        );
    }

    #[test]
    fn numbers_normalise_exactly_without_floats() {
        assert_eq!(
            canonical_text("[1e3, 1.0, 100E-2, -5e0, -0, 0e99]").unwrap(),
            "[1000,1,1,-5,0,0]"
        );
        assert!(matches!(
            canonical_text("[0.5]"),
            Err(JcsError::NotSignable(_))
        ));
        assert!(matches!(
            canonical_text("[1e21]"),
            Err(JcsError::NotSignable(_))
        ));
        assert!(matches!(
            canonical_text("[1e999999999999999999]"),
            Err(JcsError::NotSignable(_))
        ));
        assert!(matches!(canonical_text("[01]"), Err(JcsError::NotIJson(_))));
        assert!(matches!(canonical_text("[1.]"), Err(JcsError::NotIJson(_))));
    }

    #[test]
    fn the_empty_permissions_digest_is_the_sha256_of_braces() {
        // sha256("{}"), as the broker's permsDigest(undefined) answers
        assert_eq!(
            sha256_jcs(&json!({})).unwrap(),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }
}
