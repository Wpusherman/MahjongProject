//! Rust core skeleton.
//!
//! The JS engine in `src/core.js` is the reference implementation. This crate
//! currently contains the tile primitives and module boundaries only. The
//! shanten/agari/score functions are placeholders until the golden event-stream
//! replay in `tests/` can compare them with the JS core.

pub mod agari;
pub mod score;
pub mod shanten;
pub mod tiles;
