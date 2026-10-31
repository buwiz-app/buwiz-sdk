//! base64url without padding (RFC 4648 §5), as the protocol writes keys, seeds,
//! open ids and signatures.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url of `bytes`, no padding.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | (u32::from(b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// Exactly `len` bytes of canonical base64url without padding, else `None`.
pub fn decode_exact(text: &str, len: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(len);
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in text.bytes() {
        let v = ALPHABET.iter().position(|&a| a == byte)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // canonical: the round trip gives the same text (no stray low bits)
    (out.len() == len && encode(&out) == text).then_some(out)
}

/// Canonical base64url without padding, of any length.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    decode_exact(text, text.len() * 3 / 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses_non_canonical_text() {
        for len in 0..40 {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(decode_exact(&encode(&bytes), len), Some(bytes));
        }
        assert_eq!(encode(b"\xfb\xff"), "-_8");
        assert_eq!(decode_exact("-_9", 2), None);
        assert_eq!(decode_exact("AA==", 1), None);
        assert_eq!(
            decode(&encode(b"Date,Amount\n")),
            Some(b"Date,Amount\n".to_vec())
        );
    }
}
