use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use suitaku_core::replay;

/// Fields that require yaku/scoring, which this milestone deliberately does not
/// reimplement. Progression identity is still compared in full.
fn normalize_event(mut event: Value) -> Value {
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if kind == "response" {
        if let Some(options) = event.get_mut("options").and_then(|o| o.as_object_mut()) {
            options.remove("win");
        }
    } else if kind == "end" {
        if let Some(result) = event.get_mut("result").and_then(|r| r.as_object_mut()) {
            let keep = [
                "type", "winner", "loser", "tsumo", "winTile", "tenpai", "reason",
            ];
            result.retain(|key, _| keep.contains(&key.as_str()));
        }
    }
    event
}

fn golden_files() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/golden");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            name.starts_with("core-") && name.ends_with(".json")
        })
        .collect();
    files.sort();
    files
}

#[test]
fn golden_replay_matches_the_js_event_stream() {
    let files = golden_files();
    assert!(!files.is_empty(), "no test/golden/core-*.json files found");
    let mut total = 0usize;
    for path in &files {
        let text = fs::read_to_string(path).expect("read golden file");
        let golden: Value = serde_json::from_str(&text).expect("parse golden JSON");
        let expected = golden
            .get("events")
            .and_then(Value::as_array)
            .expect("golden events array");

        let generated = replay::replay_json(&text)
            .unwrap_or_else(|e| panic!("{}: replay failed: {e}", path.display()));

        assert_eq!(
            generated.len(),
            expected.len(),
            "{}: event count differs",
            path.display()
        );
        for (index, (got, want)) in generated.iter().zip(expected.iter()).enumerate() {
            let got = normalize_event(got.clone());
            let want = normalize_event(want.clone());
            assert_eq!(
                got,
                want,
                "{}: first mismatch at event index {index}",
                path.display()
            );
        }
        total += generated.len();
    }
    assert!(total > 0, "no events were compared");
    println!(
        "replay matched {total} events across {} golden files",
        files.len()
    );
}
