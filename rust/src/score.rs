//! Basic score table, matching `src/score.js` (`limitBase`, rounding, payments).
//!
//! The full yaku enumeration is not ported yet; callers pass han and fu.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Score {
    pub han: u8,
    pub fu: u8,
    pub base: u32,
    pub points: u32,
}

fn round_up_100(n: u32) -> u32 {
    n.div_ceil(100) * 100
}

pub fn limit_base(han: u8, base: u32) -> u32 {
    if han >= 13 {
        8000
    } else if han >= 11 {
        6000
    } else if han >= 8 {
        4000
    } else if han >= 6 {
        3000
    } else if han >= 5 {
        2000
    } else if han >= 3 && base >= 2000 {
        // 3 han 70 fu+, 4 han 40 fu+ and similar are capped at mangan.
        2000
    } else {
        base
    }
}

/// Total points received by the winner. A tsumo total includes all three
/// payments; a ron total is the discarder's payment.
pub fn compute(han: u8, fu: u8, tsumo: bool, dealer: bool) -> Score {
    let raw_base = fu as u32 * 2u32.pow(2 + han as u32);
    let base = limit_base(han, raw_base);
    let points = if tsumo {
        if dealer {
            round_up_100(base * 2) * 3
        } else {
            round_up_100(base * 2) + round_up_100(base) * 2
        }
    } else if dealer {
        round_up_100(base * 6)
    } else {
        round_up_100(base * 4)
    };
    Score {
        han,
        fu,
        base,
        points,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_payments_match_the_js_table() {
        // 3 han 30 fu ron, non-dealer: 30 * 2^5 = 960 -> 3900.
        assert_eq!(compute(3, 30, false, false).points, 3900);
        // 4 han 30 fu: 1920 -> 7700.
        assert_eq!(compute(4, 30, false, false).points, 7700);
        // 4 han 40 fu is capped at mangan: 8000.
        assert_eq!(compute(4, 40, false, false).points, 8000);
        // 3 han 30 fu tsumo, non-dealer: 1000 + 2000 = 4000 total.
        assert_eq!(compute(3, 30, true, false).points, 4000);
        // 3 han 30 fu tsumo, dealer: 2000 * 3 = 6000.
        assert_eq!(compute(3, 30, true, true).points, 6000);
    }

    #[test]
    fn limits_are_applied() {
        assert_eq!(limit_base(13, 1), 8000);
        assert_eq!(limit_base(11, 1), 6000);
        assert_eq!(limit_base(8, 1), 4000);
        assert_eq!(limit_base(6, 1), 3000);
        assert_eq!(limit_base(5, 1), 2000);
    }
}
