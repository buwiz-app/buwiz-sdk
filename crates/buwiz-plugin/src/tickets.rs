//! Tickets: what a subject (a taxpayer, a book, a document) is called
//! everywhere outside the plugin process.
//!
//! A ticket is `tkt_` and 26 Crockford base32 characters, 130 bits from the
//! OS CSPRNG. The Bot, the model and the apps see only tickets; the plugin
//! maps them back to its own subjects. `buwiz.ticket.resolve` answers a
//! title for a ticket, never the subject.
//!
//! [`Tickets`] keeps the map in memory, so tickets die with the process.
//! A plugin that needs them to outlive a restart keeps them in its own
//! store and calls [`new_ticket`] itself.

use std::collections::HashMap;
use std::hash::Hash;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A fresh ticket.
pub fn new_ticket() -> String {
    let mut bytes = [0u8; 17];
    getrandom::fill(&mut bytes).expect("the OS random source");
    // 136 random bits; the top 130 make the 26 characters
    let mut out = String::with_capacity(30);
    out.push_str("tkt_");
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in bytes {
        if out.len() == 30 {
            break;
        }
        acc = (acc << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 && out.len() < 30 {
            bits -= 5;
            out.push(char::from(CROCKFORD[((acc >> bits) & 31) as usize]));
        }
        acc &= (1 << bits) - 1;
    }
    out
}

/// Whether `text` has a ticket's shape (`^tkt_[0-9A-HJKMNP-TV-Z]{26}$`).
pub fn is_ticket(text: &str) -> bool {
    text.strip_prefix("tkt_")
        .is_some_and(|rest| rest.len() == 26 && rest.bytes().all(|b| CROCKFORD.contains(&b)))
}

/// Subject ↔ ticket, in this process only. One ticket per subject.
#[derive(Debug, Clone)]
pub struct Tickets<S> {
    by_subject: HashMap<S, String>,
    by_ticket: HashMap<String, S>,
}

impl<S> Default for Tickets<S> {
    fn default() -> Self {
        Self {
            by_subject: HashMap::new(),
            by_ticket: HashMap::new(),
        }
    }
}

impl<S: Clone + Eq + Hash> Tickets<S> {
    /// The subject's ticket, issued on first use.
    pub fn issue(&mut self, subject: &S) -> String {
        if let Some(ticket) = self.by_subject.get(subject) {
            return ticket.clone();
        }
        let ticket = new_ticket();
        self.by_subject.insert(subject.clone(), ticket.clone());
        self.by_ticket.insert(ticket.clone(), subject.clone());
        ticket
    }

    /// The subject of a ticket this store issued.
    pub fn subject(&self, ticket: &str) -> Option<&S> {
        self.by_ticket.get(ticket)
    }

    /// Forget every ticket (`buwiz.uninstall`).
    pub fn clear(&mut self) {
        self.by_subject.clear();
        self.by_ticket.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_have_the_protocol_shape_and_differ() {
        let (a, b) = (new_ticket(), new_ticket());
        assert!(is_ticket(&a) && is_ticket(&b), "{a} {b}");
        assert_ne!(a, b);
        assert!(!is_ticket("tkt_0123456789ABCDEFGHJKMNPQRI"));
        assert!(!is_ticket("tkt_short"));
    }

    #[test]
    fn a_subject_keeps_its_ticket_until_cleared() {
        let mut tickets = Tickets::default();
        let ada = tickets.issue(&"Ada".to_string());
        assert_eq!(tickets.issue(&"Ada".to_string()), ada);
        assert_eq!(tickets.subject(&ada).map(String::as_str), Some("Ada"));
        tickets.clear();
        assert_eq!(tickets.subject(&ada), None);
    }
}
