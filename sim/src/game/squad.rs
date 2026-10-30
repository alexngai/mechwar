//! Pings and callouts, so a human's bot teammates play like a squad. A human pings what they aim
//! at: an enemy becomes a contact for the bots near it and the one their team goes for; a spot
//! sends the nearest free bots there, or, marked as an enemy sighted, sets them on the enemy by it. Bots tell their human teammates, sparingly, what they see
//! and need. Only the team concerned gets either (`Game::hears`).

use super::*;
use crate::bot::Doing;
use crate::net::{Call, Mark};

/// Least time between a player's pings (s).
const PING_GAP: f32 = 0.5;
/// Farthest a ping reaches (m), and how far off the aim an enemy can be to be the one pinged (rad).
const PING_RANGE: f32 = 300.0;
const PING_CONE: f32 = 0.1;
/// Bots this near a pinged enemy learn where it is (m); for PING_MARK s their team goes for it,
/// as if PING_FAVOUR more teammates were on it (`Bot::engaged`).
const PING_REACH: f32 = 120.0;
const PING_MARK: f32 = 10.0;
const PING_FAVOUR: usize = 2;
/// An enemy sighted at a spot is the nearest within this of it (m).
const SIGHTED_NEAR: f32 = 20.0;
/// How many free bots (none with an objective job) a pinged spot sends, and for how long (s).
const PING_SENDS: usize = 2;
const PING_ORDER: f32 = 25.0;
/// Least time between one bot's callouts, and between one team's callouts of one kind (s).
const BOT_GAP: f32 = 6.0;
const KIND_GAP: f32 = 10.0;
/// An enemy none of a team's bots has seen for this long is marked for the team's humans when one
/// does, and called a contact (in words) after longer still (s). Kept in view, it's marked once:
/// marks are news of where an enemy turned up, not a track of it.
const MARK_AFTER: f32 = 8.0;
const CONTACT_AFTER: f32 = 15.0;
/// A bot falling back under this share of its hull, with an enemy in view, calls for help.
const HELP_HULL: f32 = 0.4;

/// A ping: whose, on which team, what it marks and where, the enemy it sets bots on (if any),
/// until when it holds, the bots it sent, and whether it's yet to be announced and acted on.
struct Ping {
    from: u8,
    team: u8,
    mark: Mark,
    enemy: Option<u8>,
    at: Vector,
    until: u32,
    sent: Vec<u8>,
    fresh: bool,
}

#[derive(Default)]
pub(super) struct Squad {
    pings: Vec<Ping>,
    /// Players who asked to ping since the last step's end, the tick each saw others at then, and
    /// whether as an enemy sighted.
    asked: Vec<(u8, f32, bool)>,
    /// When each player may ping next, by id.
    ping_ok: [u32; MAX_PLAYERS],
    /// When each bot may speak next, by id, and each team hear each kind of call next (`kind`).
    bot_ok: [u32; MAX_PLAYERS],
    kind_ok: [[u32; 4]; 2],
    /// By team and enemy id: when one of the team's bots last saw it.
    seen: [[Option<u32>; MAX_PLAYERS]; 2],
}

/// Which limit a call counts against; None for a mark, which has its own (MARK_AFTER).
fn kind(call: Call) -> Option<usize> {
    match call {
        Call::Spotted(_) => None,
        Call::Contact(_) => Some(0),
        Call::Help => Some(1),
        Call::CarrierDown { .. } => Some(2),
        Call::OnMyWay => Some(3),
    }
}

impl Squad {
    /// Counts each enemy a live ping marks into its team's `engaged` PING_FAVOUR times.
    pub(super) fn favour(&self, engaged: &mut [Vec<u8>]) {
        for g in &self.pings {
            if let Some(e) = g.enemy {
                engaged[usize::from(g.team)].extend([e; PING_FAVOUR]);
            }
        }
    }

    /// Where a ping has sent bot `id` (the newest that did), if anywhere.
    pub(super) fn order(&self, id: u8) -> Option<Vector> {
        self.pings.iter().rev().find(|g| g.sent.contains(&id)).map(|g| g.at)
    }

    /// Whether bot `from` on `team` may call `call` now; if so, it counts against the limits.
    fn may_say(&mut self, from: u8, team: u8, call: Call, tick: u32) -> bool {
        let Some(k) = kind(call) else { return true };
        let (bot, kind) = (&mut self.bot_ok[usize::from(from)], &mut self.kind_ok[usize::from(team)][k]);
        if tick < *bot || tick < *kind {
            return false;
        }
        (*bot, *kind) = (tick + secs(BOT_GAP), tick + secs(KIND_GAP));
        true
    }
}

impl Game {
    /// Player `id` asks to ping what it aims at for its team (`sighted`: as an enemy seen there).
    /// It's worked out at the step's end, once the inputs sent before it are in (`resolve_ping`),
    /// and announced the step after.
    pub fn ping(&mut self, id: u8, sighted: bool) {
        let Some(p) = self.players.iter().find(|p| p.id == id) else { return };
        // Enemies as its newest input saw them (as shots rewind them).
        let view = p.inputs.back().map_or(self.tick as f32, |m| m.view_tick);
        if !self.squad.asked.iter().any(|a| a.0 == id) {
            self.squad.asked.push((id, view, sighted));
        }
    }

    /// Player `id`'s ping: the enemy nearest its aim within PING_CONE, in clear sight, where it
    /// stood at `view_tick` (as for shots); else the spot its aim meets the arena, one to go to,
    /// or (`sighted`) one an enemy was seen at, setting bots on the nearest enemy within
    /// SIGHTED_NEAR of it. A new ping takes the place of its last of the same sort (a spot to go
    /// to, or an enemy). Nothing in Deathmatch, from the hangar, at the sky, or within PING_GAP of
    /// its last.
    fn resolve_ping(&mut self, id: u8, view_tick: f32, sighted: bool) {
        let tick = self.tick;
        let view = view_tick.clamp(tick as f32 - MAX_REWIND_TICKS, tick as f32);
        let Some(p) = self.players.iter().find(|p| p.id == id && p.mech.health > 0.0 && p.respawn_at.is_none()) else { return };
        if self.mode == Mode::Deathmatch || tick < self.squad.ping_ok[usize::from(id)] {
            return;
        }
        let eye = aim_ray(self.arsenal.of(&p.mech), &p.mech);
        let enemy = self
            .players
            .iter()
            .filter(|q| q.team != p.team && q.mech.health > 0.0 && !cloaked(q))
            .filter_map(|q| {
                let chest = rewind(&q.history, view)? + Vector::Y * (self.arsenal.of(&q.mech).mech_height * 0.5);
                let (to, off) = (chest - eye.origin, (chest - eye.origin).angle_between(eye.dir));
                let clear = to.length() < PING_RANGE && off < PING_CONE && self.arena.cast_ray(&Ray::new(eye.origin, to / to.length()), to.length()).is_none() && !item::hidden(&self.clouds, eye.origin, chest);
                clear.then_some((off, q.id, q.mech.pos))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let (mark, at) = match enemy {
            Some((_, e, pos)) => (Mark::Enemy(e), pos),
            None => match self.arena.cast_ray(&eye, PING_RANGE) {
                Some(toi) => (if sighted { Mark::Sighted } else { Mark::Spot }, eye.point_at(toi)),
                None => return,
            },
        };
        let enemy = match mark {
            Mark::Enemy(e) => Some(e),
            Mark::Spot => None,
            Mark::Sighted => self
                .players
                .iter()
                .filter(|q| q.team != p.team && q.mech.health > 0.0 && !cloaked(q) && q.mech.pos.distance(at) < SIGHTED_NEAR)
                .min_by(|a, b| a.mech.pos.distance(at).total_cmp(&b.mech.pos.distance(at)))
                .map(|q| q.id),
        };
        let (team, until) = (p.team, tick + secs(if mark == Mark::Spot { PING_ORDER } else { PING_MARK }));
        self.squad.ping_ok[usize::from(id)] = tick + secs(PING_GAP);
        self.squad.pings.retain(|g| g.from != id || (g.mark == Mark::Spot) != (mark == Mark::Spot));
        self.squad.pings.push(Ping { from: id, team, mark, enemy, at, until, sent: Vec::new(), fresh: true });
    }

    /// Announces the pings made at the last step's end to their teams, and sets their bots on them:
    /// those within PING_REACH of a pinged enemy learn where it is (one sighted at a spot, that it's
    /// there); a spot to go to sends the
    /// PING_SENDS nearest living bots with no job in `orders` (by player index), the first of them
    /// free to speak saying so.
    pub(super) fn dispatch_pings(&mut self, orders: Option<&[Option<Vector>]>) {
        let tick = self.tick;
        for k in 0..self.squad.pings.len() {
            let Ping { from, team, mark, enemy, at, fresh: true, .. } = self.squad.pings[k] else { continue };
            self.events.push(Event::Ping { from, mark, at });
            let mut free: Vec<(f32, u8)> = Vec::new();
            for (i, p) in self.players.iter_mut().enumerate().filter(|(_, p)| p.team == team && p.mech.health > 0.0) {
                let Some(bot) = p.bot.as_mut() else { continue };
                match enemy {
                    Some(e) if p.mech.pos.distance(at) < PING_REACH => bot.told(e, at, tick),
                    None if mark == Mark::Spot && orders.is_none_or(|o| o[i].is_none()) => free.push((p.mech.pos.distance(at), p.id)),
                    _ => {}
                }
            }
            free.sort_by(|a, b| a.0.total_cmp(&b.0));
            let sent: Vec<u8> = free.iter().take(PING_SENDS).map(|f| f.1).collect();
            if let Some(&by) = sent.iter().find(|&&b| self.squad.may_say(b, team, Call::OnMyWay, tick)) {
                self.events.push(Event::Callout { from: by, call: Call::OnMyWay, at });
            }
            let g = &mut self.squad.pings[k];
            (g.sent, g.fresh) = (sent, false);
        }
    }

    /// The step's end for pings and callouts. Pings asked for are worked out; pings run out, an
    /// enemy's as it goes down, and a spot's bots as they do. And what bots tell the humans on
    /// their team (a team with none hears nothing): an enemy they see after none of them has for
    /// MARK_AFTER s, marked (in words, "contact", after CONTACT_AFTER s); a bot falling back hurt
    /// calls for help; a flag carrier down.
    pub(super) fn step_squad(&mut self) {
        for (id, view, sighted) in std::mem::take(&mut self.squad.asked) {
            self.resolve_ping(id, view, sighted);
        }
        let tick = self.tick;
        let up = |players: &[Player], id: u8| players.iter().any(|q| q.id == id && q.mech.health > 0.0);
        let players = &self.players;
        self.squad.pings.retain(|g| tick < g.until && g.enemy.is_none_or(|e| up(players, e)));
        for g in &mut self.squad.pings {
            g.sent.retain(|&b| up(players, b));
        }
        let drops: Vec<(u8, u8)> = self.events.iter().filter_map(|e| match *e {
            Event::Flag { team, what: Happened::Dropped, by: Some(victim) } => Some((team, victim)),
            _ => None,
        }).collect();
        for team in 0..2u8 {
            if !self.players.iter().any(|p| p.team == team && p.bot.is_none()) {
                continue;
            }
            let t = usize::from(team);
            let bots = || self.players.iter().filter(move |p| p.team == team && p.mech.health > 0.0).filter_map(|p| Some((p, p.bot.as_ref()?)));
            for (p, bot) in bots() {
                for (e, at) in bot.sightings().filter(|&(e, _)| usize::from(e) < MAX_PLAYERS) {
                    let seen = &mut self.squad.seen[t][usize::from(e)];
                    let unseen = seen.map_or(u32::MAX, |s| tick - s);
                    *seen = Some(tick);
                    let call = if unseen >= secs(CONTACT_AFTER) && self.squad.may_say(p.id, team, Call::Contact(e), tick) {
                        Call::Contact(e)
                    } else if unseen >= secs(MARK_AFTER) {
                        Call::Spotted(e)
                    } else {
                        continue;
                    };
                    self.events.push(Event::Callout { from: p.id, call, at });
                }
                let hull = p.mech.health / self.arsenal.of(&p.mech).health_max;
                if bot.doing() == Doing::FallBack && hull < HELP_HULL && bot.focus().is_some() && self.squad.may_say(p.id, team, Call::Help, tick) {
                    self.events.push(Event::Callout { from: p.id, call: Call::Help, at: p.mech.pos });
                }
            }
            for &(flag, victim) in &drops {
                let Some(at) = self.players.iter().find(|p| p.id == victim).map(|p| p.mech.pos) else { continue };
                let call = Call::CarrierDown { ours: team != flag };
                let nearest = bots().min_by(|a, b| a.0.mech.pos.distance(at).total_cmp(&b.0.mech.pos.distance(at))).map(|(p, _)| p.id);
                if let Some(by) = nearest.filter(|&by| self.squad.may_say(by, team, call, tick)) {
                    self.events.push(Event::Callout { from: by, call, at });
                }
            }
        }
    }

    /// Whether a player on `team` (None: not playing) gets event `e`: pings and callouts go to the
    /// team they're from only.
    pub(super) fn hears(&self, e: &Event, team: Option<u8>) -> bool {
        match *e {
            Event::Ping { from, .. } | Event::Callout { from, .. } => self.players.iter().any(|p| p.id == from && Some(p.team) == team),
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A game on blockout with no bots of its own, and `seats` (team, bot?) seated, unshielded.
    fn seated(seats: &[(u8, bool)]) -> (Game, Vec<u8>) {
        let mut game = Game::new(Tuning::default(), Map::index("blockout").unwrap());
        game.bots = false;
        let ids = seats.iter().map(|&(team, bot)| game.add_player(team, bot.then(|| Bot::new(u64::from(team) + 1)), MechClass::B).unwrap()).collect();
        for p in &mut game.players {
            p.mech.shield = 0.0;
        }
        (game, ids)
    }

    fn player(game: &mut Game, id: u8) -> &mut Player {
        game.players.iter_mut().find(|p| p.id == id).unwrap()
    }

    fn bot(game: &Game, id: u8) -> &Bot {
        game.players.iter().find(|p| p.id == id).unwrap().bot.as_ref().unwrap()
    }

    /// Stands player `id` at `pos`, looking at `look`.
    fn stand(game: &mut Game, id: u8, pos: Vector, look: Vector) {
        let m = player(game, id).mech;
        let eye = pos + Vector::Y * game.arsenal.of(&m).eye_height;
        let d = look - eye;
        let m = &mut player(game, id).mech;
        (m.pos, m.yaw, m.pitch) = (pos, libm::atan2f(-d.x, -d.z), libm::atan2f(d.y, Vector::new(d.x, 0.0, d.z).length()));
    }

    fn chest(game: &Game, id: u8) -> Vector {
        let m = &game.players.iter().find(|p| p.id == id).unwrap().mech;
        m.pos + Vector::Y * (game.arsenal.of(m).mech_height * 0.5)
    }

    #[test]
    fn a_pinged_enemy_is_the_one_the_team_goes_for() {
        // Us (a human and a bot) to the south, facing two enemies a little apart.
        let (mut game, ids) = seated(&[(0, false), (0, true), (1, false), (1, false)]);
        let [human, mate, left, right] = ids[..] else { unreachable!() };
        stand(&mut game, mate, Vector::new(0.0, 0.1, 40.0), Vector::new(0.0, 2.0, 0.0));
        stand(&mut game, left, Vector::new(-4.0, 0.1, 20.0), Vector::new(0.0, 2.0, 40.0));
        stand(&mut game, right, Vector::new(3.0, 0.1, 18.0), Vector::new(0.0, 2.0, 40.0));
        game.step();
        let first = bot(&game, mate).focus();
        game.step();
        assert_eq!(bot(&game, mate).focus(), first, "changed its mind unpinged");
        // The one it doesn't go for, pinged, is the one it does.
        let other = if first == Some(left) { right } else { left };
        let target = chest(&game, other);
        stand(&mut game, human, Vector::new(8.0, 0.1, 44.0), target);
        game.ping(human, false);
        game.step();
        game.step();
        assert_eq!(bot(&game, mate).focus(), Some(other), "didn't switch to the pinged enemy");
        let pinged = |game: &Game, id| game.snapshot(id).events.iter().any(|e| matches!(e, Event::Ping { from, mark: Mark::Enemy(e), .. } if *from == human && *e == other));
        assert!(pinged(&game, human), "our team never heard the ping");
        assert!(!pinged(&game, left), "the other team heard our ping");
    }

    #[test]
    fn a_ping_marks_an_enemy_where_the_pinger_saw_it() {
        let (mut game, ids) = seated(&[(0, false), (1, false)]);
        let [human, enemy] = ids[..] else { unreachable!() };
        stand(&mut game, enemy, Vector::new(0.0, 0.1, 10.0), Vector::new(0.0, 2.0, 40.0));
        for _ in 0..4 {
            game.step();
        }
        // Seen at its old spot, a few ticks back: it has since stepped well off the aim.
        let (seen_at, aim) = (game.tick as f32 - 3.0, chest(&game, enemy));
        stand(&mut game, human, Vector::new(0.0, 0.1, 40.0), aim);
        player(&mut game, enemy).mech.pos.x += 8.0;
        let m = player(&mut game, human).mech;
        game.push_input(human, InputMsg { seq: 1, input: crate::Input { yaw: m.yaw, pitch: m.pitch, ..Default::default() }, view_tick: seen_at });
        game.ping(human, false);
        game.step();
        game.step();
        assert!(game.snapshot(human).events.iter().any(|e| matches!(e, Event::Ping { mark: Mark::Enemy(e), .. } if *e == enemy)), "the ping missed the enemy it was aimed at");
    }

    #[test]
    fn an_enemy_sighted_marks_the_spot_and_sets_bots_on_the_enemy_by_it() {
        // An enemy behind the block at (10, 22); the human marks the block's face, short of it.
        let (mut game, ids) = seated(&[(0, false), (0, true), (1, false)]);
        let [human, mate, enemy] = ids[..] else { unreachable!() };
        stand(&mut game, mate, Vector::new(-20.0, 0.1, 40.0), Vector::new(-20.0, 2.0, 0.0));
        stand(&mut game, enemy, Vector::new(10.0, 0.1, 17.0), Vector::new(10.0, 2.0, 40.0));
        let face = Vector::new(10.0, 1.5, 25.0);
        stand(&mut game, human, Vector::new(10.0, 0.1, 40.0), face);
        let marks = |game: &Game| game.snapshot(human).events.iter().filter_map(|e| match *e { Event::Ping { mark, at, .. } => Some((mark, at)), _ => None }).collect::<Vec<_>>();
        game.step();
        assert!(!bot(&game, mate).knows(enemy), "saw the enemy for itself");
        game.ping(human, true);
        game.step();
        game.step();
        let [(Mark::Sighted, at)] = marks(&game)[..] else { panic!("not marked as sighted: {:?}", marks(&game)) };
        assert!(at.distance(face) < 1.0, "marked {at:?}, not the face it aimed at");
        assert!(bot(&game, mate).knows(enemy), "the bot wasn't told of the enemy by the mark");
        assert_eq!(bot(&game, mate).order, None, "a sighting sent the bot like a spot to go to");
        // The same aim on Z is a spot to go to, and keeps the sighting.
        for _ in 0..secs(PING_GAP) {
            game.step();
        }
        game.ping(human, false);
        game.step();
        game.step();
        assert!(matches!(marks(&game)[..], [(Mark::Spot, _)]));
        assert!(bot(&game, mate).order.is_some());
        assert_eq!(game.squad.pings.iter().map(|g| g.mark).collect::<Vec<_>>(), [Mark::Sighted, Mark::Spot]);
    }

    #[test]
    fn a_pinged_spot_sends_the_nearest_two_free_bots_for_a_while() {
        let (mut game, ids) = seated(&[(0, false), (0, true), (0, true), (0, true)]);
        let [human, a, b, c] = ids[..] else { unreachable!() };
        let spot = Vector::new(0.0, 0.0, 30.0);
        stand(&mut game, human, Vector::new(0.0, 0.1, 45.0), spot);
        for (id, x) in [(a, 10.0), (b, -20.0), (c, 40.0)] {
            stand(&mut game, id, Vector::new(x, 0.1, 30.0), spot);
        }
        game.ping(human, false);
        game.step();
        game.step();
        let order = |game: &Game, id| bot(game, id).order;
        let sent = order(&game, a).expect("the nearest bot wasn't sent");
        assert!(sent.distance(spot) < 1.0, "sent to {sent:?}, not {spot:?}");
        assert_eq!((order(&game, b), order(&game, c)), (Some(sent), None));
        assert!(game.snapshot(human).events.iter().any(|e| matches!(e, Event::Callout { from, call: Call::OnMyWay, .. } if *from == a)));
        for _ in 0..secs(PING_ORDER) {
            game.step();
        }
        assert_eq!(order(&game, a), None, "still holding the spot after the ping ran out");
    }

    #[test]
    fn bots_mark_an_enemy_as_it_turns_up_not_while_it_stays_in_view() {
        let (mut game, ids) = seated(&[(0, false), (0, true), (1, false)]);
        let [human, mate, enemy] = ids[..] else { unreachable!() };
        stand(&mut game, mate, Vector::new(0.0, 0.1, 40.0), Vector::new(0.0, 2.0, 0.0));
        stand(&mut game, enemy, Vector::new(0.0, 0.1, 20.0), Vector::new(0.0, 2.0, 40.0));
        let (mut words, mut marks, mut theirs) = (0, 0, 0);
        for k in 0..secs(20.0) {
            // Out of everyone's sight for MARK_AFTER, half way through: it turns up again.
            if k == secs(10.0) {
                game.squad.seen[0][usize::from(enemy)] = Some(game.tick - secs(MARK_AFTER));
            }
            let m = player(&mut game, enemy).mech;
            let full = game.arsenal.of(&m).health_max;
            player(&mut game, enemy).mech.health = full; // the bot's fire never takes it down
            game.step();
            for e in game.snapshot(human).events {
                match e {
                    Event::Callout { from, call: Call::Contact(e), .. } if from == mate && e == enemy => words += 1,
                    Event::Callout { call: Call::Spotted(e), .. } if e == enemy => marks += 1,
                    _ => {}
                }
            }
            theirs += game.snapshot(enemy).events.iter().filter(|e| matches!(e, Event::Callout { .. })).count();
        }
        assert_eq!((words, marks, theirs), (1, 1, 0), "contacts in words, marks as it turned up again, and calls the other side heard");
    }

    #[test]
    fn a_bot_falling_back_hurt_calls_for_help() {
        let (mut game, ids) = seated(&[(0, false), (0, true), (1, false)]);
        let [human, mate, enemy] = ids[..] else { unreachable!() };
        stand(&mut game, mate, Vector::new(0.0, 0.1, 40.0), Vector::new(0.0, 2.0, 0.0));
        stand(&mut game, enemy, Vector::new(0.0, 0.1, 20.0), Vector::new(0.0, 2.0, 40.0));
        let m = player(&mut game, mate).mech;
        player(&mut game, mate).mech.health = 0.2 * game.arsenal.of(&m).health_max;
        game.squad.seen[0][usize::from(enemy)] = Some(0); // known already: no contact called first
        let mut helped = 0;
        for _ in 0..secs(2.0) {
            game.step();
            helped += game.snapshot(human).events.iter().filter(|e| matches!(e, Event::Callout { from, call: Call::Help, .. } if *from == mate)).count();
        }
        assert_eq!(helped, 1);
    }

    #[test]
    fn a_flag_carrier_down_is_called_by_the_nearest_bot_each_side() {
        let (mut game, ids) = seated(&[(0, false), (0, true), (0, true), (1, false), (1, true)]);
        let [_, near, far, carrier, theirs] = ids[..] else { unreachable!() };
        for (id, x) in [(near, 10.0), (far, 50.0), (carrier, 0.0), (theirs, -30.0)] {
            player(&mut game, id).mech.pos = Vector::new(x, 0.1, 0.0);
        }
        // Team 1's carrier, with team 0's flag, falls.
        game.events.push(Event::Flag { team: 0, what: Happened::Dropped, by: Some(carrier) });
        game.step_squad();
        let calls: Vec<(u8, Call)> = game.events.iter().filter_map(|e| match *e { Event::Callout { from, call, .. } => Some((from, call)), _ => None }).collect();
        assert_eq!(calls, [(near, Call::CarrierDown { ours: false }), (theirs, Call::CarrierDown { ours: true })]);
    }
}
