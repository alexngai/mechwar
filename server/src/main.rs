//! Serves the built client and the game WebSocket (`/ws`) on one port. One 30 Hz loop owns the
//! match; each connection gets a reader and a writer task. Env: `PORT` (9001), `STATIC_DIR`
//! (`dist`), `MAP` (`saltworks`), `LAG_MS` (one-way delay for testing), `SCORE_LIMIT`, `MATCH_SECONDS`.

use std::future::IntoFuture;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, thread};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use sim::bot::Nav;
use sim::game::Game;
use sim::net::{self, ClientMsg, ServerMsg};
use sim::{DT, Map, Tuning};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, Instant};
use tower_http::services::{ServeDir, ServeFile};

/// Clients send ~40-byte inputs; anything bigger is hostile.
const MAX_MESSAGE_BYTES: usize = 1024;

/// Outgoing bytes, stamped when queued so `LAG_MS` delays every message by the same amount.
type Outbox = mpsc::UnboundedSender<(Instant, Vec<u8>)>;

enum Cmd {
    Join(Outbox, oneshot::Sender<Option<u8>>),
    Msg(u8, ClientMsg),
    Leave(u8),
}

#[derive(Clone)]
struct App {
    cmds: mpsc::UnboundedSender<Cmd>,
    lag: Duration,
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT").map_or(9001, |p| p.parse().expect("PORT must be a port number"));
    let lag = Duration::from_millis(env::var("LAG_MS").map_or(0, |v| v.parse().expect("LAG_MS must be milliseconds")));
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());

    let (cmds, cmd_rx) = mpsc::unbounded_channel();
    let game = tokio::spawn(game_loop(cmd_rx));
    let client = ServeDir::new(&static_dir).fallback(ServeFile::new(format!("{static_dir}/index.html")));
    let app = Router::new().route("/ws", get(upgrade)).fallback_service(client).with_state(App { cmds, lag });

    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("bind port");
    println!("serving {static_dir}/ and ws://localhost:{port}/ws (LAG_MS={})", lag.as_millis());
    // A dead game loop would leave a server that accepts players but never ticks: exit so the
    // host restarts us instead.
    tokio::select! {
        served = axum::serve(listener, app).into_future() => eprintln!("server stopped: {served:?}"),
        ended = game => eprintln!("game loop stopped: {ended:?}"),
    }
    std::process::exit(1);
}

async fn upgrade(ws: WebSocketUpgrade, State(app): State<App>) -> Response {
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, app.cmds, app.lag))
}

async fn game_loop(mut cmds: mpsc::UnboundedReceiver<Cmd>) {
    // MAP pins one map; otherwise a random one from the rotation each match.
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64);
    let (map, rotation) = match env::var("MAP") {
        Ok(name) => (Map::index(&name).expect("MAP must name a map in maps/"), Vec::new()),
        Err(_) => {
            let rotation: Vec<usize> = sim::map::ROTATION.iter().map(|name| Map::index(name).expect("rotation names a map")).collect();
            (rotation[(seed % rotation.len() as u64) as usize], rotation)
        }
    };
    // Bot nav takes a moment per map: build the others' now, not when a match switches to them.
    let warm = rotation.clone();
    thread::spawn(move || warm.into_iter().for_each(|m| _ = Nav::for_map(m)));
    let mut game = Game::new(Tuning::default(), map);
    game.rotate(rotation, seed);
    println!("map: {}", sim::map::MAPS[map].0);
    // Shorter matches for playtesting.
    if let Ok(v) = env::var("SCORE_LIMIT") {
        game.score_limit = v.parse().expect("SCORE_LIMIT must be a kill count");
    }
    if let Ok(v) = env::var("MATCH_SECONDS") {
        game.match_seconds = v.parse().expect("MATCH_SECONDS must be seconds");
    }
    let mut outboxes: Vec<(u8, Outbox)> = Vec::new();
    let mut roster_sent = u32::MAX;
    let mut interval = time::interval(Duration::from_secs_f32(DT));
    loop {
        interval.tick().await;
        while let Ok(cmd) = cmds.try_recv() {
            match cmd {
                Cmd::Join(out, reply) => {
                    let id = game.join();
                    let msg = id.map_or(ServerMsg::Full, |id| ServerMsg::Welcome { id, map: game.map as u8 });
                    let _ = out.send((Instant::now(), net::encode(&msg)));
                    if let Some(id) = id {
                        println!("player {id} joined");
                        outboxes.push((id, out));
                    }
                    let _ = reply.send(id);
                }
                Cmd::Msg(id, ClientMsg::Input(msg)) => game.push_input(id, msg),
                Cmd::Msg(id, ClientMsg::Pick(class, loadout)) => game.pick(id, class, loadout),
                Cmd::Msg(id, ClientMsg::Name(name)) => game.set_name(id, &name),
                Cmd::Leave(id) => {
                    println!("player {id} left");
                    game.leave(id);
                    outboxes.retain(|(i, _)| *i != id);
                }
            }
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
        // Full: the game loop queued `Full` and dropped the outbox, so the writer sends it and closes.
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
