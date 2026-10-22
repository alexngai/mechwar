// Debug overlay for tuning: every blast's reach as a fading wire sphere, each shell's flight
// path with its time and range in a log, and mech hit capsules. Toggled from the tuning panel.
import * as THREE from 'three';

const BLAST_LIFE = 1.5, TRAIL_LIFE = 3, LOG_LINES = 8; // s, s, lines
const wire = (color) => new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, depthWrite: false });
const blastMat = wire(0xff7040), capsuleMat = wire(0x6dd4ff);
const trailMat = new THREE.LineBasicMaterial({ color: 0xffe070, transparent: true });

export class Debug {
  /** `log` is the element that lists recent shells and blasts. */
  constructor(scene, log) {
    this.scene = scene;
    this.log = log;
    this.on = false;
    this.blasts = [];
    this.trails = new Map(); // live shells by key: { name, points, age, line }
    this.ended = []; // finished trails, fading out
    this.capsules = []; // pooled, reused each frame
    this.used = 0;
    this.lines = [];
    this.geometries = new Map(); // capsule geometry by size
  }

  setOn(on) {
    this.on = on;
    this.log.hidden = !on;
    if (on) return;
    for (const o of [...this.blasts, ...this.ended, ...this.trails.values()]) this.drop(o.mesh ?? o.line);
    for (const c of this.capsules) c.visible = false;
    this.blasts = [];
    this.ended = [];
    this.trails.clear();
  }

  /** A blast of `radius` at `pos`. */
  blast(pos, radius) {
    if (!this.on) return;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 12), blastMat.clone());
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.blasts.push({ mesh, life: BLAST_LIFE });
    this.note(`blast    r ${radius.toFixed(1)} m`);
  }

  /** Shell `key` (a `name`d weapon's) is at `pos`, `age` seconds into its flight. */
  shell(key, name, pos, age) {
    if (!this.on) return;
    let t = this.trails.get(key);
    if (!t) {
      t = { name, points: [], age: 0, line: new THREE.Line(new THREE.BufferGeometry(), trailMat.clone()) };
      t.line.frustumCulled = false;
      this.scene.add(t.line);
      this.trails.set(key, t);
    }
    t.points.push(pos.clone());
    t.age = age;
    t.line.geometry.dispose();
    t.line.geometry = new THREE.BufferGeometry().setFromPoints(t.points);
  }

  /** Shells missing from `live` have burst: log their flight and let their paths fade. */
  endShells(live) {
    for (const [key, t] of this.trails) {
      if (live.has(key)) continue;
      this.trails.delete(key);
      const range = t.points[0].distanceTo(t.points.at(-1));
      this.note(`${t.name.padEnd(8)} ${t.age.toFixed(2)} s  ${range.toFixed(1)} m`);
      this.ended.push({ line: t.line, life: TRAIL_LIFE });
    }
  }

  /** A hit capsule `radius` wide and `height` tall standing at `pos` (feet), this frame. */
  hitbox(pos, radius, height) {
    if (!this.on) return;
    const size = `${radius}:${height}`;
    if (!this.geometries.has(size)) this.geometries.set(size, new THREE.CapsuleGeometry(radius, Math.max(height - 2 * radius, 0), 4, 12));
    let c = this.capsules[this.used];
    if (!c) this.scene.add((c = this.capsules[this.used] = new THREE.Mesh(undefined, capsuleMat)));
    c.geometry = this.geometries.get(size);
    c.position.copy(pos).y += height / 2;
    c.visible = true;
    this.used++;
  }

  /** Fades blasts and finished paths; hides capsules not placed since the last update. */
  update(dt) {
    for (const list of [this.blasts, this.ended]) {
      for (const o of list) {
        o.life -= dt;
        (o.mesh ?? o.line).material.opacity = Math.max(o.life, 0) / (o.mesh ? BLAST_LIFE : TRAIL_LIFE);
        if (o.life <= 0) this.drop(o.mesh ?? o.line);
      }
    }
    this.blasts = this.blasts.filter((o) => o.life > 0);
    this.ended = this.ended.filter((o) => o.life > 0);
    for (let i = this.used; i < this.capsules.length; i++) this.capsules[i].visible = false;
    this.used = 0;
  }

  note(text) {
    this.lines = [text, ...this.lines].slice(0, LOG_LINES);
    this.log.textContent = this.lines.join('\n');
  }

  drop(object) {
    this.scene.remove(object);
    object.geometry.dispose();
    object.material.dispose();
  }
}
