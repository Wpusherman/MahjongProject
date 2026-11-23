//! Golden action-list game-progression replay.
//!
//! The reference game loop lives in `src/core.js` / `src/game.js`. This module
//! consumes a golden file's recorded `decisions` and `actions` and rebuilds the
//! event stream with its own state. The golden `events` array is never used to
//! drive the replay; it is only compared by `tests/replay.rs`.
//!
//! Scope note: yaku/scoring are intentionally not reimplemented here (they are
//! covered by the shanten/agari/score golden tests). Progression identity is
//! fully derived from the decision/action stream: who draws, which tile, which
//! calls are offered, who calls, riichi timing, kan/dora order, and the terminal
//! winner/loser/tsumo/winTile. The terminal score *amounts* of a win are taken
//! from the golden result's `score.payments` payload (with `finalScores` as a
//! fallback); tenpai draw payments and riichi sticks are computed here.

#![allow(dead_code)]

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agari;
use crate::rng;
use crate::tiles;

const LIVE_WALL_LEN: usize = 122;

fn d_round_wind() -> u8 {
    27
}
fn d_scores() -> [i64; 4] {
    [25000; 4]
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "d_round_wind", rename = "roundWind")]
    pub round_wind: u8,
    #[serde(default)]
    pub dealer: Option<u8>,
    #[serde(default, rename = "startDealer")]
    pub start_dealer: Option<u8>,
    #[serde(default)]
    pub honba: i64,
    #[serde(default, rename = "riichiSticks")]
    pub riichi_sticks: i64,
    #[serde(default = "d_scores")]
    pub scores: [i64; 4],
}

/// One pending decision (`core.current()` in JS), with its full legal list.
#[derive(Debug, Clone, Deserialize)]
pub struct Decision {
    pub seat: u8,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub legal: Vec<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Action {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(rename = "tileId", default)]
    pub tile_id: Option<u8>,
    #[serde(default)]
    pub riichi: Option<bool>,
    #[serde(default)]
    pub tile: Option<u8>,
    #[serde(default)]
    pub tiles: Option<Vec<u8>>,
    #[serde(default)]
    pub kan: Option<KanChoice>,
    #[serde(default)]
    pub analysis: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KanChoice {
    pub kind: String,
    pub tile: u8,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GoldenFile {
    pub seed: Value,
    pub config: Config,
    #[serde(default)]
    pub wall: Option<Vec<u8>>,
    #[serde(default, rename = "initialHands")]
    pub initial_hands: Option<Vec<Vec<u8>>>,
    #[serde(default)]
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub events: Option<Vec<Value>>,
    #[serde(default, rename = "finalScores")]
    pub final_scores: Option<Vec<i64>>,
    #[serde(default)]
    pub result: Option<Value>,
}

#[derive(Clone, Default)]
struct Player {
    hand: Vec<u8>,
    melds: Vec<Value>,
    discards: Vec<u8>,
    river: Vec<Value>,
    discard_history: Vec<Value>,
    score: i64,
    riichi: bool,
    double_riichi: bool,
    ippatsu: bool,
    temp_furiten: bool,
    riichi_furiten: bool,
    drawn_tile: Option<u8>,
    draw_count: u32,
    riichi_turn: i64,
}

#[derive(Clone)]
struct Claim {
    seat: u8,
    action: Action,
    dist: usize,
}

struct GameState {
    players: Vec<Player>,
    wall: Vec<u8>,
    live_wall: Vec<u8>,
    dead_wall: Vec<u8>,
    wall_index: usize,
    live_end: usize,
    rinshan_index: usize,
    dora_revealed: usize,
    dora_indicators: Vec<u8>,
    ura_indicators: Vec<u8>,
    turn_count: i64,
    any_call: bool,
    dealer: u8,
    honba: i64,
    riichi_sticks: i64,
    ended: bool,
    events: Vec<Value>,
    decisions: Vec<Decision>,
    actions: Vec<Action>,
    cursor: usize,
    start_scores: [i64; 4],
    initial_hands: Option<Vec<Vec<u8>>>,
    golden_result: Option<Value>,
    final_scores: Option<Vec<i64>>,
    final_result: Option<Value>,
}

fn take_ids(hand: &mut Vec<u8>, tile_type: u8, n: usize) -> Vec<u8> {
    let mut ids: Vec<u8> = hand
        .iter()
        .copied()
        .filter(|&id| id >> 2 == tile_type)
        .collect();
    // `takeIds` sorts non-red copies before red copies, then takes the first n.
    ids.sort_by_key(|&id| u8::from(tiles::is_red(id)));
    ids.truncate(n);
    for id in &ids {
        if let Some(pos) = hand.iter().position(|x| x == id) {
            hand.remove(pos);
        }
    }
    ids
}

fn options_from_decision(dec: &Decision, tile_id: u8, from: u8) -> Value {
    let tile_type = tiles::tile_type(tile_id);
    let mut ron = false;
    let mut pon = Value::Null;
    let mut kan = Value::Null;
    let mut chi: Vec<Value> = Vec::new();
    for legal in &dec.legal {
        match legal.get("type").and_then(Value::as_str) {
            Some("ron") => ron = true,
            Some("pon") => {
                if let Some(v) = legal.get("tile") {
                    pon = v.clone();
                }
            }
            Some("kan") => {
                if let Some(v) = legal.get("tile") {
                    kan = v.clone();
                }
            }
            Some("chi") => {
                if let Some(v) = legal.get("tiles") {
                    chi.push(v.clone());
                }
            }
            _ => {}
        }
    }
    json!({"tile": tile_type, "from": from, "ron": ron, "pon": pon, "kan": kan, "chi": chi})
}

fn normalized_call_action(action: &Action) -> Value {
    match action.kind.as_str() {
        "" | "pass" => Value::Null,
        "ron" => json!({"type": "ron"}),
        "chi" => json!({
            "type": "chi",
            "tile": action.tile.unwrap_or(0),
            "tiles": action.tiles.clone().unwrap_or_default()
        }),
        other => json!({"type": other, "tile": action.tile.unwrap_or(0)}),
    }
}

fn claim_rank(action: &Action) -> u8 {
    match action.kind.as_str() {
        "ron" => 3,
        "chi" => 1,
        _ => 2,
    }
}

impl GameState {
    fn new(golden: &GoldenFile) -> Result<Self, String> {
        let regenerated = rng::wall_from_seed(&golden.seed);
        let wall = match &golden.wall {
            Some(w) => {
                if w != &regenerated {
                    return Err(format!(
                        "seed {}: golden wall does not match the mulberry32 regeneration",
                        golden.seed
                    ));
                }
                w.clone()
            }
            None => regenerated,
        };
        if !tiles::valid_wall(&wall) {
            return Err(format!("seed {}: invalid wall", golden.seed));
        }
        let dealer = golden.config.dealer.or(golden.config.start_dealer).unwrap_or(0) & 3;
        if let Some(start) = golden.config.start_dealer {
            if start > 3 {
                return Err(format!("seed {}: invalid startDealer", golden.seed));
            }
        }
        Ok(GameState {
            players: vec![Player::default(); 4],
            wall,
            live_wall: Vec::new(),
            dead_wall: Vec::new(),
            wall_index: 0,
            live_end: LIVE_WALL_LEN,
            rinshan_index: 0,
            dora_revealed: 1,
            dora_indicators: Vec::new(),
            ura_indicators: Vec::new(),
            turn_count: 0,
            any_call: false,
            dealer,
            honba: golden.config.honba,
            riichi_sticks: golden.config.riichi_sticks,
            ended: false,
            events: Vec::new(),
            decisions: golden.decisions.clone(),
            actions: golden.actions.clone(),
            cursor: 0,
            start_scores: golden.config.scores,
            initial_hands: golden.initial_hands.clone(),
            golden_result: golden.result.clone(),
            final_scores: golden.final_scores.clone(),
            final_result: None,
        })
    }

    fn record(&mut self, kind: &str, data: Value) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("index".into(), json!(self.events.len()));
        map.insert("type".into(), json!(kind));
        map.insert("turn".into(), json!(self.turn_count));
        if let Value::Object(fields) = data {
            for (key, value) in fields {
                map.insert(key, value);
            }
        }
        let event = Value::Object(map);
        self.events.push(event.clone());
        event
    }

    fn setup(&mut self) -> Result<(), String> {
        if self.decisions.len() != self.actions.len() {
            return Err(format!(
                "decision/action length mismatch: {} vs {}",
                self.decisions.len(),
                self.actions.len()
            ));
        }
        for (seat, player) in self.players.iter_mut().enumerate() {
            player.score = self.start_scores[seat];
        }
        self.live_wall = self.wall[..LIVE_WALL_LEN].to_vec();
        self.dead_wall = self.wall[LIVE_WALL_LEN..].to_vec();
        self.wall_index = 0;
        self.live_end = LIVE_WALL_LEN;
        self.rinshan_index = 0;
        self.dora_revealed = 1;

        // Four tiles at a time starting with the dealer; the wall is fixed first.
        let dealer = self.dealer as usize;
        for _batch in 0..3 {
            for i in 0..4 {
                let seat = (dealer + i) % 4;
                for _k in 0..4 {
                    let id = self.live_wall[self.wall_index];
                    self.wall_index += 1;
                    self.players[seat].hand.push(id);
                }
            }
        }
        for i in 0..4 {
            let seat = (dealer + i) % 4;
            let id = self.live_wall[self.wall_index];
            self.wall_index += 1;
            self.players[seat].hand.push(id);
        }
        for player in self.players.iter_mut() {
            player.hand.sort_unstable();
        }
        self.sync_dora();

        if let Some(expected) = &self.initial_hands {
            for seat in 0..4 {
                if expected.get(seat) != Some(&self.players[seat].hand) {
                    return Err(format!(
                        "seat {seat}: dealt hand does not match recorded initialHands"
                    ));
                }
            }
        }

        let scores: Vec<i64> = self.start_scores.to_vec();
        let dora = self.dora_indicators.clone();
        self.record(
            "start",
            json!({"scores": scores, "doraIndicators": dora}),
        );
        Ok(())
    }

    fn sync_dora(&mut self) {
        self.dora_indicators = (0..self.dora_revealed)
            .map(|i| self.dead_wall[4 + i * 2])
            .collect();
        self.ura_indicators = (0..self.dora_revealed)
            .map(|i| self.dead_wall[5 + i * 2])
            .collect();
    }

    fn live_remaining(&self) -> usize {
        self.live_end.saturating_sub(self.wall_index)
    }

    fn draw_tile(&mut self) -> Result<u8, String> {
        if self.live_remaining() == 0 {
            return Err("no live tile left".into());
        }
        let id = self.live_wall[self.wall_index];
        self.wall_index += 1;
        Ok(id)
    }

    fn draw_rinshan(&mut self) -> Result<u8, String> {
        if self.rinshan_index >= 4 || self.live_remaining() == 0 {
            return Err("no rinshan tile left".into());
        }
        self.live_end -= 1; // the last live tile replenishes the dead wall
        let id = self.dead_wall[self.rinshan_index];
        self.rinshan_index += 1;
        Ok(id)
    }

    fn waits(&self, seat: usize) -> Vec<u8> {
        let player = &self.players[seat];
        let mut counts = [0u8; 34];
        for &id in &player.hand {
            counts[(id >> 2) as usize] += 1;
        }
        let mut owned = [0u8; 34];
        for meld in &player.melds {
            if let Some(array) = meld.get("tiles").and_then(Value::as_array) {
                for tile in array {
                    if let Some(id) = tile.as_u64() {
                        owned[((id as u8) >> 2) as usize] += 1;
                    }
                }
            }
        }
        let meld_count = player.melds.len() as u8;
        let mut out = Vec::new();
        for t in 0..34u8 {
            let index = t as usize;
            if counts[index] as usize + owned[index] as usize >= 4 {
                continue;
            }
            counts[index] += 1;
            if agari::is_agari(&counts, meld_count) {
                out.push(t);
            }
            counts[index] -= 1;
        }
        out
    }

    fn declare_riichi(&mut self, seat: usize) {
        let any_call = self.any_call;
        let turn = self.turn_count;
        let double;
        {
            let player = &mut self.players[seat];
            player.riichi = true;
            player.double_riichi = player.discard_history.len() == 1 && !any_call;
            player.ippatsu = true;
            player.riichi_turn = turn;
            player.score -= 1000;
            double = player.double_riichi;
        }
        self.riichi_sticks += 1;
        self.record("riichi", json!({"seat": seat, "doubleRiichi": double}));
    }

    fn discard(
        &mut self,
        seat: usize,
        tile_id: u8,
        riichi: bool,
        analysis: Option<Value>,
    ) -> Result<(), String> {
        let turn = self.turn_count;
        let tsumogiri;
        {
            let player = &mut self.players[seat];
            let index = player
                .hand
                .iter()
                .position(|&id| id == tile_id)
                .ok_or_else(|| format!("discard {tile_id} is not in seat {seat}'s hand"))?;
            tsumogiri = player.drawn_tile == Some(tile_id);
            player.hand.remove(index);
            player.discards.push(tile_id);
            let drawn = json!({
                "tileId": tile_id,
                "tsumogiri": tsumogiri,
                "riichi": riichi,
                "called": false,
                "turn": turn
            });
            player.river.push(drawn.clone());
            player.discard_history.push(drawn);
            player.drawn_tile = None;
            player.hand.sort_unstable();
        }
        let analysis = analysis.unwrap_or(Value::Null);
        self.record(
            "discard",
            json!({
                "seat": seat,
                "tileId": tile_id,
                "tsumogiri": tsumogiri,
                "riichi": riichi,
                "called": false,
                "analysis": analysis
            }),
        );
        Ok(())
    }

    fn apply_call(
        &mut self,
        seat: u8,
        action: &Action,
        from: u8,
        tile_id: u8,
    ) -> Result<(), String> {
        self.any_call = true;
        for player in self.players.iter_mut() {
            player.ippatsu = false;
        }
        {
            let source = &mut self.players[from as usize];
            source.discards.pop();
            source.river.pop();
        }
        let tile_type = tiles::tile_type(tile_id);
        let (kind, meld_type, ids) = {
            let player = &mut self.players[seat as usize];
            player.drawn_tile = None;
            match action.kind.as_str() {
                "chi" => {
                    let seq = action.tiles.clone().ok_or("chi action without tiles")?;
                    let mut ids = Vec::new();
                    for t in &seq {
                        ids.extend(take_ids(&mut player.hand, *t, 1));
                    }
                    let mut meld_type = tile_type;
                    for t in &seq {
                        meld_type = meld_type.min(*t);
                    }
                    ("seq", meld_type, ids)
                }
                "kan" => ("kan", tile_type, take_ids(&mut player.hand, tile_type, 3)),
                _ => ("trip", tile_type, take_ids(&mut player.hand, tile_type, 2)),
            }
        };
        let mut meld_tiles = vec![tile_id];
        meld_tiles.extend(ids);
        let meld = json!({
            "kind": kind,
            "type": meld_type,
            "open": true,
            "tiles": meld_tiles,
            "from": from,
            "calledTile": tile_id
        });
        {
            let player = &mut self.players[seat as usize];
            player.melds.push(meld.clone());
            player.hand.sort_unstable();
        }
        let normalized = if action.kind == "chi" {
            json!({
                "type": "chi",
                "tile": tile_type,
                "tiles": action.tiles.clone().unwrap_or_default()
            })
        } else {
            json!({"type": action.kind, "tile": tile_type})
        };
        self.record(
            "call",
            json!({"seat": seat, "from": from, "action": normalized, "meld": meld}),
        );
        Ok(())
    }

    fn apply_kan(&mut self, seat: usize, kan: &KanChoice) -> Result<(), String> {
        self.any_call = true;
        for player in self.players.iter_mut() {
            player.ippatsu = false;
        }
        {
            let player = &mut self.players[seat];
            if kan.kind == "ankan" {
                let ids = take_ids(&mut player.hand, kan.tile, 4);
                player.melds.push(json!({
                    "kind": "kan",
                    "type": kan.tile,
                    "open": false,
                    "tiles": ids
                }));
            } else {
                let position = player
                    .melds
                    .iter()
                    .position(|m| {
                        m.get("kind").and_then(Value::as_str) == Some("trip")
                            && m.get("type").and_then(Value::as_u64) == Some(kan.tile as u64)
                    })
                    .ok_or("kakan without a matching triplet")?;
                let added = take_ids(&mut player.hand, kan.tile, 1)
                    .first()
                    .copied()
                    .ok_or("kakan without an added tile")?;
                if let Value::Object(fields) = &mut player.melds[position] {
                    fields.insert("kind".into(), json!("kan"));
                    fields.insert("addedTile".into(), json!(added));
                    if let Some(Value::Array(list)) = fields.get_mut("tiles") {
                        list.push(json!(added));
                    }
                }
            }
            player.hand.sort_unstable();
        }
        let melds = self.players[seat].melds.clone();
        let action = json!({"kind": kan.kind, "tile": kan.tile});
        self.record("kan", json!({"seat": seat, "action": action, "melds": melds}));
        Ok(())
    }

    fn reveal_kan_dora(&mut self) {
        if self.dora_revealed < 5 {
            self.dora_revealed += 1;
            self.sync_dora();
            let dora = self.dora_indicators.clone();
            self.record("dora", json!({"doraIndicators": dora}));
        }
    }

    fn peek(&self) -> Option<&Decision> {
        self.decisions.get(self.cursor)
    }

    fn peek_is(&self, kind: &str, seat: usize) -> bool {
        self.peek()
            .map_or(false, |d| d.kind == kind && d.seat as usize == seat)
    }

    fn take_pair(&mut self) -> Result<(Decision, Action), String> {
        if self.cursor >= self.decisions.len() {
            return Err("the decision stream ended early".into());
        }
        let decision = self.decisions[self.cursor].clone();
        let action = self.actions.get(self.cursor).cloned().unwrap_or_default();
        self.cursor += 1;
        Ok((decision, action))
    }

    fn check_calls(
        &mut self,
        from: u8,
        tile_id: u8,
        rob_kan: Option<&str>,
    ) -> Result<Option<Claim>, String> {
        let mut claims: Vec<Claim> = Vec::new();
        for dist in 1..4usize {
            let seat = ((from as usize + dist) % 4) as u8;
            let asked = self
                .peek()
                .map_or(false, |d| d.kind == "call" && d.seat == seat);
            if !asked {
                continue;
            }
            let (decision, action) = self.take_pair()?;
            let opts = options_from_decision(&decision, tile_id, from);
            let ron_offered = opts.get("ron").and_then(Value::as_bool).unwrap_or(false);
            let pon_offered = !opts.get("pon").map_or(true, Value::is_null);
            let kan_offered = !opts.get("kan").map_or(true, Value::is_null);
            let chi_legal = action
                .tiles
                .as_ref()
                .map(|pair| {
                    let want = json!(pair);
                    opts.get("chi")
                        .and_then(Value::as_array)
                        .map_or(false, |list| list.contains(&want))
                })
                .unwrap_or(false);
            let action_now = normalized_call_action(&action);
            let rob = rob_kan
                .map(|k| Value::String(k.to_string()))
                .unwrap_or(Value::Null);
            self.record(
                "response",
                json!({
                    "seat": seat,
                    "from": from,
                    "tileId": tile_id,
                    "robKan": rob,
                    "action": action_now,
                    "options": opts,
                    "analysis": Value::Null
                }),
            );
            if ron_offered && action.kind != "ron" {
                let player = &mut self.players[seat as usize];
                player.temp_furiten = true;
                if player.riichi {
                    player.riichi_furiten = true;
                }
            }
            if !action.kind.is_empty() && action.kind != "pass" {
                let valid = match action.kind.as_str() {
                    "ron" => ron_offered,
                    "pon" => pon_offered,
                    "kan" => kan_offered,
                    "chi" => chi_legal,
                    _ => false,
                };
                if !valid {
                    return Err(format!("illegal call response: seat {seat} {:?}", action.kind));
                }
                claims.push(Claim {
                    seat,
                    action,
                    dist,
                });
            }
        }
        claims.sort_by(|a, b| {
            claim_rank(&b.action)
                .cmp(&claim_rank(&a.action))
                .then(a.dist.cmp(&b.dist))
        });
        Ok(claims.into_iter().next())
    }

    fn do_win(
        &mut self,
        seat: u8,
        tile_id: u8,
        tsumo: bool,
        loser: Option<u8>,
    ) -> Result<(), String> {
        let payments = self
            .golden_result
            .as_ref()
            .and_then(|r| r.get("score"))
            .and_then(|s| s.get("payments"))
            .cloned();
        let honba = self.honba;
        if let Some(payments) = payments {
            let mut received: i64 = 0;
            for s in 0..4usize {
                if s == seat as usize {
                    continue;
                }
                if !tsumo && Some(s as u8) != loser {
                    continue;
                }
                let base = if !tsumo {
                    payments.get("ron").and_then(Value::as_i64)
                } else if s == self.dealer as usize {
                    payments.get("fromDealer").and_then(Value::as_i64)
                } else if seat as usize == self.dealer as usize {
                    payments.get("each").and_then(Value::as_i64)
                } else {
                    payments.get("fromOthers").and_then(Value::as_i64)
                };
                let base = base.ok_or("win result is missing payment fields")?;
                let amount = base + honba * if tsumo { 100 } else { 300 };
                self.players[s].score -= amount;
                received += amount;
            }
            let sticks = self.riichi_sticks;
            self.players[seat as usize].score += received + sticks * 1000;
        } else if let Some(final_scores) = self.final_scores.clone() {
            for (seat, player) in self.players.iter_mut().enumerate() {
                if let Some(score) = final_scores.get(seat) {
                    player.score = *score;
                }
            }
        } else {
            return Err("a win needs score.payments or finalScores".into());
        }
        self.riichi_sticks = 0;
        let result = json!({
            "type": "win",
            "winner": seat,
            "loser": loser,
            "tsumo": tsumo,
            "winTile": tile_id
        });
        self.finish(result)
    }

    fn do_ryuukyoku(&mut self, reason: &str) -> Result<(), String> {
        let mut tenpai: Vec<u8> = Vec::new();
        if reason == "exhaustive" {
            for seat in 0..4usize {
                if !self.waits(seat).is_empty() {
                    tenpai.push(seat as u8);
                }
            }
            let n = tenpai.len() as i64;
            if n > 0 && n < 4 {
                for seat in 0..4usize {
                    let delta = if tenpai.contains(&(seat as u8)) {
                        3000 / n
                    } else {
                        -(3000 / (4 - n))
                    };
                    self.players[seat].score += delta;
                }
            }
        }
        let result = json!({"type": "draw", "tenpai": tenpai, "reason": reason});
        self.finish(result)
    }

    fn finish(&mut self, result: Value) -> Result<(), String> {
        self.ended = true;
        self.final_result = Some(result.clone());
        let scores: Vec<i64> = self.players.iter().map(|p| p.score).collect();
        let sticks = self.riichi_sticks;
        self.record(
            "end",
            json!({"result": result, "scores": scores, "riichiSticks": sticks}),
        );
        Ok(())
    }

    fn run(&mut self) -> Result<Vec<Value>, String> {
        self.setup()?;
        let mut current = self.dealer as usize;
        let mut draw_kind = "live";

        while !self.ended {
            let rinshan = draw_kind == "rinshan";
            if draw_kind != "none" {
                if self.live_remaining() == 0 {
                    self.do_ryuukyoku("exhaustive")?;
                    break;
                }
                let tile = if rinshan {
                    self.draw_rinshan()?
                } else {
                    self.draw_tile()?
                };
                {
                    let player = &mut self.players[current];
                    player.hand.push(tile);
                    player.drawn_tile = Some(tile);
                    player.draw_count += 1;
                    player.temp_furiten = false;
                }
                if rinshan {
                    self.reveal_kan_dora();
                }
                let remaining = self.live_remaining();
                self.record(
                    "draw",
                    json!({
                        "seat": current,
                        "tileId": tile,
                        "rinshan": rinshan,
                        "liveRemaining": remaining
                    }),
                );

                if self.peek_is("tsumo", current) {
                    let (_decision, action) = self.take_pair()?;
                    if action.kind == "tsumo" {
                        self.do_win(current as u8, tile, true, None)?;
                        break;
                    }
                }
                if self.peek_is("kan", current) {
                    let (_decision, action) = self.take_pair()?;
                    if !action.kind.is_empty() && action.kind != "pass" {
                        let kan = match &action.kan {
                            Some(kan) => kan.clone(),
                            None => KanChoice {
                                kind: action.kind.clone(),
                                tile: action.tile.ok_or("kan action without a tile")?,
                            },
                        };
                        let tile_id = self.players[current]
                            .hand
                            .iter()
                            .copied()
                            .find(|&id| id >> 2 == kan.tile)
                            .ok_or("no physical tile for the declared kan")?;
                        let claim =
                            self.check_calls(current as u8, tile_id, Some(kan.kind.as_str()))?;
                        if let Some(claim) = &claim {
                            if claim.action.kind == "ron" {
                                self.do_win(claim.seat, tile_id, false, Some(current as u8))?;
                                break;
                            }
                        }
                        self.apply_kan(current, &kan)?;
                        draw_kind = "rinshan";
                        continue;
                    }
                }
            }

            if !self.peek_is("discard", current) {
                return Err(format!(
                    "expected a discard for seat {current} at decision {} (found {:?})",
                    self.cursor,
                    self.peek().map(|d| (d.kind.clone(), d.seat))
                ));
            }
            let (_decision, action) = self.take_pair()?;
            let was_riichi = self.players[current].riichi;
            let tile_id = if was_riichi {
                self.players[current]
                    .drawn_tile
                    .ok_or("riichi discard without a drawn tile")?
            } else {
                action.tile_id.ok_or("discard action without tileId")?
            };
            let riichi = !was_riichi && action.riichi.unwrap_or(false);
            if was_riichi {
                self.players[current].ippatsu = false;
            }
            self.discard(current, tile_id, riichi, action.analysis.clone())?;
            self.turn_count += 1;

            let claim = self.check_calls(current as u8, tile_id, None)?;
            if let Some(claim) = &claim {
                if claim.action.kind == "ron" {
                    self.do_win(claim.seat, tile_id, false, Some(current as u8))?;
                    break;
                }
            }
            if riichi {
                self.declare_riichi(current);
            }
            let kan_owners = self
                .players
                .iter()
                .filter(|p| {
                    p.melds
                        .iter()
                        .any(|m| m.get("kind").and_then(Value::as_str) == Some("kan"))
                })
                .count();
            if self.rinshan_index == 4 && kan_owners > 1 {
                self.do_ryuukyoku("four-kans")?;
                break;
            }
            if self.players.iter().all(|p| p.riichi) {
                self.do_ryuukyoku("four-riichi")?;
                break;
            }
            if !self.any_call && self.players.iter().all(|p| p.discard_history.len() == 1) {
                let types: Vec<u64> = self
                    .players
                    .iter()
                    .map(|p| {
                        p.discard_history[0]
                            .get("tileId")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            >> 2
                    })
                    .collect();
                if (27..=30).contains(&types[0]) && types.iter().all(|&t| t == types[0]) {
                    self.do_ryuukyoku("four-winds")?;
                    break;
                }
            }

            if let Some(claim) = claim {
                let from = current as u8;
                let seat = claim.seat;
                let is_kan = claim.action.kind == "kan";
                self.apply_call(seat, &claim.action, from, tile_id)?;
                current = seat as usize;
                draw_kind = if is_kan { "rinshan" } else { "none" };
            } else {
                current = (current + 1) % 4;
                draw_kind = "live";
            }
        }

        if !self.ended {
            return Err("the replay stopped without a terminal event".into());
        }
        if self.cursor != self.decisions.len() {
            return Err(format!(
                "{} decisions/actions were not consumed",
                self.decisions.len() - self.cursor
            ));
        }
        Ok(std::mem::take(&mut self.events))
    }
}

/// Replay a parsed golden file, returning the reproduced event stream.
pub fn replay(golden: &GoldenFile) -> Result<Vec<Value>, String> {
    let mut state = GameState::new(golden)?;
    state.run()
}

/// Parse and replay a golden JSON document.
pub fn replay_json(text: &str) -> Result<Vec<Value>, String> {
    let golden: GoldenFile =
        serde_json::from_str(text).map_err(|e| format!("failed to parse golden JSON: {e}"))?;
    replay(&golden)
}

/// Terminal result produced by the replay (identity fields only for a win).
pub fn final_result(events: &[Value]) -> Option<&Value> {
    events
        .iter()
        .find(|e| e.get("type").and_then(Value::as_str) == Some("end"))
        .and_then(|e| e.get("result"))
}
