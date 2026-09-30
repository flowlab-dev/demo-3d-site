// The rules behind the page: how the box opens with scroll, quality steps,
// count-up, the form, theme and tilt.
//
//   node --test tests/logic.test.js      (or: npm test)

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../demo/assets/logic.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('closed at the start of the section: every layer at rest, no step yet', () => {
  const a = L.anatomy(0);
  assert.equal(a.explode, 0);
  assert.equal(a.step, -1);
  a.offsets.forEach((y, i) => close(y, L.LAYERS[i].rest));
});

test('fully open once the opening phase ends, and stays open', () => {
  for (const p of [L.OPEN_END, 0.5, 1]) {
    const a = L.anatomy(p);
    close(a.explode, 1);
    a.offsets.forEach((y, i) => close(y, L.LAYERS[i].rest + L.LAYERS[i].open));
  }
});

test('opening is smooth and only ever moves layers outwards', () => {
  let prev = L.anatomy(0);
  for (let p = 0.01; p <= L.OPEN_END + 1e-9; p += 0.01) {
    const a = L.anatomy(p);
    assert.ok(a.explode >= prev.explode, `explode never goes back at ${p}`);
    a.offsets.forEach((y, i) => {
      const dir = Math.sign(L.LAYERS[i].open);
      assert.ok((y - prev.offsets[i]) * dir >= -1e-12, `layer ${i} moves outwards at ${p}`);
    });
    prev = a;
  }
});

test('the four steps split the rest of the section equally, in layer order', () => {
  L.LAYERS.forEach((_, i) => {
    assert.equal(L.anatomy(L.stepStart(i) + 0.001).step, i);
    if (i > 0) assert.equal(L.anatomy(L.stepStart(i) - 0.001).step, i - 1);
  });
  assert.equal(L.anatomy(1).step, L.LAYERS.length - 1);
  close(L.STEP_SPAN * L.LAYERS.length + L.OPEN_END, 1);
});

test('progress outside 0..1 is clamped', () => {
  assert.deepEqual(L.anatomy(-3), L.anatomy(0));
  assert.deepEqual(L.anatomy(7), L.anatomy(1));
});

test('opened layers do not overlap: each sits clear of the next one', () => {
  // Half-heights of each part in scene units (shell, core cloud, board with chips, cooling with fins)
  const half = { shell: 0.95, core: 0.5, board: 0.07, cooling: 0.2 };
  const open = L.anatomy(1).offsets;
  for (let i = 0; i < L.LAYERS.length - 1; i++) {
    const upperBottom = open[i] - half[L.LAYERS[i].id];
    const lowerTop = open[i + 1] + half[L.LAYERS[i + 1].id];
    assert.ok(upperBottom > lowerTop, `${L.LAYERS[i].id} clears ${L.LAYERS[i + 1].id}`);
  }
});

test('blending between the hero and "Inside" anchors eases from one to the other', () => {
  const a = { x: 900, y: 400, w: 400, h: 500 };
  const b = { x: 900, y: 450, w: 500, h: 560 };
  assert.deepEqual(L.blendAnchors(a, b, 0), a);
  assert.deepEqual(L.blendAnchors(a, b, 1), b);
  const mid = L.blendAnchors(a, b, 0.5);
  close(mid.y, 425);
  close(mid.h, 530);
  close(mid.w, 450);
});

test('start quality follows the device', () => {
  assert.equal(L.startQuality({ width: 1440, dpr: 2, cores: 8, touch: false }), 'high');
  assert.equal(L.startQuality({ width: 1280, dpr: 1, cores: 2, touch: false }), 'medium');
  assert.equal(L.startQuality({ width: 390, dpr: 3, cores: 6, touch: true }), 'medium');
  assert.equal(L.startQuality({ width: 390, dpr: 2, cores: 4, touch: true }), 'low');
  assert.equal(L.startQuality({ width: 700, dpr: 1, cores: 8, touch: false }), 'low');
});

test('slow frames step quality down one level at a time and never back up', () => {
  assert.equal(L.nextQuality('high', 25), 'medium');
  assert.equal(L.nextQuality('medium', 25), 'low');
  assert.equal(L.nextQuality('low', 60), 'low');
  assert.equal(L.nextQuality('medium', 8), 'medium'); // fast frames do not raise it
  assert.equal(L.nextQuality('high', 20), 'high'); // exactly 50 fps is fine
  assert.equal(L.nextQuality('high', NaN), 'high');
});

test('quality settings cap the pixel ratio and particle count', () => {
  assert.deepEqual(L.qualitySettings('high', 3), { dpr: 2, particles: 1600 });
  assert.deepEqual(L.qualitySettings('medium', 3), { dpr: 1.5, particles: 900 });
  assert.deepEqual(L.qualitySettings('low', 3), { dpr: 1, particles: 450 });
  assert.equal(L.qualitySettings('high', 1).dpr, 1); // never above the screen's own
  assert.equal(L.qualitySettings('unknown', 2).particles, 900);
});

test('count-up starts at zero, ends exactly on the target and never overshoots', () => {
  for (const target of [128, 70, 31, 240]) {
    assert.equal(L.countValue(target, 0), 0);
    assert.equal(L.countValue(target, 1), target);
    let prev = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = L.countValue(target, t);
      assert.ok(v >= prev && v <= target, `${target} at ${t}: ${v}`);
      assert.ok(Number.isInteger(v), 'whole numbers only');
      prev = v;
    }
  }
  assert.equal(L.countValue(2.5, 1), 2.5);
  assert.equal(L.formatCount(4800), '4,800');
  assert.equal(L.formatCount(2.5, 1), '2.5');
});

test('reservation form: every field is checked, with a message for each', () => {
  assert.deepEqual(L.validateReservation({ name: 'Ada', email: 'ada@example.co.uk', team: '11-50' }), {});
  const empty = L.validateReservation({});
  assert.deepEqual(Object.keys(empty).sort(), ['email', 'name', 'team']);
  assert.equal(L.validateReservation({ name: '   ', email: 'a@b.co', team: '1-10' }).name, 'Enter your name.');
  assert.ok(L.validateReservation({ name: 'x'.repeat(81), email: 'a@b.co', team: '1-10' }).name);
  for (const bad of ['ada', 'ada@', 'ada@firm', 'ada firm@x.com', '@firm.com', 'ada@firm.c']) {
    assert.ok(L.validateReservation({ name: 'Ada', email: bad, team: '1-10' }).email, bad);
  }
  assert.equal(L.validateReservation({ name: 'Ada', email: ' ada@example.com ', team: '200+' }).email, undefined);
  assert.ok(L.validateReservation({ name: 'Ada', email: 'a@b.co', team: '5' }).team);
});

test('theme: a saved choice wins over the system, anything else follows the system', () => {
  assert.equal(L.resolveTheme('dark', false), 'dark');
  assert.equal(L.resolveTheme('light', true), 'light');
  assert.equal(L.resolveTheme(null, true), 'dark');
  assert.equal(L.resolveTheme('purple', false), 'light');
});

test('pointer and tilt turn the box only a little, whatever the input', () => {
  assert.deepEqual(L.lookAt(0, 0), { x: 0, y: 0 });
  const far = L.lookAt(50, -50);
  close(far.y, 0.35);
  close(far.x, -0.21);
  assert.equal(L.tiltToPointer(null, 10), null);
  assert.deepEqual(L.tiltToPointer(45, 0), { x: 0, y: 0 });
  assert.deepEqual(L.tiltToPointer(180, -90), { x: -1, y: 1 });
  // On its side the axes swap: tipping the top edge away is gamma, left-right is beta
  assert.deepEqual(L.tiltToPointer(0, -45, 90), { x: 0, y: 0 });
  assert.deepEqual(L.tiltToPointer(10, -45, 90), { x: 0.4, y: 0 });
  assert.deepEqual(L.tiltToPointer(10, 45, 270), { x: -0.4, y: 0 });
  assert.deepEqual(L.tiltToPointer(10, 45, -90), L.tiltToPointer(10, 45, 270));
  assert.deepEqual(L.tiltToPointer(10, 45, 0), L.tiltToPointer(10, 45));
});
