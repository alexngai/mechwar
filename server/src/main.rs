//! WebSocket glue around `sim::game::Game`: one 30 Hz loop owns the match, and each connection
//! gets a reader and a writer task. `LAG_MS` adds a constant one-way delay in both directions.

use std::{env, time::Duration};

use futures_util::{SinkExt, StreamExt};
use sim::game::Game;
use sim::net::{self, ClientMsg, ServerMsg};
use sim::{DT, Tuning};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, Instant};
use tokio_tungstenite::tungstenite::Message;

/// Outgoing bytes, stamped when queued so `LAG_MS` delays every message by the same amount.
type Outbox = mpsc::UnboundedSender<(Instant, Vec<u8>)>;

enum Cmd {
    Join(Outbox, oneshot::Sender<Option<u8>>),
    Input(u8, ClientMsg),
    Leave(u8),
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT").map_or(9001, |p| p.parse().expect("PORT must be a port number"));
    let lag = Duration::from_millis(env::var("LAG_MS").map_or(0, |v| v.parse().expect("LAG_MS must be milliseconds")));
    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("bind port");
    println!("listening on ws://localhost:{port} (LAG_MS={})", lag.as_millis());

    let (cmds, cmd_rx) = mpsc::unbounded_channel();
    tokio::spawn(game_loop(cmd_rx));
    loop {
        if let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(connection(stream, cmds.clone(), lag));
        }
    }
}

async fn game_loop(mut cmds: mpsc::UnboundedReceiver<Cmd>) {
    let mut game = Game::new(Tuning::default());
    let mut outboxes: Vec<(u8, Outbox)> = Vec::new();
    let mut interval = time::interval(Duration::from_secs_f32(DT));
    loop {
        interval.tick().await;
        while let Ok(cmd) = cmds.try_recv() {
            match cmd {
                Cmd::Join(out, reply) => {
                    let id = game.join();
                    let msg = id.map_or(ServerMsg::Full, |id| ServerMsg::Welcome { id });
                    let _ = out.send((Instant::now(), net::encode(&msg)));
                    if let Some(id) = id {
                        println!("player {id} joined");
                        outboxes.push((id, out));
                    }
                    let _ = reply.send(id);
                }
                Cmd::Input(id, msg) => game.push_input(id, msg),
                Cmd::Leave(id) => {
                    println!("player {id} left");
                    game.leave(id);
                    outboxes.retain(|(i, _)| *i != id);
                }
            }
        }
        game.step();
        let now = Instant::now();
        for (id, out) in &outboxes {
            let _ = out.send((now, net::encode(&ServerMsg::Snapshot(game.snapshot(*id)))));
        }
    }
}

async fn connection(stream: TcpStream, cmds: mpsc::UnboundedSender<Cmd>, lag: Duration) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut sink, mut source) = ws.split();

    let (out, mut outbox) = mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
    let writer = tokio::spawn(async move {
        while let Some((queued, bytes)) = outbox.recv().await {
            time::sleep_until(queued + lag).await;
            if sink.send(Message::binary(bytes)).await.is_err() {
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
            if forward.send(Cmd::Input(id, msg)).is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = source.next().await {
        if let Message::Binary(bytes) = msg
            && let Some(input) = net::decode::<ClientMsg>(&bytes)
        {
            let _ = delay.send((Instant::now(), input));
        }
    }
    let _ = cmds.send(Cmd::Leave(id));
    forwarder.abort();
    writer.abort();
}
