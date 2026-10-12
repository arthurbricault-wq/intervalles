 (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const SR = 8000;      // fréquence d'échantillonnage (basse = fichier léger)
  const READY = 5;      // compte à rebours avant le départ (secondes)
  const MIN_DUR = 1;    // durée minimale d'une phase (secondes)
  const DEFAULTS = { run: 120, rest: 60, reps: 8, warn: true };
  const STORAGE_KEY = 'intervalles:reglages';

  const inputs = {
    run:  { min: $('#run-min'),  sec: $('#run-sec') },
    rest: { min: $('#rest-min'), sec: $('#rest-sec') },
  };

  let settings = loadSettings();
  let plan = null;
  let audio = null;
  let blobUrl = null;
  let timer = null;
  let lastPhase = null;

  /* ---------- Utilitaires ---------- */

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function loadSettings() {
    try {
      const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
      s.run = Math.max(MIN_DUR, Number(s.run) || DEFAULTS.run);
      s.rest = Math.max(MIN_DUR, Number(s.rest) || DEFAULTS.rest);
      s.reps = Math.min(99, Math.max(1, Number(s.reps) || DEFAULTS.reps));
      s.warn = !!s.warn;
      return s;
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function show(view) {
    $('#setup').hidden = view !== 'setup';
    $('#run').hidden = view !== 'run';
    $('#done').hidden = view !== 'done';
    if (view === 'setup') document.body.dataset.theme = 'setup';
    if (view === 'done') document.body.dataset.theme = 'done';
  }

  /* ---------- Écran de réglages ---------- */

  function num(el) {
    const n = parseInt(el.value, 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  // Lit ce qui est tapé dans les champs
  function readSettings() {
    for (const k of ['run', 'rest']) {
      settings[k] = Math.max(MIN_DUR, num(inputs[k].min) * 60 + num(inputs[k].sec));
    }
    settings.reps = Math.min(99, Math.max(1, num($('#reps'))));
    settings.warn = $('#warn').checked;
  }

  // Remet les champs au propre (ex. 90 secondes devient 1 min 30 s)
  function paintFields() {
    for (const k of ['run', 'rest']) {
      inputs[k].min.value = Math.floor(settings[k] / 60);
      inputs[k].sec.value = settings[k] % 60;
    }
    $('#reps').value = settings.reps;
    $('#warn').checked = settings.warn;
  }

  function paintSummary() {
    const total = settings.run * settings.reps + settings.rest * (settings.reps - 1);
    $('#summary').textContent =
      `${settings.reps} × ${fmt(settings.run)} de course, ${settings.reps - 1} × ${fmt(settings.rest)} de pause. Durée totale : ${fmt(total)}`;
  }

  document.querySelectorAll('#setup input').forEach((el) => {
    el.addEventListener('input', () => {
      readSettings();
      saveSettings();
      paintSummary();
    });
    el.addEventListener('change', () => {
      readSettings();
      saveSettings();
      paintFields();
      paintSummary();
    });
    if (el.type === 'number') el.addEventListener('focus', () => el.select());
  });

  /* ---------- Plan de séance ---------- */

  function buildPlan() {
    const phases = [{ type: 'ready', cycle: 1, start: 0, dur: READY }];
    let t = READY;
    for (let i = 1; i <= settings.reps; i++) {
      phases.push({ type: 'run', cycle: i, start: t, dur: settings.run });
      t += settings.run;
      if (i < settings.reps) {
        phases.push({ type: 'rest', cycle: i, start: t, dur: settings.rest });
        t += settings.rest;
      }
    }
    return { phases, total: t };
  }

  function phaseAt(t) {
    for (const p of plan.phases) if (t < p.start + p.dur) return p;
    return plan.phases[plan.phases.length - 1];
  }

  /* ---------- Fabrication de l'audio ---------- */

  function tone(data, atSec, freq, durSec) {
    const s0 = Math.round(atSec * SR);
    const n = Math.round(durSec * SR);
    const fade = Math.round(0.008 * SR);
    for (let i = 0; i < n && s0 + i < data.length; i++) {
      const env = Math.min(1, i / fade, (n - i) / fade);
      const v = Math.max(-1, Math.min(1, Math.sin((2 * Math.PI * freq * i) / SR) * 1.6)) * env;
      data[s0 + i] = Math.round(128 + 127 * v);
    }
  }

  function buildWav() {
    const length = Math.ceil((plan.total + 2) * SR);
    const data = new Uint8Array(length).fill(128); // 128 = silence en 8 bits

    for (const p of plan.phases) {
      if (p.type === 'ready') {
        [2, 3, 4].forEach((s) => tone(data, s, 880, 0.15)); // 3, 2, 1
        continue;
      }
      if (p.type === 'run') {
        // départ de la course : deux bips aigus
        tone(data, p.start, 1200, 0.18);
        tone(data, p.start + 0.28, 1200, 0.18);
      } else {
        // début de pause : un bip long et grave
        tone(data, p.start, 600, 0.6);
      }
      // bips à 5, 4, 3, 2, 1 seconde(s) avant la fin (le "0" est le bip de changement)
      if (settings.warn) {
        for (let k = 5; k >= 1; k--) {
          if (k < p.dur) tone(data, p.start + p.dur - k, 880, 0.15);
        }
      }
    }
    // fin de séance : trois bips
    [0, 0.3, 0.6].forEach((o) => tone(data, plan.total + o, 1200, 0.2));

    const buf = new ArrayBuffer(44 + length);
    const dv = new DataView(buf);
    const str = (off, s) => [...s].forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));
    str(0, 'RIFF'); dv.setUint32(4, 36 + length, true);
    str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);      // PCM
    dv.setUint16(22, 1, true);      // mono
    dv.setUint32(24, SR, true);
    dv.setUint32(28, SR, true);
    dv.setUint16(32, 1, true);
    dv.setUint16(34, 8, true);      // 8 bits
    str(36, 'data'); dv.setUint32(40, length, true);
    new Uint8Array(buf, 44).set(data);
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ---------- Séance ---------- */

  function start() {
    readSettings();
    saveSettings();
    paintFields();
    plan = buildPlan();
    cleanup();

    audio = new Audio();
    audio.preload = 'auto';
    blobUrl = URL.createObjectURL(buildWav());
    audio.src = blobUrl;
    audio.addEventListener('ended', finish);
    audio.addEventListener('play', onPlayState);
    audio.addEventListener('pause', onPlayState);

    lastPhase = null;
    show('run');
    setupMediaSession();

    // play() doit être appelé directement dans le geste de l'utilisateur (règle iOS)
    const p = audio.play();
    if (p && p.catch) p.catch(() => alert("Impossible de lancer le son. Vérifie le volume et réessaie."));

    timer = setInterval(render, 200);
    render();
  }

  function render() {
    if (!audio) return;
    const t = audio.currentTime;
    const ph = phaseAt(t);
    const left = Math.ceil(ph.start + ph.dur - t - 0.001);

    $('#count').textContent = fmt(left);
    $('#bar').style.width = Math.min(100, ((t - ph.start) / ph.dur) * 100) + '%';
    $('#remain').textContent = 'Reste ' + fmt(plan.total - t) + ' au total';

    if (ph !== lastPhase) {
      lastPhase = ph;
      document.body.dataset.theme = ph.type;
      $('#phase').textContent = phaseName(ph);
      $('#cycle').textContent = ph.type === 'ready'
        ? 'La séance démarre'
        : `Cycle ${ph.cycle} sur ${settings.reps}`;
      updateMedia(ph);
    }
  }

  function phaseName(ph) {
    return ph.type === 'run' ? 'Course' : ph.type === 'rest' ? 'Pause' : 'Prêt';
  }

  function onPlayState() {
    if (!audio) return;
    $('#toggle').textContent = audio.paused ? 'Reprendre' : 'Suspendre';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
      syncPosition();
    }
  }

  function finish() {
    const total = plan ? plan.total - READY : 0;
    $('#doneInfo').textContent = `${settings.reps} courses · ${fmt(total)} d'effort au total`;
    cleanup();
    show('done');
  }

  function stop() {
    if (!confirm('Arrêter la séance ?')) return;
    cleanup();
    show('setup');
  }

  function cleanup() {
    clearInterval(timer);
    timer = null;
    if (audio) {
      audio.pause();
      audio.removeEventListener('ended', finish);
      audio.removeEventListener('play', onPlayState);
      audio.removeEventListener('pause', onPlayState);
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  }

  function jump(dir) {
    if (!audio) return;
    const t = audio.currentTime;
    const i = plan.phases.indexOf(phaseAt(t));
    let target;
    if (dir > 0) {
      const next = plan.phases[i + 1];
      if (!next) return;
      target = next.start;
    } else {
      target = t - plan.phases[i].start > 2 ? plan.phases[i].start : plan.phases[Math.max(0, i - 1)].start;
    }
    audio.currentTime = target;
    render();
    syncPosition();
  }

  /* ---------- Écran de verrouillage (Media Session) ---------- */

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch (e) {} };
    set('play', () => audio && audio.play());
    set('pause', () => audio && audio.pause());
    set('nexttrack', () => jump(1));
    set('previoustrack', () => jump(-1));
    set('seekto', null);
    set('seekforward', null);
    set('seekbackward', null);
  }

  function updateMedia(ph) {
    if (!('mediaSession' in navigator)) return;
    const icon = ph.type === 'run' ? '🏃' : ph.type === 'rest' ? '💧' : '⏱';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${icon} ${phaseName(ph)}`,
      artist: ph.type === 'ready' ? 'La séance démarre' : `Cycle ${ph.cycle} sur ${settings.reps}`,
      album: 'Intervalles',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    syncPosition();
  }

  function syncPosition() {
    if (!audio || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      const duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : plan.total + 2;
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(audio.currentTime, duration),
        playbackRate: audio.playbackRate || 1,
      });
    } catch (e) {}
  }

  /* ---------- Boutons ---------- */

  $('#start').addEventListener('click', start);
  $('#toggle').addEventListener('click', () => {
    if (!audio) return;
    if (audio.paused) audio.play(); else audio.pause();
  });
  $('#stop').addEventListener('click', stop);
  $('#again').addEventListener('click', () => show('setup'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audio) {
      lastPhase = null;
      render();
    }
  });

  /* ---------- Mode hors ligne ---------- */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  paintFields();
  paintSummary();
})();