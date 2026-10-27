//! Serves the built client, a small lobby API and the game WebSocket on one port. Every room is
//! its own match on its own 30 Hz loop (a tokio task); each connection gets a reader and a writer
//! task and joins one room. Env: `PORT` (9001), `STATIC_DIR` (`dist`), `LAG_MS` (one-way delay
//! for testing), and quick play's room settings: `MODE` (`tdm`, `dm`, `ma`, `siege`, `ctf`, `convoy` or `defense`; else every versus mode in turn),
//! `MAP` (one map; else the rotation), `SCORE_LIMIT`, `MATCH_SECONDS`, `BOT_SKILL` (`easy`,
//! `normal`, `hard`, or 0 to 1). And
//! `PROGRESS_KEY`, the secret that signs progression records (a dev key stands in without it).
//!
//! Lobby API: `GET /api/rooms` lists the public rooms, the modes and the maps; `POST /api/rooms` opens one
//! from JSON settings; `POST /api/quick` picks a quick-play room (opening one if none fits), or
//! with `{"coop": true}` a co-op one, since co-op is matched on its own;
//! `GET /api/rooms/{code}` looks one up. Each room answers with its info, including the `code`
//! that `/ws?room={code}` joins (`/ws` alone joins quick play). `POST /api/progress` checks a
//! progression record (the body) and answers what it holds, or 400.
//!
//! Progression has no database: the server signs each pilot's record and their browser keeps it.
//! A pilot hands theirs over on joining (none or a bad one makes them a fresh guest); the room
//! counts their match and sends the record back with it added, every few seconds while it's on
//! and in full at its end. The record also says which weapons and items the pilot has unlocked
//! for each mech: the room launches them with those only, and spends their points on more.

use std::collections::HashMap;
use std::future::IntoFuture;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::env;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::serve::ListenerExt;
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sim::game::{Game, MAX_PLAYERS, Mode, STAGING_SECONDS};
use sim::map::{MAPS, ROTATION};
use sim::client::INTERP_TICKS;
use sim::net::{self, ClientMsg, Event, ServerMsg};
use sim::progress::{MatchXp, RECORD_VERSION, Record, Tally};
use sim::{DT, Loadout, Map, TICK_HZ, Tuning};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, Instant};
use tower_http::services::{ServeDir, ServeFile};

/// Clients send ~40-byte inputs, and a progression record of about 1 KB once; anything bigger
/// is hostile.
const MAX_MESSAGE_BYTES: usize = 4096;
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
/// Signs records when the server has no `PROGRESS_KEY`: fine locally, worthless in production.
const DEV_KEY: &[u8] = b"mechwar-dev-key-not-a-secret";
/// While a match is on, a pilot's record goes out this often with their match so far (s), so
/// leaving early loses at most this much.
const CHECKPOINT_SECONDS: u32 = 10;
/// A player whose view runs this many ticks further behind than their link's own round trip is
/// backed up somewhere (Fly's proxy holds what their link can't take yet; the server's socket never
/// backs up): they get only every `TRICKLE`th snapshot until it drains, so they hitch and catch up
/// rather than play back seconds of old state. Over 250 ms, where the client's clock snaps to a
/// fresh snapshot, so the first one through after the drain shows them caught up.
const BEHIND_TICKS: f32 = 8.0;
const TRICKLE: u32 = 10;
/// How fast a player's least lag creeps up, in ticks an input (about half a tick a second), so a
/// route that got slower soon stops counting as behind.
const BASE_DRIFT: f32 = 1.0 / 60.0;

/// Outgoing bytes, stamped when queued so `LAG_MS` delays every message by the same amount.
type Outbox = mpsc::UnboundedSender<(Instant, Vec<u8>)>;

enum Cmd {
    Join(Outbox, oneshot::Sender<Option<u8>>),
    Msg(u8, ClientMsg),
    Leave(u8),
}

/// How a room plays: its name, whether the lobby lists it, one mode or every mode in turn, one
/// map or the rotation, and its match and bot settings.
#[derive(Clone, Debug)]
struct Settings {
    name: String,
    public: bool,
    mode: Option<Mode>,
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
    /// The mode being played (`Mode::key`).
    mode: &'static str,
    map: String,
    humans: usize,
    bots: usize,
    capacity: usize,
    seconds_left: u16,
    ended: bool,
    scores: [u16; 2],
}

/// What a player's inputs say of their link: how many ticks behind the match their view runs (an
/// input's `view_tick` against the room's tick when it's in), the least it's run (the link's own
/// round trip), and the events of the snapshots held back from them meanwhile.
struct Link {
    lag: f32,
    base: f32,
    held: Vec<Event>,
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
    signer: Signer,
}

/// Signs progression records and checks them. A record travels as `base64url(json).base64url(tag)`,
/// the tag its HMAC-SHA256 under the server's key: the browser keeps it but can't change it.
#[derive(Clone)]
struct Signer(Hmac<Sha256>);

impl Signer {
    fn new(key: &[u8]) -> Signer {
        Signer(Hmac::new_from_slice(key).expect("HMAC takes keys of any length"))
    }

    fn mac(&self, payload: &[u8]) -> Hmac<Sha256> {
        let mut mac = self.0.clone();
        mac.update(payload);
        mac
    }

    fn sign(&self, record: &Record) -> String {
        let payload = B64.encode(serde_json::to_vec(record).expect("records serialize"));
        let tag = B64.encode(self.mac(payload.as_bytes()).finalize().into_bytes());
        format!("{payload}.{tag}")
    }

    /// The record `token` holds, if this key signed it and it's a format this server reads.
    fn verify(&self, token: &str) -> Option<Record> {
        let (payload, tag) = token.split_once('.')?;
        self.mac(payload.as_bytes()).verify_slice(&B64.decode(tag).ok()?).ok()?;
        let record: Record = serde_json::from_slice(&B64.decode(payload).ok()?).ok()?;
        (1..=RECORD_VERSION).contains(&record.version).then_some(record)
    }

    /// A new guest's id: a keyed hash of the time and a count, so unguessable and as good as unique.
    fn guest_id(&self) -> u64 {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let seed = [now.to_le_bytes().as_slice(), &COUNT.fetch_add(1, Ordering::Relaxed).to_le_bytes()].concat();
        u64::from_le_bytes(self.mac(&seed).finalize().into_bytes()[..8].try_into().expect("8 bytes"))
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT").map_or(9001, |p| p.parse().expect("PORT must be a port number"));
    let lag = Duration::from_millis(env::var("LAG_MS").map_or(0, |v| v.parse().expect("LAG_MS must be milliseconds")));
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1;
    // The bots' tactical spots, baked at build (see the Dockerfile): made here instead, a map's
    // would stall its room the first time bots fight on it.
    if let Ok(path) = env::var("SPOTS") {
        let bakes = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("SPOTS {path}: {e}"));
        eprintln!("bot spots preloaded for {} of {} maps", sim::tactics::Spots::preload(&bakes), MAPS.len());
    }

    let mut quick = Settings { name: "Quick play".into(), public: true, mode: None, map: None, score_limit: 20, match_seconds: 600.0, bots: true, bot_skill: 0.5 };
    if let Ok(key) = env::var("MODE") {
        quick.mode = Some(Mode::from_key(&key).expect("MODE must be tdm, dm, ma, siege, ctf, convoy or defense"));
    }
    if let Ok(name) = env::var("MAP") {
        quick.map = Some(Map::index(&name).expect("MAP must name a map in maps/"));
    }
    assert!(!deck(&quick).is_empty(), "MAP doesn't play MODE");
    if let Ok(v) = env::var("SCORE_LIMIT") {
        quick.score_limit = v.parse().expect("SCORE_LIMIT must be a kill count");
    }
    if let Ok(v) = env::var("MATCH_SECONDS") {
        quick.match_seconds = v.parse().expect("MATCH_SECONDS must be seconds");
    }
    if let Ok(v) = env::var("BOT_SKILL") {
        quick.bot_skill = skill(&v).expect("BOT_SKILL must be easy, normal, hard or 0 to 1");
    }
    let signer = Signer::new(&env::var("PROGRESS_KEY").ok().filter(|k| !k.is_empty()).map(String::into_bytes).unwrap_or_else(|| {
        eprintln!("warning: no PROGRESS_KEY set, so progression records are signed with the public dev key");
        DEV_KEY.to_vec()
    }));
    let app = App { rooms: Rooms::default(), lag, quick: Arc::new(quick), seed: Arc::new(AtomicU64::new(seed)), signer };
    let client = ServeDir::new(&static_dir).fallback(ServeFile::new(format!("{static_dir}/index.html")));
    // The guide is one page for all its sections and pages (/guide/ itself is ServeDir's guide/index.html).
    let guide = ServeFile::new(format!("{static_dir}/guide/index.html"));
    let router = Router::new()
        .route_service("/guide/{section}", guide.clone())
        .route_service("/guide/{section}/", guide.clone())
        .route_service("/guide/{section}/{page}", guide.clone())
        .route_service("/guide/{section}/{page}/", guide)
        .route("/ws", get(upgrade))
        .route("/api/rooms", get(list).post(create))
        .route("/api/rooms/{code}", get(lookup))
        .route("/api/quick", post(quick_play))
        .route("/api/progress", post(check_progress))
        .fallback_service(client)
        .with_state(app);

    // Snapshots are small and go out 30 times a second: send each at once, not held back until
    // the last one is acknowledged (Nagle's algorithm, on by default).
    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("bind port").tap_io(|tcp| {
        if let Err(e) = tcp.set_nodelay(true) {
            eprintln!("couldn't set TCP_NODELAY: {e}");
        }
    });
    println!("serving {static_dir}/ and ws://localhost:{port}/ws (LAG_MS={})", lag.as_millis());
    let served = axum::serve(listener, router).into_future().await;
    eprintln!("server stopped: {served:?}");
    std::process::exit(1);
}

/// The lobby's view: public rooms, busiest first, and the modes and maps a room can be pinned
/// to, each as [key, name] ("crashsite", "Crash Site").
#[derive(Serialize)]
struct Lobby {
    rooms: Vec<RoomInfo>,
    modes: Vec<(&'static str, &'static str)>,
    maps: &'static [(&'static str, String)],
}

/// The rotation's maps with their names, read from the maps once.
static MAP_NAMES: LazyLock<Vec<(&'static str, String)>> =
    LazyLock::new(|| ROTATION.iter().map(|&key| (key, Map::load(Map::index(key).expect("rotation names a map")).name)).collect());

async fn list(State(app): State<App>) -> Json<Lobby> {
    let mut rooms: Vec<RoomInfo> = infos(&app.rooms).into_iter().filter(|r| r.public).collect();
    rooms.sort_by(|a, b| b.humans.cmp(&a.humans).then_with(|| a.code.cmp(&b.code)));
    Json(Lobby { rooms, modes: Mode::ALL.iter().map(|m| (m.key(), m.name())).collect(), maps: &MAP_NAMES })
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
    mode: Option<String>,
    map: Option<String>,
    score_limit: Option<u16>,
    bots: Option<bool>,
    bot_skill: Option<String>,
}

async fn create(State(app): State<App>, Json(new): Json<NewRoom>) -> Result<Json<RoomInfo>, (StatusCode, &'static str)> {
    let bad = |why| (StatusCode::BAD_REQUEST, why);
    let mut settings = Settings { name: "Private game".into(), public: false, mode: None, map: None, ..(*app.quick).clone() };
    if let Some(name) = new.name.as_deref().map(callsign).filter(|n| !n.is_empty()) {
        settings.name = name;
    }
    settings.public = new.public.unwrap_or(false);
    if let Some(mode) = new.mode.filter(|m| !m.is_empty()) {
        settings.mode = Some(Mode::from_key(&mode).ok_or(bad("no such mode"))?);
    }
    if let Some(map) = new.map.filter(|m| !m.is_empty()) {
        settings.map = Some(Map::index(&map).ok_or(bad("no such map"))?);
    }
    if deck(&settings).is_empty() {
        return Err(bad("that map doesn't play that mode"));
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

/// What the lobby's play buttons ask for: quick play, or co-op.
#[derive(Deserialize)]
struct Quick {
    #[serde(default)]
    coop: bool,
}

async fn quick_play(State(app): State<App>, Json(quick): Json<Quick>) -> Result<Json<RoomInfo>, (StatusCode, &'static str)> {
    let settings = if quick.coop { Settings { name: "Co-op".into(), mode: Some(Mode::Defense), map: None, ..(*app.quick).clone() } } else { (*app.quick).clone() };
    let mut rooms = app.rooms.lock().expect("rooms lock");
    let code = quick_room(&app, &mut rooms, settings).ok_or((StatusCode::SERVICE_UNAVAILABLE, "too many rooms open"))?;
    Ok(Json(rooms[&code].info.lock().expect("info lock").clone()))
}

/// A record a pilot brought from another browser, checked: what it holds, or 400.
async fn check_progress(State(app): State<App>, token: String) -> Result<Json<Record>, (StatusCode, &'static str)> {
    app.signer.verify(token.trim()).map(Json).ok_or((StatusCode::BAD_REQUEST, "not a record this server signed"))
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
            None => quick_room(&app, &mut rooms, (*app.quick).clone()),
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

/// The code of the room quick play (or co-op, by `settings`) joins: the public one of its kind with
/// the most humans that has space for one more and enough of its match left (or is between
/// matches), else a new one with `settings`.
fn quick_room(app: &App, rooms: &mut HashMap<String, Room>, settings: Settings) -> Option<String> {
    let open_rooms: Vec<RoomInfo> = rooms.values().map(|r| r.info.lock().expect("info lock").clone()).collect();
    match pick_quick(&open_rooms, settings.mode == Some(Mode::Defense)) {
        Some(code) => Some(code.to_string()),
        None => open(app, rooms, settings),
    }
}

/// Co-op rooms only for co-op, and versus ones only for quick play. A co-op run has no clock.
fn pick_quick(rooms: &[RoomInfo], coop: bool) -> Option<&str> {
    rooms
        .iter()
        .filter(|r| (r.mode == Mode::Defense.key()) == coop)
        .filter(|r| r.public && r.humans < r.capacity && (r.ended || coop || r.seconds_left >= QUICK_MIN_LEFT))
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
    let task = tokio::spawn(room_loop(game, cmd_rx, info, idle, settings, app.signer.clone()));
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

/// The modes each compiled-in map plays, worked out once (it reads every map).
static PLAYS: LazyLock<Vec<Vec<Mode>>> = LazyLock::new(|| (0..MAPS.len()).map(Map::load).map(|map| Mode::ALL.into_iter().filter(|m| m.fits(&map)).collect()).collect());

/// Every mode and map pair `settings` plays: its mode (else every mode) on its map (else the
/// rotation's), where the map plays the mode.
fn deck(settings: &Settings) -> Vec<(Mode, usize)> {
    let maps: Vec<usize> = match settings.map {
        Some(map) => vec![map],
        None => ROTATION.iter().map(|name| Map::index(name).expect("rotation names a map")).collect(),
    };
    // Co-op only when a room asks for it.
    let modes = settings.mode.map_or(Mode::ALL.into_iter().filter(|m| m.versus()).collect(), |m| vec![m]);
    modes.iter().flat_map(|&mode| maps.iter().filter(move |&&map| PLAYS[map].contains(&mode)).map(move |&map| (mode, map))).collect()
}

fn new_game(settings: &Settings, seed: u64) -> Game {
    let deck = deck(settings);
    let (mode, map) = deck[(seed % deck.len() as u64) as usize];
    let mut game = Game::new(Tuning::default(), map);
    game.mode = mode;
    game.rotate(deck, seed);
    (game.score_limit, game.match_seconds, game.bots, game.bot_skill) = (settings.score_limit, settings.match_seconds, settings.bots, settings.bot_skill);
    game.staging_seconds = STAGING_SECONDS;
    game.start_match();
    game
}

fn describe(code: &str, settings: &Settings, game: &Game) -> RoomInfo {
    let (state, (humans, bots)) = (game.match_state(), game.headcount());
    RoomInfo {
        code: code.into(),
        name: settings.name.clone(),
        public: settings.public,
        mode: state.mode.key(),
        map: MAPS[usize::from(state.map)].0.into(),
        humans,
        bots,
        capacity: MAX_PLAYERS,
        // While the spawns are penned, the clock is the wait: the match's own is still to come.
        seconds_left: if state.staging { state.seconds_left.saturating_add(game.match_seconds as u16) } else { state.seconds_left },
        ended: state.ended,
        scores: state.scores,
    }
}

/// A pilot's progression this visit: the record they joined with (plus each match they've seen
/// out here), and the tally their last record went out with.
struct Pilot {
    base: Record,
    sent: Tally,
}

/// Message carrying `record`, stamped and with player `id`'s callsign, and signed; `end` is the
/// match's XP, at its end.
fn progress_msg(signer: &Signer, game: &Game, id: u8, mut record: Record, end: Option<MatchXp>) -> Vec<u8> {
    record.callsign = game.name(id).unwrap_or_default().into();
    record.issued = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    net::encode(&ServerMsg::Progress { record: signer.sign(&record), end })
}

/// One room's match: applies its players' messages each tick, steps the game and sends everyone
/// their snapshot, and their progression record now and then. Returns once nobody has been in it
/// for `idle`.
async fn room_loop(mut game: Game, mut cmds: mpsc::UnboundedReceiver<Cmd>, info: Arc<Mutex<RoomInfo>>, idle: Duration, settings: Settings, signer: Signer) {
    let code = info.lock().expect("info lock").code.clone();
    let mut outboxes: Vec<(u8, Outbox)> = Vec::new();
    let mut pilots: HashMap<u8, Pilot> = HashMap::new();
    let mut links: HashMap<u8, Link> = HashMap::new();
    let mut ended = game.match_state().ended;
    let mut roster_sent = u32::MAX;
    let mut empty_since = Some(Instant::now());
    let mut interval = time::interval(Duration::from_secs_f32(DT));
    // Health, logged every 10 s if a tick ran a whole tick late or long (Fly's shared CPU
    // throttles): the latest tick, the longest step and sends, and how many ran over 100 ms late.
    let (mut worst_late, mut worst_step, mut late_ticks, mut since_report) = (Duration::ZERO, Duration::ZERO, 0, Instant::now());
    loop {
        let late = interval.tick().await.elapsed();
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
                Cmd::Msg(id, ClientMsg::Input(msg)) => {
                    let link = links.entry(id).or_insert(Link { lag: 0.0, base: f32::INFINITY, held: Vec::new() });
                    link.lag = game.tick as f32 - (msg.view_tick + INTERP_TICKS);
                    link.base = (link.base + BASE_DRIFT).min(link.lag);
                    game.push_input(id, msg);
                }
                // Only weapons and items the pilot has unlocked for that mech (its own until their
                // record's in).
                Cmd::Msg(id, ClientMsg::Pick(class, loadout)) => {
                    let loadout = pilots.get(&id).map_or(Loadout::of(class), |p| p.base.allowed(class, loadout));
                    game.pick(id, class, loadout);
                }
                Cmd::Msg(id, ClientMsg::Name(name)) => game.set_name(id, &name),
                Cmd::Msg(id, ClientMsg::Build(order)) => game.build(id, order),
                Cmd::Msg(id, ClientMsg::Draft(choice)) => game.draft(id, choice),
                // Once a visit: taking another record mid-match would count the match twice.
                Cmd::Msg(id, ClientMsg::Progress(token)) if !pilots.contains_key(&id) => {
                    let base = signer.verify(&token).unwrap_or_else(|| {
                        if !token.is_empty() {
                            println!("room {code}: player {id}'s record didn't verify; a fresh guest");
                        }
                        Record::guest(signer.guest_id(), "")
                    });
                    game.set_level(id, base.level);
                    if let Some((_, out)) = outboxes.iter().find(|(i, _)| *i == id) {
                        let _ = out.send((Instant::now(), progress_msg(&signer, &game, id, base.clone(), None)));
                    }
                    pilots.insert(id, Pilot { base, sent: Tally::default() });
                }
                Cmd::Msg(_, ClientMsg::Progress(_)) => {}
                // Answered with the record, the match so far on it as at a checkpoint (none
                // between matches: the last one's already on it).
                Cmd::Msg(id, ClientMsg::Unlock { class, slot, index }) => {
                    if let (Some(pilot), Some((tally, _))) = (pilots.get_mut(&id), game.tally(id))
                        && pilot.base.unlock(class, slot, index)
                        && let Some((_, out)) = outboxes.iter().find(|(i, _)| *i == id)
                    {
                        println!("room {code}: player {id} unlocked {}", sim::arsenal::weapon(slot, index).map_or("?", |w| w.0));
                        let record = if game.match_state().ended {
                            pilot.base.clone()
                        } else {
                            pilot.sent = tally.clone();
                            pilot.base.with(tally, false, false).0
                        };
                        let _ = out.send((Instant::now(), progress_msg(&signer, &game, id, record, None)));
                    }
                }
                Cmd::Leave(id) => {
                    println!("room {code}: player {id} left");
                    game.leave(id);
                    outboxes.retain(|(i, _)| *i != id);
                    pilots.remove(&id);
                    links.remove(&id);
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
        let started = Instant::now();
        game.step();
        let now = Instant::now();
        // Progression: everyone's whole match as it ends, and checkpoints while it's on.
        let state = game.match_state();
        let checkpoint = !state.ended && game.tick % (CHECKPOINT_SECONDS * TICK_HZ as u32) == 0;
        if (state.ended && !ended) || checkpoint {
            for (id, out) in &outboxes {
                let (Some(pilot), Some((tally, team))) = (pilots.get_mut(id), game.tally(*id)) else { continue };
                let msg = if state.ended {
                    let (record, xp) = pilot.base.with(tally, true, state.winner == Some(team));
                    (pilot.base, pilot.sent) = (record.clone(), Tally::default());
                    progress_msg(&signer, &game, *id, record, Some(xp))
                } else if *tally != pilot.sent {
                    pilot.sent = tally.clone();
                    progress_msg(&signer, &game, *id, pilot.base.with(tally, false, false).0, None)
                } else {
                    continue;
                };
                let _ = out.send((now, msg));
            }
            for (id, pilot) in &pilots {
                let level = if state.ended { pilot.base.level } else { pilot.base.with(&pilot.sent, false, false).0.level };
                game.set_level(*id, level);
            }
        }
        ended = state.ended;
        if game.roster_version() != roster_sent {
            roster_sent = game.roster_version();
            let roster = net::encode(&ServerMsg::Roster(game.roster()));
            for (_, out) in &outboxes {
                let _ = out.send((now, roster.clone()));
            }
        }
        for (id, out) in &outboxes {
            let mut snapshot = game.snapshot(*id);
            if let Some(link) = links.get_mut(id) {
                link.held.append(&mut snapshot.events);
                if link.lag - link.base > BEHIND_TICKS && game.tick % TRICKLE != 0 {
                    continue;
                }
                std::mem::swap(&mut snapshot.events, &mut link.held);
            }
            let _ = out.send((now, net::encode(&ServerMsg::Snapshot(snapshot))));
        }
        (worst_late, worst_step) = (worst_late.max(late), worst_step.max(started.elapsed()));
        late_ticks += u32::from(late > Duration::from_millis(100));
        if since_report.elapsed() >= Duration::from_secs(10) {
            if worst_late.max(worst_step) >= interval.period() {
                let ms = |d: Duration| d.as_secs_f32() * 1e3;
                println!("room {code}: ticks up to {:.0} ms late, steps up to {:.1} ms, {late_ticks} over 100 ms late", ms(worst_late), ms(worst_step));
            }
            (worst_late, worst_step, late_ticks, since_report) = (Duration::ZERO, Duration::ZERO, 0, Instant::now());
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
    use sim::net::{InputMsg, Snapshot};
    use sim::{Arsenal, Input, MechClass, Slot};

    fn room(code: &str, public: bool, humans: usize, seconds_left: u16, ended: bool) -> RoomInfo {
        RoomInfo { code: code.into(), name: String::new(), public, mode: "tdm", map: String::new(), humans, bots: 0, capacity: MAX_PLAYERS, seconds_left, ended, scores: [0; 2] }
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
        assert_eq!(pick_quick(&rooms, false), Some("FFFF"));
        assert_eq!(pick_quick(&rooms[..2], false), Some("BBBB"));
        assert_eq!(pick_quick(&rooms[2..5], false), None);
        // Co-op is matched apart: quick play never lands in a co-op run, and co-op only in one.
        let coop = |code, humans| RoomInfo { mode: Mode::Defense.key(), ..room(code, true, humans, 0, false) };
        let rooms = [room("AAAA", true, 2, 400, false), coop("BBBB", 5), coop("CCCC", 3)];
        assert_eq!(pick_quick(&rooms, false), Some("AAAA"));
        assert_eq!(pick_quick(&rooms, true), Some("BBBB"));
        assert_eq!(pick_quick(&rooms[..1], true), None);
        // A room just opened, its spawns still penned, has its whole match to come.
        let settings = Settings { name: "Test".into(), public: true, mode: Some(Mode::TeamDeathmatch), map: None, score_limit: 20, match_seconds: 600.0, bots: false, bot_skill: 0.5 };
        let game = new_game(&settings, 1);
        assert!(game.match_state().staging);
        assert_eq!(pick_quick(&[describe("NEW", &settings, &game)], false), Some("NEW"));
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
    fn rooms_deal_the_modes_and_maps_their_settings_allow() {
        let settings = |mode, map: Option<&str>| Settings { name: String::new(), public: true, mode, map: map.map(|m| Map::index(m).unwrap()), score_limit: 20, match_seconds: 600.0, bots: true, bot_skill: 0.5 };
        // Every map but the co-op one, which comes round only in co-op rooms.
        let every = deck(&settings(None, None));
        assert_eq!(every.iter().filter(|(m, _)| *m == Mode::TeamDeathmatch).count(), ROTATION.len() - 1);
        assert!(every.iter().all(|&(_, map)| MAPS[map].0 != "hivewall"));
        let coop: Vec<&str> = deck(&settings(Some(Mode::Defense), None)).iter().map(|&(_, map)| MAPS[map].0).collect();
        assert_eq!(coop, ["hivewall"]);
        // Deathmatch only on the smaller maps.
        let dm: Vec<&str> = deck(&settings(Some(Mode::Deathmatch), None)).iter().map(|&(_, map)| MAPS[map].0).collect();
        assert_eq!(dm, ["isotope", "verdigris", "sump", "sinkhole", "ziggurat"]);
        let ma: Vec<&str> = deck(&settings(Some(Mode::MissileAssault), None)).iter().map(|&(_, map)| MAPS[map].0).collect();
        assert_eq!(ma, ["foundry", "verdigris", "riftline", "sinkhole", "canopy", "crashsite", "ziggurat", "span", "walled"]);
        let siege: Vec<&str> = deck(&settings(Some(Mode::Siege), None)).iter().map(|&(_, map)| MAPS[map].0).collect();
        assert_eq!(siege, ["foundry", "riftline", "canopy", "crashsite", "span"]);
        let ctf: Vec<&str> = deck(&settings(Some(Mode::CaptureTheFlag), None)).iter().map(|&(_, map)| MAPS[map].0).collect();
        assert_eq!(ctf, ["foundry", "verdigris", "riftline", "sinkhole", "canopy", "crashsite", "walled"]);
        let convoy: Vec<&str> = deck(&settings(Some(Mode::Convoy), None)).iter().map(|&(_, map)| MAPS[map].0).collect();
        assert_eq!(convoy, ["foundry", "riftline", "canopy", "crashsite", "span", "walled"]);
        let canopy = Map::index("canopy").unwrap();
        let canopy_modes = [Mode::TeamDeathmatch, Mode::MissileAssault, Mode::Siege, Mode::CaptureTheFlag, Mode::Convoy];
        assert_eq!(deck(&settings(None, Some("canopy"))), canopy_modes.map(|m| (m, canopy)));
        assert!(deck(&settings(Some(Mode::Deathmatch), Some("canopy"))).is_empty());
        // A room starts on a pair from its deck.
        let game = new_game(&settings(Some(Mode::Deathmatch), None), 3);
        assert_eq!(game.mode, Mode::Deathmatch);
    }

    #[test]
    fn settings_parse_and_clean() {
        assert_eq!((skill("easy"), skill("hard"), skill("0.9"), skill("2"), skill("sharp")), (Some(0.25), Some(0.75), Some(0.9), None, None));
        assert_eq!(callsign("  Friday\n night fights, all welcome!!  "), "Friday night fights, all");
    }

    #[test]
    fn records_round_trip_and_tampering_is_refused() {
        let signer = Signer::new(b"a key");
        let mut tally = Tally::default();
        tally.kill(Some("pike"), false, 1.25);
        let (record, _) = Record::guest(signer.guest_id(), "Ace").with(&tally, true, true);
        let token = signer.sign(&record);
        assert_eq!(signer.verify(&token), Some(record));

        let (payload, tag) = token.split_once('.').unwrap();
        let mut richer: Record = serde_json::from_slice(&B64.decode(payload).unwrap()).unwrap();
        richer.xp = 1_000_000;
        let forged = format!("{}.{tag}", B64.encode(serde_json::to_vec(&richer).unwrap()));
        let mut future = Record::guest(1, "Ace");
        future.version = RECORD_VERSION + 1;
        let future = signer.sign(&future);
        for bad in [forged.as_str(), payload, "", "x.y", &token[..token.len() - 2], &future] {
            assert_eq!(signer.verify(bad), None, "took {bad:?}");
        }
        assert_eq!(Signer::new(b"another key").verify(&token), None);
        assert_ne!(signer.guest_id(), signer.guest_id());
    }

    /// A fresh room on a server with `key`, its match `match_seconds` long, joined by one player
    /// bringing `record`: the room's task, the way to send it the player's messages (with their
    /// id), and what it sends them.
    async fn join_room(key: &[u8], match_seconds: f32, record: &str) -> (tokio::task::JoinHandle<()>, impl Fn(ClientMsg) + use<>, mpsc::UnboundedReceiver<(Instant, Vec<u8>)>) {
        let settings = Settings { name: "Test".into(), public: false, mode: Some(Mode::TeamDeathmatch), map: None, score_limit: 20, match_seconds, bots: false, bot_skill: 0.5 };
        let game = new_game(&settings, 1);
        let info = Arc::new(Mutex::new(describe("TEST", &settings, &game)));
        let (cmds, cmd_rx) = mpsc::unbounded_channel();
        let room = tokio::spawn(room_loop(game, cmd_rx, info, IDLE_PUBLIC, settings, Signer::new(key)));
        let (out, inbox) = mpsc::unbounded_channel();
        let (reply, id) = oneshot::channel();
        cmds.send(Cmd::Join(out, reply)).unwrap();
        let id = id.await.unwrap().unwrap();
        let send = move |msg| cmds.send(Cmd::Msg(id, msg)).unwrap();
        send(ClientMsg::Progress(record.into()));
        (room, send, inbox)
    }

    /// Joins a fresh room (on a server with `key`) bringing `record`, sees its one-second match
    /// out, and returns the record it ends with and the XP it brought.
    async fn visit(key: &[u8], record: &str) -> (Record, MatchXp) {
        let (room, _send, mut inbox) = join_room(key, 1.0, record).await;
        loop {
            let (_, bytes) = inbox.recv().await.unwrap();
            if let Some(ServerMsg::Progress { record, end: Some(xp) }) = net::decode(&bytes) {
                room.abort();
                return (Signer::new(key).verify(&record).expect("the room signs what it sends"), xp);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn records_carry_across_a_server_restart() {
        let key = b"the server's key";
        let (first, xp) = visit(key, "").await;
        assert_eq!((xp.completion, first.stats.matches, first.xp), (100, 1, 100));
        // Each visit is a new room loop and signer, as after a restart: only the key carries over.
        let (second, _) = visit(key, &Signer::new(key).sign(&first)).await;
        assert_eq!((&second.id, second.stats.matches, second.xp), (&first.id, 2, 200));
        // A record from a server with another key (or a forged one) starts a fresh guest.
        let (fresh, _) = visit(b"another key", &Signer::new(key).sign(&second)).await;
        assert_ne!(fresh.id, first.id);
        assert_eq!((fresh.stats.matches, fresh.xp), (1, 100));
    }

    /// Index of weapon or item `id` in `slot`'s list.
    fn weapon(slot: Slot, id: &str) -> u8 {
        (0..).find(|&i| sim::arsenal::weapon(slot, i).expect("no such weapon").0 == id).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn rooms_spend_points_and_launch_only_unlocked_weapons() {
        let key = b"the server's key";
        let mut record = Record::guest(7, "Ace");
        record.level = 2; // 3 points: the rail gun, and nothing after
        let (room, send, mut inbox) = join_room(key, 600.0, &Signer::new(key).sign(&record)).await;
        // The next record the room sends, and the loadout the player's mech carries a little later.
        let next_record = async |inbox: &mut mpsc::UnboundedReceiver<(Instant, Vec<u8>)>| loop {
            if let Some(ServerMsg::Progress { record, .. }) = net::decode(&inbox.recv().await.unwrap().1) {
                return Signer::new(key).verify(&record).unwrap();
            }
        };
        let loadout_after = async |inbox: &mut mpsc::UnboundedReceiver<(Instant, Vec<u8>)>| {
            let mut last = None;
            for _ in 0..60 {
                if let Some(ServerMsg::Snapshot(s)) = net::decode(&inbox.recv().await.unwrap().1) {
                    last = Some(s.me.loadout);
                }
            }
            last.unwrap()
        };
        assert_eq!(next_record(&mut inbox).await.points(), 3);

        let (light, own) = (sim::MechClass::A, Loadout::of(sim::MechClass::A));
        let (rail, gatling) = (weapon(Slot::Secondary, "spindle"), weapon(Slot::Primary, "gyre"));
        // Locked: launches with the light's own weapons instead.
        send(ClientMsg::Pick(light, Loadout { primary: gatling, secondary: rail, ..own }));
        assert_eq!(loadout_after(&mut inbox).await, own);

        send(ClientMsg::Unlock { class: light, slot: Slot::Secondary, index: rail });
        let unlocked = next_record(&mut inbox).await;
        assert_eq!((unlocked.unlocks["A"].clone(), unlocked.points()), (vec!["spindle".to_string()], 0));
        // Out of points: the gatling stays locked, and the next launch carries the rail gun alone.
        send(ClientMsg::Unlock { class: light, slot: Slot::Primary, index: gatling });
        send(ClientMsg::Pick(light, Loadout { primary: gatling, secondary: rail, ..own }));
        assert_eq!(loadout_after(&mut inbox).await, Loadout { secondary: rail, ..own });
        room.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn rooms_launch_only_unlocked_items() {
        let key = b"the server's key";
        let mut record = Record::guest(7, "Ace");
        record.level = 2; // 3 points: the Salve (2), then not the Limpet (2)
        let (room, send, mut inbox) = join_room(key, 600.0, &Signer::new(key).sign(&record)).await;
        let loadout_after = async |inbox: &mut mpsc::UnboundedReceiver<(Instant, Vec<u8>)>| {
            let mut last = None;
            for _ in 0..60 {
                if let Some(ServerMsg::Snapshot(s)) = net::decode(&inbox.recv().await.unwrap().1) {
                    last = Some(s.me.loadout);
                }
            }
            last.unwrap()
        };
        let (heavy, own) = (sim::MechClass::C, Loadout::of(sim::MechClass::C));
        let (limpet, orb) = (weapon(Slot::Offensive, "limpet"), weapon(Slot::Support, "orb"));
        let wanted = Loadout { offensive: limpet, support: orb, ..own };
        // Locked: launches with the Tumbler and the Brownout instead.
        send(ClientMsg::Pick(heavy, wanted));
        assert_eq!(loadout_after(&mut inbox).await, own);

        send(ClientMsg::Unlock { class: heavy, slot: Slot::Support, index: orb });
        send(ClientMsg::Unlock { class: heavy, slot: Slot::Offensive, index: limpet });
        send(ClientMsg::Pick(heavy, wanted));
        assert_eq!(loadout_after(&mut inbox).await, Loadout { support: orb, ..own }, "carried an item it couldn't afford");
        room.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_lagging_player_gets_every_tenth_snapshot_with_every_event_until_caught_up() {
        let (room, send, mut inbox) = join_room(b"the server's key", 600.0, "").await;
        let next = async |inbox: &mut mpsc::UnboundedReceiver<(Instant, Vec<u8>)>| net::decode::<ServerMsg>(&inbox.recv().await.unwrap().1).unwrap();
        // An input whose view runs `behind` ticks behind snapshot `s` (0: just in).
        let input = |seq, fire, s: &Snapshot, behind: f32| ClientMsg::Input(InputMsg { seq, input: Input { fire, ..Input::default() }, view_tick: s.tick as f32 - behind - INTERP_TICKS });
        let shots = |s: &Snapshot| s.events.iter().filter(|e| matches!(e, Event::Shot { .. })).count();
        let heavy = MechClass::C;
        let pellets = Arsenal::new(&Tuning::default()).get(heavy, Loadout::of(heavy)).pellets as usize;
        send(ClientMsg::Pick(heavy, Loadout::of(heavy)));
        // Launched, halfway between trickled snapshots.
        let s = loop {
            if let ServerMsg::Snapshot(s) = next(&mut inbox).await
                && s.hangar.is_none()
                && s.tick % TRICKLE == 5
            {
                break s;
            }
        };

        // In step, then 40 ticks behind and firing the flak: its pellets' snapshot is held back,
        // and the next one through carries them. The roster for a rename isn't held.
        send(input(1, false, &s, 0.0));
        send(input(2, true, &s, 40.0));
        send(ClientMsg::Name("Ace".into()));
        let (mut held, mut renamed) = (Vec::new(), false);
        while held.len() < 2 {
            match next(&mut inbox).await {
                ServerMsg::Snapshot(snapshot) => held.push(snapshot),
                ServerMsg::Roster(roster) => renamed |= roster.iter().any(|(_, name, _)| name == "Ace"),
                _ => {}
            }
        }
        assert!(renamed);
        assert_eq!(held.iter().map(|h| (h.tick - s.tick, shots(h))).collect::<Vec<_>>(), [(5, pellets), (15, 0)]);

        // In step again: every snapshot.
        send(input(3, false, &held[1], 0.0));
        let mut ticks = Vec::new();
        while ticks.len() < 3 {
            if let ServerMsg::Snapshot(snapshot) = next(&mut inbox).await {
                ticks.push(snapshot.tick - held[1].tick);
            }
        }
        assert_eq!(ticks, [1, 2, 3]);
        room.abort();
    }
}
