//! Win-shape detection, ported from `src/agari.js`.
//!
//! A hand is complete when the 14 concealed tiles (or 14 - 3*melds when there
//! are open melds) decompose into exactly `4 - melds` sets plus one pair.
//! Seven pairs and thirteen orphans are only possible with no open melds.

fn can_form_sets(c: &mut [u8; 34], needed: i32) -> bool {
    let mut t = 0;
    while t < 34 && c[t] == 0 {
        t += 1;
    }
    if t >= 34 {
        return needed == 0;
    }
    if needed <= 0 {
        return false;
    }
    if c[t] >= 3 {
        c[t] -= 3;
        if can_form_sets(c, needed - 1) {
            c[t] += 3;
            return true;
        }
        c[t] += 3;
    }
    if t < 27 && t % 9 <= 6 && c[t + 1] > 0 && c[t + 2] > 0 {
        c[t] -= 1;
        c[t + 1] -= 1;
        c[t + 2] -= 1;
        if can_form_sets(c, needed - 1) {
            c[t] += 1;
            c[t + 1] += 1;
            c[t + 2] += 1;
            return true;
        }
        c[t] += 1;
        c[t + 1] += 1;
        c[t + 2] += 1;
    }
    false
}

pub fn is_agari(counts: &[u8; 34], melds: u8) -> bool {
    if is_chiitoi(counts, melds) || is_kokushi(counts, melds) {
        return true;
    }
    if melds > 4 {
        return false;
    }
    let needed = 4 - melds as i32;
    for pair in 0..34 {
        if counts[pair] < 2 {
            continue;
        }
        let mut c = *counts;
        c[pair] -= 2;
        if can_form_sets(&mut c, needed) {
            return true;
        }
    }
    false
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
