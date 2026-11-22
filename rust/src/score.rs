//! Score calculation. Placeholder: port `src/score.js`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Score {
    pub han: u8,
    pub fu: u8,
    pub points: u32,
}

pub fn compute(_han: u8, _fu: u8, _tsumo: bool, _dealer: bool) -> Score {
    todo!("port the JS score implementation")
}
