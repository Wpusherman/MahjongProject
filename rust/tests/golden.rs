use std::fs;
use std::path::Path;

use suitaku_core::{agari, shanten};

/// The first Rust milestone is reading the JS golden files. A full event-stream
/// replay and a zero-diff comparison with `src/core.js` are still pending.
#[test]
fn golden_files_are_well_formed() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/golden");
    let mut count = 0;
    for entry in fs::read_dir(dir).expect("test/golden is missing") {
        let path = entry.expect("directory entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("read golden file");
        let value: serde_json::Value = serde_json::from_str(&text).expect("parse golden JSON");
        assert!(value.get("actions").expect("actions").is_array(), "actions must be an array");
        assert!(value.get("events").expect("events").is_array(), "events must be an array");
        assert!(value.get("config").is_some(), "config is required");
        count += 1;
    }
    assert!(count > 0, "no golden files found");
}

/// Shanten and win detection against values produced by `src/shanten.js` and
/// `src/agari.js` (`node tools/shanten-golden.js`).
#[test]
fn shanten_and_agari_match_the_js_golden() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/shanten.json");
    let text = fs::read_to_string(&path).expect("run node tools/shanten-golden.js first");
    let value: serde_json::Value = serde_json::from_str(&text).expect("parse shanten golden");
    let hands = value.get("hands").and_then(|v| v.as_array()).expect("hands array");
    assert!(hands.len() > 1000, "golden set is too small");
    for (index, row) in hands.iter().enumerate() {
        let vector = row.get("c").and_then(|v| v.as_array()).expect("counts");
        assert_eq!(vector.len(), 34, "hand {index}: counts length");
        let mut counts = [0u8; 34];
        for (i, n) in vector.iter().enumerate() {
            counts[i] = n.as_u64().expect("count") as u8;
        }
        let melds = row.get("m").and_then(|v| v.as_u64()).expect("melds") as u8;
        let expected_shanten = row.get("s").and_then(|v| v.as_i64()).expect("shanten") as i8;
        let expected_agari = row.get("a").and_then(|v| v.as_bool()).expect("agari");
        assert_eq!(shanten::shanten(&counts, melds), expected_shanten, "hand {index}: shanten");
        assert_eq!(agari::is_agari(&counts, melds), expected_agari, "hand {index}: agari");
    }
}
