// Touch controls for phones and tablets: a stick wherever the left thumb lands, look by dragging
// anywhere else (the fire button too, to aim while firing), optional gyro aim, and buttons that
// press the same keys and mouse buttons the keyboard and mouse do: main.js takes them as typed or
// clicked. They come on with the first touch (or ?touch) and show in the arena, not the hangar or menu.

// [label, what it presses (a KeyboardEvent code, a mouse button) or does ('dash', 'target'), where, size in px]
const BUTTONS = [
  ['FIRE', 0, 'right:28px;bottom:28px', 92],
  ['ALT', 2, 'right:142px;bottom:42px', 64],
  ['DASH', 'dash', 'right:117px;bottom:117px', 56],
  ['HOVER', 'Space', 'right:42px;bottom:142px', 64],
  ['LOCK', 1, 'right:208px;bottom:110px', 52],
  ['TARGET', 'target', 'right:196px;bottom:168px', 52],
  ['R', 'KeyR', 'right:24px;bottom:228px', 46],
  ['F', 'KeyF', 'right:78px;bottom:228px', 46],
  ['E', 'KeyE', 'right:132px;bottom:228px', 46],
  ['Q', 'KeyQ', 'right:186px;bottom:228px', 46],
  ['☰', 'Escape', 'left:12px;top:12px', 44],
  ['SCORE', 'Tab', 'left:12px;top:62px', 44],
  ['PING', 'KeyZ', 'left:12px;top:112px', 44],
];
const DEG = Math.PI / 180;
const PREFS = 'mechwar.touch';

const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code }));
const press = (what, down) => (typeof what === 'number'
  ? dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button: what }))
  : key(down ? 'keydown' : 'keyup', what));

/**
 * Builds the controls: `look(dYaw, dPitch)` (rad, left and up positive) turns the view, `target()`
 * toggles the lock-on, and `tune(name)` reads tuning.json's touch group (touch_look: rad per px
 * dragged at look speed 1; touch_gyro: view turn per device turn; touch_stick: px from the stick's
 * centre to full speed; touch_boost_at: how far past its rim, in stick radii, pushing forward
 * boosts). Returns the pad main.js reads: `on`, the stick (`x` right, `z` forward, -1 to 1) and
 * the options.
 */
export function touchControls({ look, target, tune }) {
  const pad = { on: false, x: 0, z: 0, assist: true, gyro: false, speed: 1 };
  try {
    const { assist, gyro, speed } = JSON.parse(localStorage.getItem(PREFS)) ?? {};
    Object.assign(pad, { assist: assist ?? pad.assist, gyro: gyro ?? pad.gyro, speed: speed ?? pad.speed });
  } catch { /* none saved, or private mode */ }

  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = '<div class="stick"><i></i></div>'
    + BUTTONS.map(([label, what, at, size], i) => `<button data-i="${i}" data-press="${what}" style="${at};width:${size}px;height:${size}px">${label}</button>`).join('');
  document.body.append(root);
  const base = root.firstChild, knob = base.firstChild;

  const turnOn = () => {
    pad.on = true;
    document.body.classList.add('touch');
  };
  if (new URLSearchParams(location.search).has('touch')) turnOn();
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !pad.on) turnOn(); }, true);

  // Fingers down by pointer id: on the stick, looking, and/or holding a button.
  const fingers = new Map();
  let boosting = false;
  const boost = (on) => { if (on !== boosting) key((boosting = on) ? 'keydown' : 'keyup', 'ShiftLeft'); };
  // Shift and the stick's direction, as on the keyboard: sideways dashes, back turns about.
  const dash = () => {
    const code = Math.abs(pad.x) > 0.3 ? (pad.x < 0 ? 'KeyA' : 'KeyD') : pad.z < -0.3 ? 'KeyS' : null;
    if (!code) return;
    if (!boosting) key('keydown', 'ShiftLeft');
    key('keydown', code);
    key('keyup', code);
    if (!boosting) key('keyup', 'ShiftLeft');
  };
  const taps = { dash, target }; // buttons that act on the tap, not while held

  root.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no mouse events after it, no zoom or scroll
    const f = { x: e.clientX, y: e.clientY }, button = e.target.closest('button');
    if (button) {
      const what = BUTTONS[button.dataset.i][1];
      button.classList.add('on');
      f.button = button;
      f.look = what === 0;
      if (taps[what]) taps[what]();
      else press(what, true);
    } else if (e.clientX < innerWidth * 0.45) {
      const r = root.getBoundingClientRect(), radius = tune('touch_stick');
      f.stick = { x: e.clientX, y: e.clientY, radius };
      base.classList.add('on');
      base.style.left = `${e.clientX - r.left - radius}px`;
      base.style.top = `${e.clientY - r.top - radius}px`;
      base.style.width = base.style.height = `${2 * radius}px`;
    } else f.look = true;
    fingers.set(e.pointerId, f);
  });
  addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    const k = tune('touch_look') * pad.speed;
    if (f.look) look(-(e.clientX - f.x) * k, -(e.clientY - f.y) * k);
    f.x = e.clientX;
    f.y = e.clientY;
    if (f.stick) {
      const { radius } = f.stick, dx = (f.x - f.stick.x) / radius, dy = (f.y - f.stick.y) / radius, d = Math.hypot(dx, dy), cap = d > 1 ? 1 / d : 1;
      pad.x = dx * cap;
      pad.z = -dy * cap;
      knob.style.translate = `${pad.x * radius}px ${-pad.z * radius}px`;
      boost(d > tune('touch_boost_at') && -dy > 0.7 * d);
    }
  });
  const lift = (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    if (f.button) {
      f.button.classList.remove('on');
      const what = BUTTONS[f.button.dataset.i][1];
      if (!taps[what]) press(what, false);
    }
    if (f.stick) {
      pad.x = pad.z = 0;
      boost(false);
      base.classList.remove('on');
      base.removeAttribute('style');
      knob.style.translate = '';
    }
  };
  addEventListener('pointerup', lift);
  addEventListener('pointercancel', lift);

  // Gyro aim: the device's turn rate, in the screen's frame (it may be held either way round).
  let gyroAt = 0;
  addEventListener('devicemotion', (e) => {
    const r = e.rotationRate, dt = Math.min((e.timeStamp - gyroAt) / 1000, 0.1);
    gyroAt = e.timeStamp;
    if (!pad.gyro || !r || r.beta == null || !root.getClientRects().length) return;
    const a = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG, s = Math.sin(a), c = Math.cos(a);
    const k = DEG * tune('touch_gyro') * dt, b = r.beta * k, g = r.gamma * k;
    look(b * s + g * c, g * s - b * c);
  });

  // The options, on the hangar's and menu's settings (shown once touch is on).
  const save = () => { try { localStorage.setItem(PREFS, JSON.stringify({ assist: pad.assist, gyro: pad.gyro, speed: pad.speed })); } catch { /* private mode */ } };
  const assist = document.getElementById('assist'), gyro = document.getElementById('gyro'), speed = document.getElementById('look-speed');
  assist.checked = pad.assist;
  gyro.checked = pad.gyro;
  speed.value = pad.speed;
  assist.addEventListener('change', () => { pad.assist = assist.checked; save(); });
  speed.addEventListener('input', () => { pad.speed = Number(speed.value); save(); });
  gyro.addEventListener('change', async () => {
    // iOS asks first, from the tap.
    const ok = !gyro.checked || (await globalThis.DeviceMotionEvent?.requestPermission?.().catch(() => 'denied')) !== 'denied';
    pad.gyro = gyro.checked = gyro.checked && ok;
    save();
  });
  return pad;
}
