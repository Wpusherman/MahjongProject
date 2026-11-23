//! Deterministic PRNG used when a wall is not supplied.
//!
//! This mirrors `src/core.js` exactly: `mulberry32(seedToUint(seed))` followed
//! by the Fisher-Yates shuffle in `src/tiles.js`. Only the low 32 bits of the
//! seed matter because JavaScript's `>>> 0` is applied first.

use serde_json::Value;

use crate::tiles::{WALL_SIZE};

/// mulberry32 state. The algorithm works on 32-bit wrapping arithmetic, which
/// is identical to the signed `| 0` / `Math.imul` steps in JS once truncated.
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// One `rng()` call: a uniform f64 in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(1 | self.state);
        t = t
            .wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))
            ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

/// `seedToUint` from `src/core.js`: finite numbers are truncated to uint32,
/// anything else is hashed from its string form (FNV-1a over UTF-16 units).
pub fn seed_to_uint(seed: &Value) -> u32 {
    if let Some(n) = seed.as_i64() {
        return n as u32;
    }
    if let Some(f) = seed.as_f64() {
        if f.is_finite() {
            return f.trunc() as i64 as u32;
        }
    }
    let text = match seed {
        Value::String(s) => s.clone(),
        Value::Null => "0".to_string(),
        other => other.to_string(),
    };
    let mut hash: u32 = 2_166_136_261;
    for unit in text.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

/// `T.buildWall(rng)` from `src/tiles.js`.
pub fn build_wall(rng: &mut Mulberry32) -> Vec<u8> {
    let mut wall: Vec<u8> = (0..WALL_SIZE as u8).collect();
    for i in (1..WALL_SIZE).rev() {
        let j = (rng.next_f64() * (i as f64 + 1.0)).floor() as usize;
        wall.swap(i, j);
    }
    wall
}

/// Convenience: regenerate the wall from a golden-file seed.
pub fn wall_from_seed(seed: &Value) -> Vec<u8> {
    build_wall(&mut Mulberry32::new(seed_to_uint(seed)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn walls_match_the_js_goldens() {
        // First eight ids of test/golden/core-1.json and core-20261015.json.
        let one = wall_from_seed(&json!(1));
        assert_eq!(&one[..8], &[16, 77, 41, 96, 65, 69, 112, 114]);
        let big = wall_from_seed(&json!(20261015));
        assert_eq!(&big[..8], &[48, 60, 107, 111, 29, 41, 101, 108]);
        let mut sorted = one.clone();
        sorted.sort_unstable();
        assert!(crate::tiles::valid_wall(&sorted));
    }

    #[test]
    fn string_seeds_are_hashed() {
        assert_ne!(seed_to_uint(&json!("abc")), 0);
        assert_eq!(seed_to_uint(&json!(42)), 42);
    }
}
