use std::fs;
use std::path::Path;

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
