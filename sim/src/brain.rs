//! A bot's choices as data a balance run can evolve (`balance/evolve.py`). Each choice is a block
//! of rules: the block fires when any rule scores 0.5 or more, and a rule scores the product of its
//! considerations, each a feature read off the moment through a curve. Steps say yes or no;
//! logistic curves let evolution soften them. `Brain::default` is genome 0: today's hand-written
//! bot, its curves steps at the old thresholds, so it plays exactly as before.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a rule can read. Shares are of the max; flags are 0 or 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    /// Fighting an enemy in view; falling back (to cover or an orb), and to mend rather than cool.
    Engaged,
    FallingBack,
    Mending,
    /// Falling back and at the spot it fell back to.
    InCover,
    /// Hull and heat, as shares; overheated; hit this tick.
    Hull,
    Heat,
    Overheated,
    Hit,
    /// Range to the target over the far edge of its band (over 1: too far to hold the band).
    Range,
    /// Firing its gun, its secondary, or letting a rocket punch go, this tick; carrying a rocket punch.
    Fire,
    AltFire,
    Striking,
    Melee,
    /// The target: jammed already, on thrusters (boosting, hovering, dodging), inside an EMP's reach.
    TargetJammed,
    TargetThrusters,
    EmpReaches,
    /// Charges of its offensive and support items.
    Throws,
    Charges,
    /// Its secondary ready, and in its useful range; its grenade off cooldown and the target in
    /// lobbing range.
    AltReady,
    GrenadeReady,
    /// The target just came into view (this tick); it holds a perch.
    FirstSight,
    Perched,
    /// Starting to fall back this tick, with room for a barrier between it and the threat.
    StartingFallBack,
    BarrierRoom,
    /// A health orb within reach (`Policy::orb_range`); the threat sees it.
    OrbNear,
    Exposed,
    /// Its limpet is down, and an enemy stands in its blast.
    LimpetOut,
    LimpetHits,
    /// Holding fire to cool off; a vent to hand (off cooldown).
    Cooling,
    VentReady,
    /// The target in its sight (a clear line), and how far off it is (m).
    TargetInSight,
    TargetDist,
    /// Enemies it has in view, and teammates alive within 20 m: how a fight stands.
    EnemiesInView,
    MatesNear,
    /// Range to the target over the near edge of its band (under 1: closer than it likes).
    RangeNear,
    /// Its role this life is to perch, with a vantage picked; it has an order to get to.
    PerchRole,
    Errand,
    /// The target's hull, as a share.
    TargetHull,
    /// Its post in this fight has cover from the target (it can cool there, out of sight).
    PostCovered,
    /// With no enemy in view: a teammate is fighting one near enough to back up.
    HasTrade,
    /// With no enemy in view: it has an order, an urgent contact (seen, felt, or heard close), any
    /// contact, a lead; and how far off its lead is (m; a long way with none).
    HasOrder,
    HasUrgent,
    HasContact,
    HasLead,
    LeadDist,
}

/// How many features there are.
const FEATURES: usize = Feature::LeadDist as usize + 1;

/// What a bot can do that a rule decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    // Offensive items.
    Grenade,
    Limpet,
    Smoke,
    Turret,
    // Support items.
    Emp,
    Orb,
    Dome,
    Barrier,
    // With no enemy in view, tried in this order (the first it wants is where it goes, else it
    // patrols): its order, a teammate's fight, an urgent contact, its lead when far off, any
    // contact, its lead.
    GoToOrder,
    Trade,
    ChaseUrgent,
    Regroup,
    ChaseContact,
    Follow,
    // In a fight: go on along the route (to the target, a perch, or its order), and back off
    // inside the band; otherwise it strafes, holding the band.
    Push,
    BackOff,
    // Falling back: to mend, to cool off, and done with it (back to the fight).
    FallBackToMend,
    FallBackToCool,
    StopFallingBack,
    // Abilities.
    Slipstream,
    Vent,
    Brace,
    Cloak,
    Power,
    Barrage,
    Artillery,
}

/// How a feature's value scores, 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Curve {
    /// 1 if the value is below, at most, above, or at least the threshold; else 0.
    Below(f32),
    AtMost(f32),
    Above(f32),
    AtLeast(f32),
    /// A smooth step up (or down) through `mid`, `steep` per unit.
    Rising { mid: f32, steep: f32 },
    Falling { mid: f32, steep: f32 },
}

impl Curve {
    pub fn score(self, x: f32) -> f32 {
        let logistic = |z: f32| 1.0 / (1.0 + libm::expf(-z));
        match self {
            Curve::Below(a) => f32::from(u8::from(x < a)),
            Curve::AtMost(a) => f32::from(u8::from(x <= a)),
            Curve::Above(a) => f32::from(u8::from(x > a)),
            Curve::AtLeast(a) => f32::from(u8::from(x >= a)),
            Curve::Rising { mid, steep } => logistic(steep * (x - mid)),
            Curve::Falling { mid, steep } => logistic(-steep * (x - mid)),
        }
    }
}

/// A feature through a curve.
pub type Consideration = (Feature, Curve);
/// Considerations that must all hold.
pub type Rule = Vec<Consideration>;

/// Every block of rules, by action. An action with no block never fires.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Brain(pub BTreeMap<Action, Vec<Rule>>);

/// The values of every feature at one moment.
#[derive(Clone, Copy, Debug)]
pub struct Features([f32; FEATURES]);

impl Default for Features {
    fn default() -> Self {
        Features([0.0; FEATURES])
    }
}

impl Features {
    pub fn set(&mut self, f: Feature, value: f32) -> &mut Self {
        self.0[f as usize] = value;
        self
    }
    pub fn flag(&mut self, f: Feature, on: bool) -> &mut Self {
        self.set(f, f32::from(u8::from(on)))
    }
    pub fn get(&self, f: Feature) -> f32 {
        self.0[f as usize]
    }
}

impl Action {
    /// The action for an ability.
    pub fn of_ability(a: crate::ability::Ability) -> Action {
        use crate::ability::Ability;
        match a {
            Ability::Slipstream => Action::Slipstream,
            Ability::Vent => Action::Vent,
            Ability::Brace => Action::Brace,
            Ability::Cloak => Action::Cloak,
            Ability::Power => Action::Power,
            Ability::Barrage => Action::Barrage,
            Ability::Artillery => Action::Artillery,
        }
    }

    /// The action for a support item (none for one bots don't set off with the EMP key).
    pub fn of_support(item: crate::item::Item) -> Option<Action> {
        use crate::item::Item;
        match item {
            Item::Emp => Some(Action::Emp),
            Item::Orb => Some(Action::Orb),
            Item::Dome => Some(Action::Dome),
            _ => None,
        }
    }
}

impl Brain {
    /// Whether `action` fires at the moment `at`: some rule of its scores 0.5 or more.
    pub fn wants(&self, action: Action, at: &Features) -> bool {
        self.0.get(&action).is_some_and(|rules| rules.iter().any(|rule| rule.iter().map(|&(f, c)| c.score(at.get(f))).product::<f32>() >= 0.5))
    }
}

impl Default for Brain {
    /// Genome 0: the hand-written rules, as they were.
    fn default() -> Self {
        use Curve::*;
        use Feature::*;
        let yes = |f: Feature| (f, Above(0.5));
        let no = |f: Feature| (f, AtMost(0.5));
        let engaged = || vec![yes(Engaged)];
        let back = || vec![yes(FallingBack)];
        let with = |mut rule: Rule, more: &[Consideration]| {
            rule.extend_from_slice(more);
            rule
        };
        let rules = [
            // With no enemy in view: its order first; then a teammate's fight to back up; an urgent
            // contact; its lead if more than 30 m off; any contact; its lead.
            (Action::GoToOrder, vec![vec![yes(HasOrder)]]),
            (Action::Trade, vec![vec![yes(HasTrade)]]),
            (Action::ChaseUrgent, vec![vec![yes(HasUrgent)]]),
            (Action::Regroup, vec![vec![yes(HasLead), (LeadDist, Above(30.0))]]),
            (Action::ChaseContact, vec![vec![yes(HasContact)]]),
            (Action::Follow, vec![vec![yes(HasLead)]]),
            // Far off, keep walking the route (firing on the way); perches keep climbing, a bot
            // cooling off repositions, and one with an order keeps going. Too close: back off.
            (
                Action::Push,
                vec![with(engaged(), &[(Range, Above(1.0))]), with(engaged(), &[yes(PerchRole)]), with(engaged(), &[yes(Cooling)]), with(engaged(), &[yes(Errand)])],
            ),
            (Action::BackOff, vec![with(engaged(), &[(RangeNear, Below(1.0))])]),
            // Badly hurt, or too hot with no vent to hand and no cover at its post: fall back, to
            // an orb or out of sight.
            (Action::FallBackToMend, vec![with(engaged(), &[(Hull, Below(0.35))])]),
            (Action::FallBackToCool, vec![with(engaged(), &[yes(Cooling), no(VentReady), no(PostCovered)])]),
            // Mended, or cooled; or cornered: an enemy in sight this close.
            (
                Action::StopFallingBack,
                vec![
                    vec![yes(Mending), (Hull, AtLeast(0.9))],
                    vec![no(Mending), no(Overheated), (Heat, AtMost(0.4))],
                    vec![yes(TargetInSight), (TargetDist, Below(15.0))],
                ],
            ),
            // A grenade every few seconds at a target in lobbing range while the secondary isn't
            // taking the aim; a turret as a fight starts, or to hold a perch.
            (Action::Grenade, vec![with(engaged(), &[no(AltReady), (Throws, Above(0.0)), yes(GrenadeReady)])]),
            (Action::Turret, vec![with(engaged(), &[(Throws, Above(0.0)), yes(FirstSight)]), with(engaged(), &[(Throws, Above(0.0)), yes(Perched)])]),
            // An EMP when it would land on one not jammed already, and it counts: they're on
            // thrusters (it grounds them), or we're hurt (it slows pursuit).
            (
                Action::Emp,
                vec![
                    with(engaged(), &[(Charges, Above(0.0)), no(TargetJammed), yes(EmpReaches), yes(TargetThrusters)]),
                    with(engaged(), &[(Charges, Above(0.0)), no(TargetJammed), yes(EmpReaches), (Hull, Below(0.5))]),
                ],
            ),
            // A shield dome once hurt and under fire, and when hit falling back.
            (Action::Dome, vec![with(engaged(), &[(Charges, Above(0.0)), yes(Hit), (Hull, Below(0.6))]), with(back(), &[(Charges, Above(0.0)), yes(Hit)])]),
            // A barrier raised toward the threat as the bot falls back, if there's room for it.
            (Action::Barrier, vec![vec![yes(StartingFallBack), (Charges, Above(0.0)), yes(BarrierRoom)]]),
            // Speed boost to close on a far target, or to get away to mend.
            (Action::Slipstream, vec![with(engaged(), &[(Range, Above(1.0))]), with(back(), &[yes(Mending), no(InCover)])]),
            // Vent before stalling, or once overheated falling back.
            (Action::Vent, vec![with(engaged(), &[yes(Overheated)]), with(engaged(), &[(Heat, AtLeast(0.8))]), with(back(), &[yes(Overheated)])]),
            // The bulwark once hurt and under fire, or hit falling back to mend.
            (Action::Brace, vec![with(engaged(), &[yes(Hit), (Hull, Below(0.75))]), with(back(), &[yes(Mending), yes(Hit)])]),
            // Camouflage for slipping away to mend, or for closing unseen on a target beyond the
            // band while still in shape to fight.
            (Action::Cloak, vec![with(back(), &[yes(Mending), no(InCover)]), with(engaged(), &[(Range, Above(1.2)), (Hull, AtLeast(0.6))])]),
            // Power up a volley as it goes (a rocket punch: its strike); boost a fight on target in range.
            (Action::Power, vec![with(engaged(), &[yes(Melee), yes(Striking)]), with(engaged(), &[no(Melee), yes(AltFire)])]),
            (Action::Barrage, vec![with(engaged(), &[yes(Fire), (Range, AtMost(1.0))])]),
            (Action::Artillery, vec![with(engaged(), &[yes(Fire), (Range, AtMost(1.0))])]),
            // A Salve dropped when hurt with no orb in reach, fighting or falling back to mend.
            (Action::Orb, vec![with(engaged(), &[(Charges, Above(0.0)), (Hull, Below(0.5)), no(OrbNear)]), with(back(), &[yes(Mending), (Charges, Above(0.0)), no(OrbNear)])]),
            // A Pall thrown toward the threat while falling back in its sight, short of cover.
            (Action::Smoke, vec![with(back(), &[(Throws, Above(0.0)), yes(Exposed), no(InCover), yes(GrenadeReady)])]),
            // A limpet stuck on the target in lobbing range, then set off once an enemy's in its blast.
            (Action::Limpet, vec![with(engaged(), &[no(AltReady), (Throws, Above(0.0)), no(LimpetOut), yes(GrenadeReady)]), vec![yes(LimpetOut), yes(LimpetHits)]]),
        ];
        Brain(rules.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_fire_on_any_rule_and_every_consideration() {
        let brain = Brain::default();
        let mut at = Features::default();
        at.flag(Feature::Engaged, true).set(Feature::Charges, 1.0).flag(Feature::Hit, true).set(Feature::Hull, 0.7);
        assert!(!brain.wants(Action::Dome, &at), "domed while still above 60%");
        at.set(Feature::Hull, 0.5);
        assert!(brain.wants(Action::Dome, &at));
        at.set(Feature::Charges, 0.0);
        assert!(!brain.wants(Action::Dome, &at), "domed with no charge");
        assert!(!brain.wants(Action::Limpet, &at), "no block, no limpet");
        // A soft curve scores between.
        let soft = Curve::Falling { mid: 0.6, steep: 20.0 };
        assert!(soft.score(0.6) == 0.5 && soft.score(0.3) > 0.99 && soft.score(0.9) < 0.01);
        // Genome 0 reads and writes back the same.
        let json = serde_json::to_string(&brain).unwrap();
        assert_eq!(serde_json::from_str::<Brain>(&json).unwrap(), brain);
    }
}
