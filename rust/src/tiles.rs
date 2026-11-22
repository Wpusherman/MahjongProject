//! Tile identifiers: `id = type * 4 + copy`, type 0..33.

pub const TYPES: usize = 34;
pub const COPIES_PER_TYPE: u8 = 4;
pub const WALL_SIZE: usize = 136;
/// Physical ids of the red fives (5m, 5p, 5s copy 0).
pub const RED_FIVES: [u8; 3] = [16, 52, 88];
/// Terminals and honors (1m,9m,1p,9p,1s,9s,E,S,W,N,Haku,Hatsu,Chun).
pub const YAOCHU_TYPES: [usize; 13] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

pub fn is_yaochu(t: u8) -> bool {
    YAOCHU_TYPES.contains(&(t as usize))
}

pub fn is_simple(t: u8) -> bool {
    t < 27 && t % 9 != 0 && t % 9 != 8
}

pub fn tile_type(id: u8) -> u8 {
    id / COPIES_PER_TYPE
}

pub fn is_red(id: u8) -> bool {
    RED_FIVES.contains(&id)
}

pub fn valid_wall(wall: &[u8]) -> bool {
    if wall.len() != WALL_SIZE {
        return false;
    }
    let mut seen = [false; WALL_SIZE];
    for &id in wall {
        let index = id as usize;
        if index >= WALL_SIZE || seen[index] {
            return false;
        }
        seen[index] = true;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_of_all_ids_is_valid() {
        let wall: Vec<u8> = (0..WALL_SIZE as u8).collect();
        assert!(valid_wall(&wall));
    }

    #[test]
    fn duplicate_or_short_wall_is_rejected() {
        let mut wall: Vec<u8> = (0..WALL_SIZE as u8).collect();
        wall[135] = wall[0];
        assert!(!valid_wall(&wall));
        assert!(!valid_wall(&wall[..135]));
    }

    #[test]
    fn red_fives_are_the_copy_zero_of_five() {
        assert!(is_red(16));
        assert!(is_red(52));
        assert!(is_red(88));
        assert!(!is_red(17));
        assert_eq!(tile_type(16), 4);
        assert_eq!(tile_type(135), 33);
    }
}
