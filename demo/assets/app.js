// Lantern One: the page around the 3D scene. Theme, scroll (GSAP ScrollTrigger),
// the pinned "Inside" section, number count-up, pointer and tilt, the form.
// The scene (scene.js) reads window.lantern every frame; this file writes it.
(function () {
  'use strict';

  const L = window.LanternLogic;
  const root = document.documentElement;
  const state = (window.lantern = window.lantern || {});
  Object.assign(state, {
    blend: 0, // 0 = box in the hero, 1 = box in the "Inside" section
    progress: 0, // pinned "Inside" section, 0..1 (see LanternLogic.anatomy)
    fade: 0, // 0 = scene fully visible, 1 = gone (below the "Inside" section)
    pointer: { x: 0, y: 0 },
    pinned: false,
  });

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => !reduceQuery.matches;
  root.classList.toggle('motion', motion());

  // ---------- Theme ----------
  const toggle = document.getElementById('theme-toggle');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let saved = null;
  try { saved = localStorage.getItem('lantern-theme'); } catch (e) { /* storage blocked */ }

  const themeColors = [...document.querySelectorAll('meta[name="theme-color"]')];
  function applyTheme(theme) {
    root.dataset.theme = theme;
    // Browser bars follow the chosen theme, not only the system one
    themeColors.forEach((m) => m.setAttribute('content', theme === 'dark' ? '#14171B' : '#ECEEEA'));
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    window.dispatchEvent(new CustomEvent('lantern:theme', { detail: theme }));
  }
  applyTheme(L.resolveTheme(saved, systemDark.matches));
  toggle.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('lantern-theme', next); saved = next; } catch (e) { /* keep for this visit */ }
    applyTheme(next);
  });
  systemDark.addEventListener('change', (e) => { if (!saved) applyTheme(e.matches ? 'dark' : 'light'); });

  // ---------- Pointer and tilt: the box turns a little towards them ----------
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    state.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    state.pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  // Tilt. Some browsers (iPhone, recent Chrome) ask for permission after a tap;
  // others send tilt at once. The hint says what works here and updates itself
  // as soon as tilt actually arrives.
  const hint = document.querySelector('.hero__hint');
  const heroArt = document.querySelector('.hero__art');
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const canAsk = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  if (coarse) hint.textContent = canAsk ? 'Tap the box, then tilt your device: it follows.' : 'Tilt your device: the box follows.';

  let tiltSeen = false;
  const screenAngle = () => (screen.orientation ? screen.orientation.angle : Number(window.orientation) || 0);
  function onTilt(e) {
    const p = L.tiltToPointer(e.beta, e.gamma, screenAngle());
    if (!p) return;
    state.pointer = p;
    if (!tiltSeen && coarse) hint.textContent = 'Tilt your device: the box follows.';
    tiltSeen = true;
  }
  if (typeof DeviceOrientationEvent !== 'undefined') {
    window.addEventListener('deviceorientation', onTilt, { passive: true });
    if (canAsk) {
      // Only a tap on the box asks, never a tap on the buttons next to it
      const ask = () => {
        heroArt.removeEventListener('click', ask);
        DeviceOrientationEvent.requestPermission()
          .then((answer) => { if (answer !== 'granted' && coarse) hint.style.visibility = 'hidden'; })
          .catch(() => { if (coarse) hint.style.visibility = 'hidden'; });
      };
      heroArt.addEventListener('click', ask);
    }
  }

  // ---------- Steps of the "Inside" section ----------
  const steps = [...document.querySelectorAll('.step')];
  const insideSection = document.getElementById('inside');
  function setStep(i) {
    steps.forEach((el, n) => el.classList.toggle('is-current', n === i));
  }

  function setInside(progress) {
    state.progress = progress;
    const a = L.anatomy(progress);
    setStep(Math.max(0, a.step));
    insideSection.style.setProperty('--inside-progress', progress.toFixed(4));
  }

  // ---------- Scroll ----------
  // Without GSAP (blocked CDN) or without WebGL the page is a normal long page:
  // nothing is pinned and the drawings stand in for the 3D object.
  // Built again when WebGL comes up after the plain page was set up.
  let mm = null;
  // Pinning adds three screens of scroll above everything after "Inside": never
  // switch it on under someone who has already scrolled past the hero.
  let allowPin = true;
  let hashHandled = false;

  function setUpScroll() {
    if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;
    gsap.registerPlugin(ScrollTrigger);
    if (mm) mm.revert();
    mm = gsap.matchMedia();

    // With motion: blend the box from the hero into the pinned section, open it
    // layer by layer, then fade the scene out under the rest of the page.
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      if (!root.classList.contains('webgl') || !allowPin) return;
      state.pinned = true;
      root.classList.add('pinned'); // the CSS for the pinned layout keys off this, not off .webgl
      const blend = ScrollTrigger.create({
        trigger: insideSection, start: 'top bottom', end: 'top top',
        onUpdate: (self) => { state.blend = self.progress; },
        onLeaveBack: () => { state.blend = 0; },
      });
      const pin = ScrollTrigger.create({
        trigger: '.inside__pin', start: 'top top', end: () => '+=' + Math.round(window.innerHeight * 3),
        pin: true, scrub: true, anticipatePin: 1,
        onUpdate: (self) => setInside(self.progress),
        onLeaveBack: () => setInside(0),
      });
      const fade = ScrollTrigger.create({
        trigger: '#specs', start: 'top bottom', end: 'top 35%',
        onUpdate: (self) => { state.fade = self.progress; },
      });
      setInside(0);
      return () => {
        [blend, pin, fade].forEach((t) => t.kill());
        state.pinned = false;
        root.classList.remove('pinned');
        Object.assign(state, { blend: 0, progress: 0, fade: 0 });
        steps.forEach((el) => el.classList.remove('is-current'));
      };
    });

    // Reduced motion: no pinning, no count-up. The scene keeps the box in the
    // hero and fades it as the hero scrolls away (scene.js, heroFade).

    // Numbers count up once, the first time the specs scroll into view
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const counters = [...document.querySelectorAll('[data-count]')];
      const run = () => {
        const start = performance.now();
        const tick = () => {
          const t = Math.min(1, (performance.now() - start) / 1200);
          counters.forEach((el) => {
            const target = Number(el.dataset.count);
            el.textContent = L.formatCount(L.countValue(target, t));
          });
          if (t < 1) requestAnimationFrame(tick);
        };
        tick();
      };
      const trigger = ScrollTrigger.create({ trigger: '.specs__list', start: 'top 85%', once: true, onEnter: run });
      return () => {
        trigger.kill();
        counters.forEach((el) => { el.textContent = L.formatCount(Number(el.dataset.count)); });
      };
    });
  }

  reduceQuery.addEventListener('change', () => root.classList.toggle('motion', motion()));

  // The scene tells us when WebGL is up (or that it never will be)
  // A link straight to a section (#reserve): pinning moves everything below it,
  // so go there again once the triggers exist
  function honourHash() {
    if (hashHandled || !location.hash) return;
    hashHandled = true;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'instant' }));
  }

  // The triggers are built on the visitor's first move (scroll, wheel, touch,
  // key, click), not at load: building them measures the whole page, and there
  // is nothing to animate until someone scrolls. A page opened part-way down
  // (reload, a #link) is set up at once.
  const firstMoves = ['scroll', 'wheel', 'touchstart', 'keydown', 'pointerdown'];
  let engaged = window.scrollY > 0 || Boolean(location.hash);
  let due = false;
  function runSetUp() {
    setUpScroll();
    honourHash();
  }
  function requestSetUp() {
    due = true;
    if (engaged) runSetUp();
  }
  function engage() {
    if (engaged) return;
    engaged = true;
    firstMoves.forEach((type) => window.removeEventListener(type, engage, true));
    if (due) runSetUp();
  }
  if (!engaged) firstMoves.forEach((type) => window.addEventListener(type, engage, { capture: true, passive: true }));

  window.addEventListener('lantern:ready', () => {
    if (mm && window.scrollY > insideSection.offsetTop - window.innerHeight) allowPin = false;
    requestSetUp();
  });
  window.addEventListener('lantern:failed', () => { if (!mm) requestSetUp(); });
  // WebGL died: drop the pinning, and keep the reader at "Inside" if they were in it
  window.addEventListener('lantern:lost', () => {
    if (!mm) return;
    const wasInside = state.pinned && state.blend >= 1 && state.fade < 1;
    setUpScroll();
    if (wasInside) insideSection.scrollIntoView({ behavior: 'instant' });
  });
  if (state.ready) requestSetUp();
  // Safety net: if the 3D library is slow or never arrives, set up the plain page
  setTimeout(() => { if (!mm) requestSetUp(); }, 6000);

  // ---------- Reservation form (demo: nothing is sent anywhere) ----------
  const form = document.getElementById('reserve-form');
  const done = document.getElementById('reserve-done');
  const fields = ['name', 'email', 'team'];

  function showErrors(errors) {
    fields.forEach((name) => {
      const input = form.elements[name];
      const box = document.getElementById('f-' + name + '-error');
      if (errors[name]) {
        input.setAttribute('aria-invalid', 'true');
        box.textContent = errors[name];
        box.hidden = false;
      } else {
        input.removeAttribute('aria-invalid');
        box.hidden = true;
        box.textContent = '';
      }
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const errors = L.validateReservation(data);
    showErrors(errors);
    const first = fields.find((f) => errors[f]);
    if (first) {
      done.hidden = true;
      form.elements[first].focus();
      return;
    }
    const team = form.elements.team.selectedOptions[0].textContent;
    done.textContent =
      'Thanks, ' + data.name.trim() + '. This is a demo, so nothing was sent. ' +
      'On a live site the Candlewren team would get your reservation for a team of ' + team.toLowerCase() +
      ' and email ' + data.email.trim() + ' a confirmation.';
    done.hidden = false;
    done.focus();
  });

  // Clear a field's error as soon as it is fixed, and an old confirmation as
  // soon as the details it describes change
  form.addEventListener('input', (e) => {
    const input = e.target;
    done.hidden = true;
    if (!fields.includes(input.name) || input.getAttribute('aria-invalid') !== 'true') return;
    const errors = L.validateReservation(Object.fromEntries(new FormData(form)));
    if (errors[input.name]) return;
    input.removeAttribute('aria-invalid');
    const box = document.getElementById('f-' + input.name + '-error');
    box.hidden = true;
    box.textContent = '';
  });
})();
