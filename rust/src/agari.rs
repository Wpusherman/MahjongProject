//! Win-shape detection, ported from `src/agari.js`.
//!
//! A hand is complete when the shanten number is negative (standard form,
//! seven pairs or thirteen orphans). This mirrors the JS engine's acceptance.

use crate::shanten;

pub fn is_agari(counts: &[u8; 34], melds: u8) -> bool {
    shanten::shanten(counts, melds) < 0
}

pub fn is_chiitoi(counts: &[u8; 34], melds: u8) -> bool {
    if melds > 0 {
        return false;
    }
    let mut pairs = 0;
    let mut sum = 0;
    for &n in counts.iter() {
        if n >= 2 {
            pairs += 1;
        }
        if n >= 4 {
            return false;
        }
        sum += n as i32;
    }
    pairs == 7 && sum == 14
}

pub fn is_kokushi(counts: &[u8; 34], melds: u8) -> bool {
    if melds > 0 {
        return false;
    }
    let mut kinds = 0;
    let mut has_pair = false;
    let mut sum = 0;
    for t in crate::tiles::YAOCHU_TYPES {
        if counts[t] > 0 {
            kinds += 1;
        }
        if counts[t] >= 2 {
            has_pair = true;
        }
        sum += counts[t] as i32;
    }
    for (t, &n) in counts.iter().enumerate() {
        if !crate::tiles::YAOCHU_TYPES.contains(&t) && n > 0 {
            return false;
        }
    }
    kinds == 13 && has_pair && sum == 14
}
