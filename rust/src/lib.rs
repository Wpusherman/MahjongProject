//! Rust core skeleton.
//!
//! The JS engine in `src/core.js` is the reference implementation. This crate
//! contains the tile primitives, shanten/agari/score helpers, and the golden
//! action-list replay used by `tests/replay.rs`.

pub mod agari;
pub mod replay;
pub mod rng;
pub mod score;
pub mod shanten;
pub mod tiles;

/// PyO3 binding skeleton. Enable with `--features python`; it is off by default
/// so the crate builds without a Python toolchain.
#[cfg(feature = "python")]
mod python {
    use pyo3::exceptions::PyValueError;
    use pyo3::prelude::*;

    /// Replay a golden JSON document and return the reproduced event stream.
    #[pyfunction]
    fn replay_golden(json: &str) -> PyResult<String> {
        let events = crate::replay::replay_json(json).map_err(PyValueError::new_err)?;
        serde_json::to_string(&events).map_err(|e| PyValueError::new_err(e.to_string()))
    }

    #[pymodule]
    fn suitaku_core(module: &Bound<'_, PyModule>) -> PyResult<()> {
        module.add_function(wrap_pyfunction!(replay_golden, module)?)?;
        Ok(())
    }
}
