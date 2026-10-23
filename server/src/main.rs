//! Serves the built client, a small lobby API and the game WebSocket on one port. Every room is
//! its own match on its own 30 Hz loop (a tokio task); each connection gets a reader and a writer
//! task and joins one room. Env: `PORT` (9001), `STATIC_DIR` (`dist`), `LAG_MS` (one-way delay
//! for testing), and quick play's room settings: `MAP` (one map; else the rotation),
//! `SCORE_LIMIT`, `MATCH_SECONDS`, `BOT_SKILL` (`easy`, `normal`, `hard`, or 0 to 1).
//!
//! Lobby API: `GET /api/rooms` lists the public rooms and the maps; `POST /api/rooms` opens one
//! from JSON settings; `POST /api/quick` picks a quick-play room (opening one if none fits);
//! `GET /api/rooms/{code}` looks one up. Each room answers with its info, including the `code`
//! that `/ws?room={code}` joins (`/ws` alone joins quick play).

use std::collections::HashMap;
use std::future::IntoFuture;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, thread};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sim::bot::Nav;
use sim::game::{Game, MAX_PLAYERS};
use sim::map::{MAPS, ROTATION};
use sim::net::{self, ClientMsg, ServerMsg};
use sim::{DT, Map, TICK_HZ, Tuning};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, Instant};
use tower_http::services::{ServeDir, ServeFile};

/// Clients send ~40-byte inputs; anything bigger is hostile.
const MAX_MESSAGE_BYTES: usize = 1024;
/// Most rooms open at once; opening another answers 503.
const MAX_ROOMS: usize = 32;
/// Quick play skips a room with less of its match left than this (s), unless between matches.
const QUICK_MIN_LEFT: u16 = 120;
/// A room with no humans in it for this long closes: public, private.
const IDLE_PUBLIC: Duration = Duration::from_secs(60);
const IDLE_PRIVATE: Duration = Duration::from_secs(600);
/// Room codes: four of these (no 0/O or 1/I lookalikes).
const CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 4;

/// Outgoing bytes, stamped when queued so `LAG_MS` delays every message by the same amount.
type Outbox = mpsc::UnboundedSender<(Instant, Vec<u8>)>;

enum Cmd {
    Join(Outbox, oneshot::Sender<Option<u8>>),
    Msg(u8, ClientMsg),
    Leave(u8),
}

/// How a room plays: its name, whether the lobby lists it, one map or the rotation, and its
/// match and bot settings.
#[derive(Clone, Debug)]
struct Settings {
    name: String,
    public: bool,
    map: Option<usize>,
    score_limit: u16,
    match_seconds: f32,
    bots: bool,
    bot_skill: f32,
}

/// A room as the lobby shows it, refreshed by its loop once a second.
#[derive(Clone, Debug, Serialize)]
struct RoomInfo {
    code: String,
    name: String,
    public: bool,
    map: String,
    humans: usize,
    bots: usize,
    capacity: usize,
    seconds_left: u16,
    ended: bool,
    scores: [u16; 2],
}

struct Room {
    cmds: mpsc::UnboundedSender<Cmd>,
    info: Arc<Mutex<RoomInfo>>,
}

type Rooms = Arc<Mutex<HashMap<String, Room>>>;

#[derive(Clone)]
struct App {
    rooms: Rooms,
    lag: Duration,
    /// Quick play's settings, and the defaults for anything a new room leaves out.
    quick: Arc<Settings>,
    seed: Arc<AtomicU64>,
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT").map_or(9001, |p| p.parse().expect("PORT must be a port number"));
    let lag = Duration::from_millis(env::var("LAG_MS").map_or(0, |v| v.parse().expect("LAG_MS must be milliseconds")));
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1;

    let mut quick = Settings { name: "Quick play".into(), public: true, map: None, score_limit: 25, match_seconds: 600.0, bots: true, bot_skill: 0.5 };
    if let Ok(name) = env::var("MAP") {
        quick.map = Some(Map::index(&name).expect("MAP must name a map in maps/"));
    }
    if let Ok(v) = env::var("SCORE_LIMIT") {
        quick.score_limit = v.parse().expect("SCORE_LIMIT must be a kill count");
    }
    if let Ok(v) = env::var("MATCH_SECONDS") {
        quick.match_seconds = v.parse().expect("MATCH_SECONDS must be seconds");
    }
    if let Ok(v) = env::var("BOT_SKILL") {
        quick.bot_skill = skill(&v).expect("BOT_SKILL must be easy, normal, hard or 0 to 1");
    }
    // Bot nav takes a moment per map: build every map's now, not when a room first loads it.
    thread::spawn(|| (0..MAPS.len()).for_each(|m| _ = Nav::for_map(m)));

    let app = App { rooms: Rooms::default(), lag, quick: Arc::new(quick), seed: Arc::new(AtomicU64::new(seed)) };
    let client = ServeDir::new(&static_dir).fallback(ServeFile::new(format!("{static_dir}/index.html")));
    let router = Router::new()
        .route("/ws", get(upgrade))
        .route("/api/rooms", get(list).post(create))
        .route("/api/rooms/{code}", get(lookup))
        .route("/api/quick", post(quick_play))
        .fallback_service(client)
        .with_state(app);

    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("bind port");
    println!("serving {static_dir}/ and ws://localhost:{port}/ws (LAG_MS={})", lag.as_millis());
    let served = axum::serve(listener, router).into_future().await;
    eprintln!("server stopped: {served:?}");
    std::process::exit(1);
}

/// The lobby's view: public rooms, busiest first, and the maps a room can be pinned to.
#[derive(Serialize)]
struct Lobby {
    rooms: Vec<RoomInfo>,
    maps: Vec<&'static str>,
}

async fn list(State(app): State<App>) -> Json<Lobby> {
    let mut rooms: Vec<RoomInfo> = infos(&app.rooms).into_iter().filter(|r| r.public).collect();
    rooms.sort_by(|a, b| b.humans.cmp(&a.humans).then_with(|| a.code.cmp(&b.code)));
    Json(Lobby { rooms, maps: ROTATION.to_vec() })
}

async fn lookup(Path(code): Path<String>, State(app): State<App>) -> Result<Json<RoomInfo>, StatusCode> {
    let rooms = app.rooms.lock().expect("rooms lock");
    rooms.get(&code.to_uppercase()).map(|r| Json(r.info.lock().expect("info lock").clone())).ok_or(StatusCode::NOT_FOUND)
}

/// A new room's settings as the lobby sends them: anything left out takes quick play's.
#[derive(Deserialize)]
struct NewRoom {
    name: Option<String>,
    public: Option<bool>,
    map: Option<String>,
    score_limit: Option<u16>,
    bots: Option<bool>,
    bot_skill: Option<String>,
}

async fn create(State(app): State<App>, Json(new): Json<NewRoom>) -> Result<Json<RoomInfo>, (StatusCode, &'static str)> {
    let bad = |why| (StatusCode::BAD_REQUEST, why);
    let mut settings = Settings { name: "Private game".into(), public: false, map: None, ..(*app.quick).clone() };
    if let Some(name) = new.name.as_deref().map(callsign).filter(|n| !n.is_empty()) {
        settings.name = name;
    }
    settings.public = new.public.unwrap_or(false);
    if let Some(map) = new.map.filter(|m| !m.is_empty()) {
        settings.map = Some(Map::index(&map).ok_or(bad("no such map"))?);
    }
    if let Some(limit) = new.score_limit {
        settings.score_limit = (5..=100).contains(&limit).then_some(limit).ok_or(bad("score limit must be 5 to 100"))?;
    }
    settings.bots = new.bots.unwrap_or(true);
    if let Some(level) = new.bot_skill {
        settings.bot_skill = skill(&level).ok_or(bad("bot skill must be easy, normal or hard"))?;
    }
    let mut rooms = app.rooms.lock().expect("rooms lock");
    let code = open(&app, &mut rooms, settings).ok_or((StatusCode::SERVICE_UNAVAILABLE, "too many rooms open"))?;
    Ok(Json(rooms[&code].info.lock().expect("info lock").clone()))
}

async fn quick_play(State(app): State<App>) -> Result<Json<RoomInfo>, (StatusCode, &'static str)> {
    let mut rooms = app.rooms.lock().expect("rooms lock");
    let code = quick_room(&app, &mut rooms).ok_or((StatusCode::SERVICE_UNAVAILABLE, "too many rooms open"))?;
    Ok(Json(rooms[&code].info.lock().expect("info lock").clone()))
}

#[derive(Deserialize)]
struct Join {
    room: Option<String>,
}

async fn upgrade(ws: WebSocketUpgrade, Query(join): Query<Join>, State(app): State<App>) -> Response {
    let cmds = {
        let mut rooms = app.rooms.lock().expect("rooms lock");
        let code = match join.room {
            Some(code) => Some(code.to_uppercase()).filter(|c| rooms.contains_key(c)),
            None => quick_room(&app, &mut rooms),
        };
        match code {
            Some(code) => rooms[&code].cmds.clone(),
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    let lag = app.lag;
    ws.max_message_size(MAX_MESSAGE_BYTES).max_frame_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| connection(socket, cmds, lag))
}

/// Skill from `easy`, `normal`, `hard`, or a number from 0 to 1.
fn skill(level: &str) -> Option<f32> {
    match level {
        "easy" => Some(0.25),
        "normal" => Some(0.5),
        "hard" => Some(0.75),
        _ => level.parse::<f32>().ok().filter(|s| (0.0..=1.0).contains(s)),
    }
}

/// A room name as typed, cleaned: no control characters, at most 24 characters, trimmed.
fn callsign(raw: &str) -> String {
    raw.trim().chars().filter(|c| !c.is_control()).take(24).collect::<String>().trim().to_string()
}

fn infos(rooms: &Rooms) -> Vec<RoomInfo> {
    rooms.lock().expect("rooms lock").values().map(|r| r.info.lock().expect("info lock").clone()).collect()
}

/// The code of the room quick play joins: the public one with the most humans that has space
/// for one more and enough of its match left (or is between matches), else a new one.
fn quick_room(app: &App, rooms: &mut HashMap<String, Room>) -> Option<String> {
    let open_rooms: Vec<RoomInfo> = rooms.values().map(|r| r.info.lock().expect("info lock").clone()).collect();
    match pick_quick(&open_rooms) {
        Some(code) => Some(code.to_string()),
        None => open(app, rooms, (*app.quick).clone()),
    }
}

fn pick_quick(rooms: &[RoomInfo]) -> Option<&str> {
    rooms
        .iter()
        .filter(|r| r.public && r.humans < r.capacity && (r.ended || r.seconds_left >= QUICK_MIN_LEFT))
        .max_by(|a, b| a.humans.cmp(&b.humans).then_with(|| b.code.cmp(&a.code)))
        .map(|r| r.code.as_str())
}

/// A fresh room code, not one in use: CODE_LEN characters from CODE_CHARS.
fn new_code(seed: &AtomicU64, taken: &HashMap<String, Room>) -> String {
    loop {
        let mut x = seed.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
        let code: String = (0..CODE_LEN)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                CODE_CHARS[(x % CODE_CHARS.len() as u64) as usize] as char
            })
            .collect();
        if !taken.contains_key(&code) {
            return code;
        }
    }
}

/// Opens a room with `settings` on its own loop and returns its code; None when MAX_ROOMS are
/// open. The room removes itself once it has sat empty long enough, or if its loop dies.
fn open(app: &App, rooms: &mut HashMap<String, Room>, settings: Settings) -> Option<String> {
    if rooms.len() >= MAX_ROOMS {
        return None;
    }
    let code = new_code(&app.seed, rooms);
    let seed = app.seed.fetch_add(1, Ordering::Relaxed);
    let game = new_game(&settings, seed);
    let info = Arc::new(Mutex::new(describe(&code, &settings, &game)));
    let (cmds, cmd_rx) = mpsc::unbounded_channel();
    rooms.insert(code.clone(), Room { cmds, info: info.clone() });
    println!("room {code} opened: {} ({})", settings.name, if settings.public { "public" } else { "private" });
    let idle = if settings.public { IDLE_PUBLIC } else { IDLE_PRIVATE };
    let task = tokio::spawn(room_loop(game, cmd_rx, info, idle, settings));
    let (rooms, closing) = (app.rooms.clone(), code.clone());
    tokio::spawn(async move {
        if let Err(e) = task.await {
            eprintln!("room {closing} crashed: {e}");
        }
        rooms.lock().expect("rooms lock").remove(&closing);
        println!("room {closing} closed");
    });
    Some(code)
}

fn new_game(settings: &Settings, seed: u64) -> Game {
    let (map, rotation) = match settings.map {
        Some(map) => (map, Vec::new()),
        None => {
            let rotation: Vec<usize> = ROTATION.iter().map(|name| Map::index(name).expect("rotation names a map")).collect();
            (rotation[(seed % rotation.len() as u64) as usize], rotation)
        }
    };
    let mut game = Game::new(Tuning::default(), map);
    game.rotate(rotation, seed);
    (game.score_limit, game.match_seconds, game.bots, game.bot_skill) = (settings.score_limit, settings.match_seconds, settings.bots, settings.bot_skill);
    game
}

fn describe(code: &str, settings: &Settings, game: &Game) -> RoomInfo {
    let (state, (humans, bots)) = (game.match_state(), game.headcount());
    RoomInfo {
        code: code.into(),
        name: settings.name.clone(),
        public: settings.public,
        map: MAPS[usize::from(state.map)].0.into(),
        humans,
        bots,
        capacity: MAX_PLAYERS,
        seconds_left: state.seconds_left,
        ended: state.ended,
        scores: state.scores,
    }
}

/// One room's match: applies its players' messages each tick, steps the game and sends everyone
/// their snapshot. Returns once nobody has been in it for `idle`.
async fn room_loop(mut game: Game, mut cmds: mpsc::UnboundedReceiver<Cmd>, info: Arc<Mutex<RoomInfo>>, idle: Duration, settings: Settings) {
    let code = info.lock().expect("info lock").code.clone();
    let mut outboxes: Vec<(u8, Outbox)> = Vec::new();
    let mut roster_sent = u32::MAX;
    let mut empty_since = Some(Instant::now());
    let mut interval = time::interval(Duration::from_secs_f32(DT));
    loop {
        interval.tick().await;
        while let Ok(cmd) = cmds.try_recv() {
            match cmd {
                Cmd::Join(out, reply) => {
                    let id = game.join().inspect(|&id| game.dock(id));
                    let msg = id.map_or(ServerMsg::Full, |id| ServerMsg::Welcome { id, map: game.map as u8 });
                    let _ = out.send((Instant::now(), net::encode(&msg)));
                    if let Some(id) = id {
                        println!("room {code}: player {id} joined");
                        outboxes.push((id, out));
                    }
                    let _ = reply.send(id);
                }
                Cmd::Msg(id, ClientMsg::Input(msg)) => game.push_input(id, msg),
                Cmd::Msg(id, ClientMsg::Pick(class, loadout)) => game.pick(id, class, loadout),
                Cmd::Msg(id, ClientMsg::Name(name)) => game.set_name(id, &name),
                Cmd::Leave(id) => {
                    println!("room {code}: player {id} left");
                    game.leave(id);
                    outboxes.retain(|(i, _)| *i != id);
                }
            }
        }
        // Empty long enough: close. (An empty game holds still, so it costs nothing meanwhile.)
        match (outboxes.is_empty(), empty_since) {
            (true, Some(since)) if since.elapsed() >= idle => return,
            (true, None) => empty_since = Some(Instant::now()),
            (false, _) => empty_since = None,
            _ => {}
        }
        game.step();
        let now = Instant::now();
        if game.roster_version() != roster_sent {
            roster_sent = game.roster_version();
            let roster = net::encode(&ServerMsg::Roster(game.roster()));
            for (_, out) in &outboxes {
                let _ = out.send((now, roster.clone()));
            }
        }
        for (id, out) in &outboxes {
            let _ = out.send((now, net::encode(&ServerMsg::Snapshot(game.snapshot(*id)))));
        }
        if game.tick % TICK_HZ as u32 == 0 {
            *info.lock().expect("info lock") = describe(&code, &settings, &game);
        }
    }
}

async fn connection(socket: WebSocket, cmds: mpsc::UnboundedSender<Cmd>, lag: Duration) {
    let (mut sink, mut source) = socket.split();

    let (out, mut outbox) = mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
    let writer = tokio::spawn(async move {
        while let Some((queued, bytes)) = outbox.recv().await {
            time::sleep_until(queued + lag).await;
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let (reply, id) = oneshot::channel();
    if cmds.send(Cmd::Join(out, reply)).is_err() {
        return;
    }
    let Ok(Some(id)) = id.await else {
        // Full: the room queued `Full` and dropped the outbox, so the writer sends it and closes.
        let _ = writer.await;
        return;
    };

    // Inputs pass through their own delay task so LAG_MS never stalls reading.
    let (delay, mut delayed) = mpsc::unbounded_channel::<(Instant, ClientMsg)>();
    let forward = cmds.clone();
    let forwarder = tokio::spawn(async move {
        while let Some((arrived, msg)) = delayed.recv().await {
            time::sleep_until(arrived + lag).await;
            if forward.send(Cmd::Msg(id, msg)).is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = source.next().await {
        if let Message::Binary(bytes) = msg
            && let Some(msg) = net::decode::<ClientMsg>(&bytes)
        {
            let _ = delay.send((Instant::now(), msg));
        }
    }
    let _ = cmds.send(Cmd::Leave(id));
    forwarder.abort();
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(code: &str, public: bool, humans: usize, seconds_left: u16, ended: bool) -> RoomInfo {
        RoomInfo { code: code.into(), name: String::new(), public, map: String::new(), humans, bots: 0, capacity: MAX_PLAYERS, seconds_left, ended, scores: [0; 2] }
    }

    #[test]
    fn quick_play_joins_the_busiest_room_with_space_and_time() {
        let rooms = [
            room("AAAA", true, 2, 400, false),
            room("BBBB", true, 5, 400, false),
            room("CCCC", true, 8, 400, false),  // full
            room("DDDD", false, 6, 400, false), // private
            room("EEEE", true, 7, 60, false),   // about to end
            room("FFFF", true, 6, 0, true),     // between matches: fine
        ];
        assert_eq!(pick_quick(&rooms), Some("FFFF"));
        assert_eq!(pick_quick(&rooms[..2]), Some("BBBB"));
        assert_eq!(pick_quick(&rooms[2..5]), None);
    }

    #[test]
    fn room_codes_are_short_readable_and_unused() {
        let seed = AtomicU64::new(7);
        let mut taken = HashMap::new();
        for _ in 0..200 {
            let code = new_code(&seed, &taken);
            assert_eq!(code.len(), CODE_LEN);
            assert!(code.bytes().all(|c| CODE_CHARS.contains(&c)), "{code}");
            let (cmds, _) = mpsc::unbounded_channel();
            assert!(taken.insert(code, Room { cmds, info: Arc::new(Mutex::new(room("", true, 0, 0, false))) }).is_none(), "a code came up twice");
        }
    }

    #[test]
    fn settings_parse_and_clean() {
        assert_eq!((skill("easy"), skill("hard"), skill("0.9"), skill("2"), skill("sharp")), (Some(0.25), Some(0.75), Some(0.9), None, None));
        assert_eq!(callsign("  Friday\n night fights, all welcome!!  "), "Friday night fights, all");
    }
}
