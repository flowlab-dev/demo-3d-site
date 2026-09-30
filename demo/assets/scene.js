// Lantern One: the 3D box. One fixed canvas behind the page; the box is drawn
// over the hero's art slot, glides into the "Inside" art slot and opens up in
// four layers as that section is scrolled (numbers from LanternLogic.anatomy).
// Anything missing (WebGL, the library) leaves the SVG drawings in place.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const L = window.LanternLogic;
const state = (window.lantern = window.lantern || {});
const root = document.documentElement;
const canvas = document.getElementById('scene');
const heroArt = document.querySelector('.hero__art');
const insideArt = document.querySelector('.inside__art');
const heroSection = document.querySelector('.hero');
const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const debug = (window.lanternDebug = {
  ready: false, error: null, quality: null, avgFrameMs: 0, frames: 0, renders: 0,
  layers: () => layerMeshes.map((g) => ({ y: +g.position.y.toFixed(3), z: +g.position.z.toFixed(3) })),
  holder: () => ({ x: +holder.position.x.toFixed(3), y: +holder.position.y.toFixed(3), scale: +holder.scale.x.toFixed(3) }),
  // Where the box is drawn, in page pixels (for layout tests)
  screenBox: () => {
    // The silhouette of the solid parts (glass, frame, board, cooling): their
    // vertices projected to the screen, glow and particles left out
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    const v = new THREE.Vector3();
    let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity;
    box.updateWorldMatrix(true, true);
    box.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(camera);
        const x = (v.x + 1) / 2 * w; const y = (1 - v.y) / 2 * h;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    });
    return { left, right, top, bottom };
  },

});

const AMBER = new THREE.Color('#F0A93B');
const CLOSED_HEIGHT = 1.9;
const OPEN_HEIGHT = 4.85; // top of the lifted shell to the bottom of the lowered cooling
const OPEN_CENTRE = 0.18; // the exploded stack is a little taller above than below
const TURNED_WIDTH = 1.95; // width of the box on screen at its usual three-quarter turn

let renderer, scene, camera, holder, box, shell, particles, glow, coreLight;
let layerMeshes = [];
const highlight = [0, 0, 0, 0];
let quality;

function fail(reason) {
  debug.error = reason;
  root.classList.remove('webgl');
  root.classList.add('no-webgl');
  state.ready = false;
  window.dispatchEvent(new Event('lantern:failed'));
}

// ---------- Textures drawn in code (no image files) ----------
function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const dotTexture = () => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});

const glowTexture = () => canvasTexture(256, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,214,140,0.95)');
  r.addColorStop(0.18, 'rgba(245,170,60,0.55)');
  r.addColorStop(0.5, 'rgba(240,150,40,0.14)');
  r.addColorStop(1, 'rgba(240,150,40,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});

// Circuit traces: the same drawing is the board's colour map and its glow map.
function boardTextures() {
  const traces = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = 30 + rand() * 452;
    const y = 30 + rand() * 452;
    const len = 60 + rand() * 180;
    const horizontal = rand() > 0.5;
    traces.push([x, y, horizontal ? x + len : x, horizontal ? y : y + len * 0.6]);
  }
  const draw = (bg, line, width) => (g, s) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = line;
    g.lineWidth = width;
    g.lineCap = 'round';
    for (const [x1, y1, x2, y2] of traces) {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.beginPath();
      g.arc(x2, y2, width * 1.6, 0, Math.PI * 2);
      g.fillStyle = line;
      g.fill();
    }
  };
  return {
    map: canvasTexture(512, draw('#1E4D42', '#C9A25A', 3)),
    emissive: canvasTexture(512, draw('#000000', '#F0A93B', 3)),
  };
}

// ---------- The four layers ----------
function makeShell() {
  const g = new THREE.Group();
  // Glass: a thin reflective skin (transmission would need an opaque background
  // behind the canvas, and the page shows through it instead)
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.16,
    clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6, depthWrite: false,
  });
  shell = new THREE.Mesh(new RoundedBoxGeometry(1.5, CLOSED_HEIGHT - 0.16, 1.1, 5, 0.22), glass);
  shell.renderOrder = 2; // after the parts inside it
  g.add(shell);
  // The inside of the glass, seen through the front: gives the box its depth
  const back = new THREE.Mesh(shell.geometry, new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.2, transparent: true, opacity: 0.08, side: THREE.BackSide, depthWrite: false,
  }));
  back.renderOrder = 1;
  g.add(back);
  // Recycled aluminium frame: a cap on top and a band at the bottom
  const frame = new THREE.MeshStandardMaterial({ color: '#C8CCD1', metalness: 1, roughness: 0.28 });
  const cap = new THREE.Mesh(new RoundedBoxGeometry(1.54, 0.1, 1.14, 3, 0.05), frame);
  cap.position.y = CLOSED_HEIGHT / 2 - 0.05;
  const band = cap.clone();
  band.position.y = -CLOSED_HEIGHT / 2 + 0.05;
  g.add(cap, band);
  return g;
}

function makeCore(count) {
  const g = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 32, 16),
    new THREE.MeshBasicMaterial({ color: '#FFE2A8', toneMapped: false }),
  );
  g.add(sphere);

  glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), transparent: true, depthWrite: false, toneMapped: false,
  }));
  glow.scale.setScalar(1.7);
  g.add(glow);

  coreLight = new THREE.PointLight(AMBER, 4, 3.5, 1.6);
  g.add(coreLight);

  // Particles in a flattened shell around the core
  const max = L.QUALITY.high.particles;
  const positions = new Float32Array(max * 3);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < max; i++) {
    const r = 0.32 + rand() * 0.34;
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) * 0.75;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, count);
  particles = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.055, map: dotTexture(), transparent: true, depthWrite: false, toneMapped: false,
  }));
  g.add(particles);
  return g;
}

function makeBoard() {
  const g = new THREE.Group();
  const { map, emissive } = boardTextures();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.05, 0.92),
    new THREE.MeshStandardMaterial({
      map, emissiveMap: emissive, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.55, metalness: 0.3,
    }),
  );
  g.add(plate);
  const chipMaterial = new THREE.MeshStandardMaterial({ color: '#1B1D20', roughness: 0.4, metalness: 0.5 });
  [[-0.3, -0.12, 0.34, 0.26], [0.28, 0.16, 0.22, 0.22], [0.36, -0.24, 0.18, 0.14]].forEach(([x, z, w, d]) => {
    const chip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.045, d), chipMaterial);
    chip.position.set(x, 0.045, z);
    g.add(chip);
  });
  return g;
}

function makeCooling() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#B9BEC4', metalness: 1, roughness: 0.32 });
  const base = new THREE.Mesh(new RoundedBoxGeometry(1.42, 0.22, 1.02, 3, 0.06), metal);
  g.add(base);
  const finCount = 14;
  const fins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.032, 0.15, 0.8), metal, finCount);
  const m = new THREE.Matrix4();
  for (let i = 0; i < finCount; i++) {
    m.makeTranslation(-0.6 + (1.2 / (finCount - 1)) * i, 0.18, 0);
    fins.setMatrixAt(i, m);
  }
  g.add(fins);
  return g;
}

// ---------- Theme ----------
function applyTheme(theme) {
  if (!renderer) return;
  const dark = theme === 'dark';
  renderer.toneMappingExposure = dark ? 1.05 : 1;
  scene.environmentIntensity = dark ? 0.55 : 1;
  particles.material.color.set(dark ? '#FFD28A' : '#B8650A');
  particles.material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  particles.material.opacity = dark ? 1 : 0.7;
  particles.material.needsUpdate = true;
  glow.material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  glow.material.opacity = dark ? 0.9 : 0.75;
  glow.material.needsUpdate = true;
  shell.material.opacity = dark ? 0.12 : 0.2;
  shell.material.color.set(dark ? '#D6DEE8' : '#FFFFFF');
  dirty = true;
}

// ---------- Quality ----------
function applyQuality(level) {
  quality = level;
  debug.quality = level;
  const q = L.qualitySettings(level, window.devicePixelRatio || 1);
  renderer.setPixelRatio(q.dpr);
  resize();
  particles.geometry.setDrawRange(0, q.particles);
  dirty = true;
}

function resize() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}

// ---------- Placement: a DOM box -> a spot in the scene ----------
function anchorOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

function place(anchor, explode) {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const viewH = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const viewW = viewH * camera.aspect;
  const natural = L.lerp(CLOSED_HEIGHT, OPEN_HEIGHT, explode);
  // Fit the box into its slot by height AND width (narrow slots on tablets)
  const byHeight = ((anchor.h / h) * viewH * L.FILL) / natural;
  const byWidth = ((anchor.w / w) * viewW * L.FILL) / TURNED_WIDTH;
  const scale = Math.min(byHeight, byWidth);
  holder.scale.setScalar(scale);
  holder.position.set((anchor.x / w - 0.5) * viewW, -(anchor.y / h - 0.5) * viewH, 0);
  box.position.y = -OPEN_CENTRE * explode;
}

function heroFade() {
  const r = heroSection.getBoundingClientRect();
  return L.clamp(1 - r.bottom / r.height);
}

// ---------- The loop ----------
let dirty = true;
let last = performance.now();
let time = 0;
const look = { x: 0, y: 0 };
let windowMs = 0;
let windowFrames = 0;
let lastKey = '';
let shownOpacity = '';

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const moving = !reduceQuery.matches;
  // Pinned mode: the page says how far the scene has faded. Otherwise (reduced
  // motion, GSAP missing) the box lives in the hero and fades as it scrolls away.
  const fade = state.pinned ? L.clamp(state.fade || 0) : heroFade();
  const opacity = (1 - fade).toFixed(3);
  if (opacity !== shownOpacity) {
    // Written only when it changes: a style write every frame would force the
    // browser to recalculate styles before each getBoundingClientRect below
    canvas.style.setProperty('--scene-opacity', opacity);
    shownOpacity = opacity;
  }
  if (fade >= 0.999 || document.hidden) return; // nothing to see: do not draw

  const a = L.anatomy(state.progress || 0);
  const blend = moving && state.pinned ? L.clamp(state.blend || 0) : 0;
  const explode = moving ? a.explode * L.ease(blend) : 0;
  const anchor = L.blendAnchors(anchorOf(heroArt), anchorOf(insideArt), blend);

  // Without motion, draw only when something visible changed
  const key = [anchor.x | 0, anchor.y | 0, anchor.h | 0, fade.toFixed(2)].join(',');
  if (!moving && !dirty && key === lastKey) return;
  lastKey = key;

  if (moving) time += dt;
  const target = moving ? L.lookAt(state.pointer?.x || 0, state.pointer?.y || 0) : { x: 0, y: 0 };
  const k = 1 - Math.exp(-dt * 4);
  look.x += (target.x - look.x) * k;
  look.y += (target.y - look.y) * k;

  const heroTurn = -0.5 + (moving ? Math.sin(time * 0.35) * 0.16 : 0);
  box.rotation.y = L.lerp(heroTurn, a.turn - 0.5, L.ease(blend)) + look.y;
  box.rotation.x = L.lerp(0.22, a.tilt, L.ease(blend)) + look.x;

  L.LAYERS.forEach((layer, i) => {
    const rest = layer.rest + layer.open * explode;
    const want = blend > 0.5 && a.step === i ? 1 : 0;
    highlight[i] += (want - highlight[i]) * (moving ? k : 1);
    layerMeshes[i].position.y = rest;
    layerMeshes[i].position.z = highlight[i] * 0.35; // the current layer steps forward
  });

  place(anchor, explode);

  if (moving) {
    particles.rotation.y += dt * 0.35;
    particles.scale.setScalar(1 + Math.sin(time * 1.4) * 0.05);
  }
  const busy = highlight[1];
  coreLight.intensity = 4 + busy * 3 + (moving ? Math.sin(time * 2) * 0.4 : 0);
  glow.scale.setScalar(1.7 + busy * 0.4);

  renderer.render(scene, camera);
  dirty = false;
  debug.renders++;

  if (!debug.ready) {
    debug.ready = true;
    state.ready = true;
    root.classList.add('webgl');
    root.classList.remove('no-webgl');
    window.dispatchEvent(new Event('lantern:ready'));
  }

  // Step quality down if frames are slow (ignore the first second while things warm up)
  debug.frames++;
  if (moving && debug.frames > 60) {
    windowMs += dt * 1000;
    windowFrames++;
    if (windowFrames === 90) {
      debug.avgFrameMs = +(windowMs / windowFrames).toFixed(2);
      const next = L.nextQuality(quality, debug.avgFrameMs);
      if (next !== quality) applyQuality(next);
      windowMs = 0;
      windowFrames = 0;
    }
  }
}

// Start-up is split into short steps with a pause between them, so the page
// stays responsive while the scene is built (one long step would freeze taps
// and scrolling on a slow phone for most of a second).
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  if (!L) return fail('logic.js missing');
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    return fail('WebGL unavailable: ' + err.message);
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  await pause();

  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  // Reflections for glass and metal. 128 px is plenty for soft studio light and
  // costs a quarter of the default 256 px to prepare.
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: 128 }).texture;
  pmrem.dispose();
  await pause();

  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 9);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(3, 5, 4);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x3a3f46, 0.5));

  const startLevel = L.startQuality({
    width: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency,
    touch: window.matchMedia('(pointer: coarse)').matches,
  });

  holder = new THREE.Group();
  box = new THREE.Group();
  holder.add(box);
  scene.add(holder);
  const builders = { shell: makeShell, core: () => makeCore(L.QUALITY[startLevel].particles), board: makeBoard, cooling: makeCooling };
  layerMeshes = [];
  for (const layer of L.LAYERS) {
    const g = builders[layer.id]();
    g.name = layer.id;
    box.add(g);
    layerMeshes.push(g);
    await pause();
  }

  applyQuality(startLevel);
  applyTheme(root.dataset.theme);
  // Compile the shaders before the first frame, one layer at a time with a
  // pause in between (in parallel where the GPU driver allows it), so no single
  // step is long even on drivers that compile one shader after another
  for (const layer of layerMeshes) {
    try {
      await renderer.compileAsync(layer, camera, scene);
    } catch {
      // older drivers: the first frame compiles it instead
    }
    await pause();
  }

  window.addEventListener('lantern:theme', (e) => applyTheme(e.detail));
  window.addEventListener('resize', resize);
  reduceQuery.addEventListener('change', () => { dirty = true; });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    fail('WebGL context lost');
    window.dispatchEvent(new Event('lantern:lost'));
  });

  renderer.setAnimationLoop(frame);
}

main().catch((err) => fail('Scene failed to start: ' + err.message));
