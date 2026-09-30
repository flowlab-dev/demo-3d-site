// Lantern One: the rules behind the page, with no DOM and no WebGL, so they
// can be tested in Node. The scene (scene.js) and the page (app.js) only read
// these numbers; nothing about layout, timing or quality is decided twice.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanternLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  // Smooth start and end, for motion driven by scroll position.
  const ease = (t) => {
    const x = clamp(t);
    return x * x * (3 - 2 * x);
  };

  // The four layers of the box, top to bottom. `rest` is where each sits when
  // the box is closed, `open` how far it travels in the exploded view (scene units).
  const LAYERS = [
    { id: 'shell', rest: 0, open: 1.65 },
    { id: 'core', rest: 0.05, open: 0.1 },
    { id: 'board', rest: -0.32, open: -0.55 },
    { id: 'cooling', rest: -0.62, open: -1.5 },
  ];

  // The pinned "Inside" section, as scroll progress 0..1:
  //   0.00-0.20  the box opens (explode 0 -> 1) and turns to a three-quarter view
  //   0.20-1.00  four equal steps, one per layer, in the order of LAYERS
  const OPEN_END = 0.2;
  const STEP_SPAN = (1 - OPEN_END) / LAYERS.length;

  function anatomy(progress) {
    const p = clamp(progress);
    const explode = ease(p / OPEN_END);
    const stepRaw = (p - OPEN_END) / STEP_SPAN;
    const step = p < OPEN_END ? -1 : Math.min(LAYERS.length - 1, Math.floor(stepRaw));
    return {
      explode,
      step, // -1 while the box is still opening
      turn: lerp(0, -0.6, explode) + p * 0.35, // radians around Y, keeps turning slowly
      tilt: lerp(0.05, 0.32, explode), // radians around X, looks down into the layers
      offsets: LAYERS.map((layer) => layer.rest + layer.open * explode),
    };
  }

  // Scroll progress at which each step's caption becomes current (for keyboard
  // and "jump to step" links, and for tests).
  const stepStart = (i) => OPEN_END + STEP_SPAN * i;

  // How much of its anchor box (the hero art slot, the "Inside" art slot) the
  // box fills, and how the page blends between the two anchors while scrolling.
  const FILL = 0.78;
  function blendAnchors(a, b, t) {
    const k = ease(t);
    return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
  }

  // Rendering quality. The page starts from the device guess and steps down
  // (never back up, so it cannot flicker between levels) when frames are slow.
  const QUALITY = {
    high: { maxDpr: 2, particles: 1600 },
    medium: { maxDpr: 1.5, particles: 900 },
    low: { maxDpr: 1, particles: 450 },
  };
  const ORDER = ['high', 'medium', 'low'];

  function startQuality({ width, dpr, cores, touch }) {
    if (touch || width < 760) return (cores || 4) >= 6 && dpr >= 2 ? 'medium' : 'low';
    return (cores || 4) >= 4 ? 'high' : 'medium';
  }

  // Average frame time (ms) over the last window of frames -> next level.
  // 20 ms is 50 fps: anything slower than that on average steps down one level.
  function nextQuality(level, avgFrameMs) {
    if (!(avgFrameMs > 20)) return level;
    const i = ORDER.indexOf(level);
    return ORDER[Math.min(ORDER.length - 1, i + 1)];
  }

  function qualitySettings(level, deviceDpr) {
    const q = QUALITY[level] || QUALITY.medium;
    return {
      dpr: Math.min(deviceDpr || 1, q.maxDpr),
      particles: q.particles,
    };
  }

  // Count-up for the numbers section: the value shown at time t (0..1),
  // with the same number of decimals as the target.
  function countValue(target, t) {
    const decimals = (String(target).split('.')[1] || '').length;
    const v = target * ease(t);
    return t >= 1 ? target : Number(v.toFixed(decimals));
  }

  function formatCount(value, decimals = 0) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  // Reservation form. Returns { field: message } for every problem, {} if fine.
  const TEAM_SIZES = ['1-10', '11-50', '51-200', '200+'];
  function validateReservation({ name, email, team }) {
    const errors = {};
    if (!name || !String(name).trim()) errors.name = 'Enter your name.';
    else if (String(name).trim().length > 80) errors.name = 'Use 80 characters or fewer.';
    const e = String(email || '').trim();
    if (!e) errors.email = 'Enter your work email.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) errors.email = 'Enter an email like name@company.com.';
    if (!TEAM_SIZES.includes(team)) errors.team = 'Choose your team size.';
    return errors;
  }

  // Theme: the visitor's saved choice wins, otherwise the system setting.
  function resolveTheme(saved, systemDark) {
    if (saved === 'light' || saved === 'dark') return saved;
    return systemDark ? 'dark' : 'light';
  }

  // Pointer or device tilt -> a small turn of the box, both axes in -1..1.
  function lookAt(nx, ny, strength = 0.35) {
    return { y: clamp(nx, -1, 1) * strength, x: clamp(ny, -1, 1) * strength * 0.6 };
  }

  // Device orientation (degrees) -> -1..1, with the device held at a natural
  // angle. Turned sideways, beta and gamma swap roles (angle from screen.orientation).
  function tiltToPointer(beta, gamma, angle = 0) {
    if (beta == null || gamma == null) return null;
    const a = ((angle % 360) + 360) % 360;
    if (a === 90) return { x: clamp(beta / 25, -1, 1), y: clamp((-gamma - 45) / 25, -1, 1) };
    if (a === 270) return { x: clamp(-beta / 25, -1, 1), y: clamp((gamma - 45) / 25, -1, 1) };
    return { x: clamp(gamma / 25, -1, 1), y: clamp((beta - 45) / 25, -1, 1) };
  }

  return {
    clamp, lerp, ease,
    LAYERS, OPEN_END, STEP_SPAN, anatomy, stepStart,
    FILL, blendAnchors,
    QUALITY, startQuality, nextQuality, qualitySettings,
    countValue, formatCount,
    TEAM_SIZES, validateReservation,
    resolveTheme, lookAt, tiltToPointer,
  };
});
