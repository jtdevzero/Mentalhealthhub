import { DECKS, getDeckCards } from './data.js?v=2';
import { Round, tiltState } from './game-core.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'homlok-settings-v1';
const defaults = { deck: 'world', duration: 60, tilt: true, sound: false };
let settings = { ...defaults };
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (stored && DECKS.some((deck) => deck.id === stored.deck)) settings.deck = stored.deck;
  if (stored && [60, 90, 120].includes(stored.duration)) settings.duration = stored.duration;
  if (typeof stored?.tilt === 'boolean') settings.tilt = stored.tilt;
  if (typeof stored?.sound === 'boolean') settings.sound = stored.sound;
} catch { /* A játék privát módban, tárhely nélkül is működik. */ }

let mode = 'home';
let round = null;
let preparing = false;
let manuallyPaused = false;
let countdownRemaining = 3;
let countdownLastNumber = null;
let lastFrame = performance.now();
let feedbackUntil = 0;
let tiltEnabled = false;
let tiltArmed = false;
let neutralSince = null;
let motionSeen = false;
let lastTick = null;
let wakeLock = null;
let audioContext = null;
let toastTimeout;
let activeOverlay = null;
let roundSession = 0;
const screens = ['home', 'countdown', 'game', 'results'];

function persistSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Optional. */ }
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function renderDecks() {
  for (const deck of DECKS) {
    const label = document.createElement('label');
    label.className = 'deck-label';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'deck';
    input.value = deck.id;
    input.checked = settings.deck === deck.id;
    const card = document.createElement('span');
    card.className = 'deck-card';
    const emoji = document.createElement('span');
    emoji.className = 'deck-icon';
    emoji.style.setProperty('--deck-color', deck.color);
    emoji.textContent = deck.icon;
    emoji.setAttribute('aria-hidden', 'true');
    const info = document.createElement('span');
    info.className = 'deck-info';
    for (const [className, text] of [
      ['deck-name', deck.name],
      ['deck-description', deck.description],
      ['deck-count', `${getDeckCards(deck.id).length} ${deck.unit}`],
    ]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      info.append(span);
    }
    const radio = document.createElement('span');
    radio.className = 'deck-radio';
    radio.setAttribute('aria-hidden', 'true');
    card.append(emoji, info, radio);
    label.append(input, card);
    $('deck-options').append(label);
    input.addEventListener('change', () => {
      settings.deck = deck.id;
      persistSettings();
    });
  }
}

function syncSound() {
  $('sound-setting').checked = settings.sound;
  $('header-sound').replaceChildren(icon(settings.sound ? 'sound' : 'muted'));
  $('header-sound').setAttribute('aria-label', `Hang ${settings.sound ? 'kikapcsolása' : 'bekapcsolása'}`);
  $('header-sound').setAttribute('aria-pressed', String(settings.sound));
}

function ensureAudio() {
  if (!settings.sound) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext ??= new Context();
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
  } catch { /* A hang kiegészítő; a játék nélküle is teljes. */ }
}

function beep(kind) {
  if (!settings.sound || !audioContext || audioContext.state !== 'running') return;
  try {
    const notes = { correct: [660, 880], pass: [260, 200], tick: [500], start: [660, 880, 1100], end: [660, 440, 330] };
    for (const [index, frequency] of (notes[kind] || notes.tick).entries()) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * .1;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(.09, start + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .14);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + .15);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  } catch { /* Ne szakítsa meg a kört egy hanghiba. */ }
}

function toast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

function showScreen(name) {
  for (const screen of screens) {
    $(`${screen}-screen`).hidden = screen !== name;
    $(`${screen}-screen`).inert = false;
  }
  document.body.classList.toggle('is-playing', name === 'countdown' || name === 'game');
  window.scrollTo(0, 0);
}

function needsLandscape() {
  return innerHeight > innerWidth && matchMedia('(max-width: 900px)').matches;
}

function playingMode() {
  return mode === 'countdown' || mode === 'playing';
}

function updateOverlays() {
  const rotate = playingMode() && needsLandscape();
  const pause = playingMode() && !rotate && manuallyPaused;
  $('rotate-overlay').hidden = !rotate;
  $('pause-overlay').hidden = !pause;
  const overlay = rotate ? 'rotate' : pause ? 'pause' : null;
  if (playingMode()) $(mode === 'countdown' ? 'countdown-screen' : 'game-screen').inert = Boolean(overlay);
  // Both overlays conceal the actor's name, so a break cannot spoil the answer.
  if (overlay !== activeOverlay) {
    activeOverlay = overlay;
    if (overlay) $(overlay === 'rotate' ? 'rotate-exit' : 'resume-button').focus({ preventScroll: true });
    else if (mode === 'playing') $('pause-button').focus({ preventScroll: true });
  }
  if (mode === 'playing' && round) {
    const now = performance.now();
    if (overlay || document.hidden) round.pause(now);
    else round.resume(now);
  }
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || document.hidden || !playingMode() || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
    if (!playingMode()) { await wakeLock.release(); wakeLock = null; }
  } catch { /* Nem minden böngésző engedélyezi. */ }
}

function releaseDevice() {
  if (wakeLock) void wakeLock.release().catch(() => {});
  wakeLock = null;
  try { screen.orientation?.unlock?.(); } catch { /* Optional. */ }
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

function requestFullScreen() {
  if (!matchMedia('(pointer: coarse)').matches || !document.documentElement.requestFullscreen) return;
  try {
    void document.documentElement.requestFullscreen().then(async () => {
      if (!playingMode()) return;
      try { await screen.orientation?.lock?.('landscape'); } catch { /* A forgatási segítség megmarad. */ }
    }).catch(() => {});
  } catch { /* A kézi elforgatás is megfelelő. */ }
}

async function requestMotion() {
  if (!settings.tilt) return false;
  if (!window.isSecureContext || !('DeviceOrientationEvent' in window)) {
    toast('A billentés itt nem érhető el. Egy barát használhatja a Megvan és Passz gombokat.');
    return false;
  }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        toast('A billentéshez nem kaptunk engedélyt. A Megvan és Passz gombokkal játszhattok.');
        return false;
      }
    }
    return true;
  } catch {
    toast('A billentést nem sikerült bekapcsolni. A gombokkal folytathatjátok.');
    return false;
  }
}

async function beginRound() {
  if (preparing || playingMode()) return;
  const session = ++roundSession;
  preparing = true;
  ensureAudio();
  // iOS requires this call directly in the user's click event, before any await.
  const permission = requestMotion();
  round = new Round({ actors: getDeckCards(settings.deck), duration: settings.duration });
  mode = 'countdown';
  manuallyPaused = false;
  countdownRemaining = 3;
  countdownLastNumber = null;
  feedbackUntil = 0;
  tiltArmed = false;
  neutralSince = null;
  motionSeen = false;
  lastTick = null;
  $('countdown-number').textContent = '3';
  $('answer-feedback').hidden = true;
  showScreen('countdown');
  updateOverlays();
  requestFullScreen();
  void acquireWakeLock();
  const motionGranted = await permission;
  // A user can leave while a browser's permission sheet is open.
  if (session !== roundSession || !playingMode()) return;
  tiltEnabled = motionGranted;
  preparing = false;
  lastFrame = performance.now();
}

function startPlaying(now) {
  mode = 'playing';
  round.start(now);
  $('game-deck').textContent = DECKS.find((deck) => deck.id === settings.deck).name.toLocaleUpperCase('hu-HU');
  showScreen('game');
  renderActor();
  renderTimer(now);
  updateOverlays();
  beep('start');
}

function renderActor() {
  if (round?.current) {
    $('actor-name').textContent = round.current.name.toLocaleUpperCase('hu-HU');
    $('card-prompt').textContent = round.current.type === 'movie' ? 'MELYIK FILM EZ?' : 'KI VAGYOK ÉN?';
  }
  $('live-score').textContent = round?.results.filter((item) => item.outcome === 'correct').length ?? 0;
  renderMotionStatus();
}

function renderMotionStatus() {
  $('tilt-status').textContent = !tiltEnabled
    ? 'Egy barát kezelheti a gombokat. Gépen: ← passz · → megvan'
    : !motionSeen
      ? 'Billentésre várva… A gombokat is használhatjátok.'
      : tiltArmed
        ? 'Billents a következő feladványhoz, vagy használjátok a gombokat.'
        : 'Tartsd újra függőlegesen a kijelzőt a következő billentéshez.';
}

function renderTimer(now) {
  const left = round.remaining(now);
  const seconds = Math.ceil(left);
  $('timer-value').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('game-timer').classList.toggle('urgent', seconds <= 10);
  $('timer-progress').style.transform = `scaleX(${left / round.duration})`;
  if (seconds <= 5 && seconds > 0 && seconds !== lastTick && round.status === 'playing') beep('tick');
  lastTick = seconds;
}

function answer(outcome) {
  const now = performance.now();
  if (mode !== 'playing' || activeOverlay || document.hidden || now < feedbackUntil) return;
  if (!round.answer(outcome, now)) {
    if (round.status === 'finished') showResults();
    return;
  }
  tiltArmed = false;
  neutralSince = null;
  beep(outcome);
  try { navigator.vibrate?.(outcome === 'correct' ? 65 : [30, 30, 30]); } catch { /* Optional. */ }
  if (round.status === 'finished') { showResults(); return; }
  feedbackUntil = now + 650;
  $('answer-feedback').classList.toggle('is-pass', outcome === 'pass');
  $('feedback-symbol').textContent = outcome === 'correct' ? '✓' : '↷';
  $('feedback-label').textContent = outcome === 'correct' ? 'Megvan!' : 'Jöhet más!';
  $('answer-feedback').hidden = false;
  renderActor();
}

function showResults() {
  if (mode === 'results' || !round) return;
  mode = 'results';
  preparing = false;
  roundSession += 1;
  manuallyPaused = false;
  $('answer-feedback').hidden = true;
  updateOverlays();
  const results = round.results;
  const correct = results.filter((entry) => entry.outcome === 'correct').length;
  const passed = results.length - correct;
  $('correct-count').textContent = correct;
  $('pass-count').textContent = passed;
  $('accuracy-value').textContent = results.length ? `${Math.round(correct / results.length * 100)}%` : '—';
  $('results-reason').textContent = { time: 'LEJÁRT AZ IDŐ', exhausted: 'ELFOGYOTT A PAKLI!', stopped: 'KÖR BEFEJEZVE' }[round.reason];
  $('results-title').textContent = correct ? 'Tapsot a főszereplőnek!' : 'A következő kör a tiéd!';
  const deckName = DECKS.find((deck) => deck.id === settings.deck).name;
  $('result-summary').textContent = `${deckName} · ${settings.duration} másodperces kör · ${correct} helyes megfejtés`;
  $('result-total').textContent = `${results.length} FELADVÁNY`;
  $('round-details').open = false;
  $('result-list').replaceChildren();
  if (!results.length) {
    const li = document.createElement('li');
    li.textContent = 'Ebben a körben még nem érkezett válasz.';
    li.className = 'result-empty';
    $('result-list').append(li);
  }
  for (const result of results) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = result.actor.name;
    const outcome = document.createElement('span');
    outcome.className = `result-outcome${result.outcome === 'pass' ? ' pass' : ''}`;
    outcome.textContent = result.outcome === 'correct' ? '✓ Megvan' : '↷ Passz';
    li.append(name, outcome);
    $('result-list').append(li);
  }
  showScreen('results');
  releaseDevice();
  beep('end');
  $('play-again').focus({ preventScroll: true });
}

function goHome() {
  if (round && round.status !== 'finished') round.finish(performance.now());
  mode = 'home';
  roundSession += 1;
  preparing = false;
  manuallyPaused = false;
  round = null;
  updateOverlays();
  showScreen('home');
  releaseDevice();
  $('start-button').focus({ preventScroll: true });
}

function pauseGame() {
  if (!playingMode()) return;
  manuallyPaused = true;
  $('answer-feedback').hidden = true;
  tiltArmed = false;
  neutralSince = null;
  updateOverlays();
  if (round?.status === 'finished') showResults();
}

function resumeGame() {
  manuallyPaused = false;
  lastFrame = performance.now();
  ensureAudio();
  updateOverlays();
  void acquireWakeLock();
}

function frame(now) {
  const delta = Math.max(0, now - lastFrame);
  lastFrame = now;
  if (mode === 'countdown' && !preparing && !manuallyPaused && !needsLandscape() && !document.hidden) {
    countdownRemaining = Math.max(0, countdownRemaining - delta / 1000);
    const number = Math.ceil(countdownRemaining);
    if (number !== countdownLastNumber && number > 0) {
      countdownLastNumber = number;
      $('countdown-number').textContent = number;
      beep('tick');
    }
    if (countdownRemaining === 0) startPlaying(now);
  }
  if (mode === 'playing') {
    round.update(now);
    renderTimer(now);
    if (round.status === 'finished') showResults();
    else if (now >= feedbackUntil) $('answer-feedback').hidden = true;
  }
  requestAnimationFrame(frame);
}

window.addEventListener('deviceorientation', (event) => {
  if (!tiltEnabled || mode !== 'playing' || round.status !== 'playing' || activeOverlay) return;
  const state = tiltState(event);
  if (!state) { neutralSince = null; return; }
  const now = performance.now();
  if (!motionSeen) { motionSeen = true; renderMotionStatus(); }
  if (now < feedbackUntil) { neutralSince = null; return; }
  if (state === 'neutral') {
    neutralSince ??= now;
    if (now - neutralSince >= 180 && !tiltArmed) { tiltArmed = true; renderMotionStatus(); }
  } else {
    neutralSince = null;
    if (tiltArmed) answer(state);
  }
}, { passive: true });

renderDecks();
$('total-cards').textContent = `${getDeckCards('mix').length} FELADVÁNY · VÉGTELEN TIPP`;
syncSound();
$('tilt-setting').checked = settings.tilt;
document.querySelector(`input[name="duration"][value="${settings.duration}"]`).checked = true;
document.querySelectorAll('input[name="duration"]').forEach((input) => input.addEventListener('change', () => {
  settings.duration = Number(input.value);
  persistSettings();
}));
$('tilt-setting').addEventListener('change', (event) => { settings.tilt = event.target.checked; persistSettings(); });
$('sound-setting').addEventListener('change', (event) => {
  settings.sound = event.target.checked;
  persistSettings();
  syncSound();
  ensureAudio();
  if (settings.sound) beep('tick');
});
$('header-sound').addEventListener('click', () => {
  settings.sound = !settings.sound;
  persistSettings();
  syncSound();
  ensureAudio();
  if (settings.sound) beep('tick');
});
$('start-button').addEventListener('click', beginRound);
$('play-again').addEventListener('click', beginRound);
$('cancel-countdown').addEventListener('click', goHome);
$('rotate-exit').addEventListener('click', goHome);
$('back-home').addEventListener('click', goHome);
$('pause-button').addEventListener('click', pauseGame);
$('resume-button').addEventListener('click', resumeGame);
$('finish-button').addEventListener('click', () => {
  round.finish(performance.now());
  showResults();
});
$('correct-button').addEventListener('click', () => answer('correct'));
$('pass-button').addEventListener('click', () => answer('pass'));

document.addEventListener('keydown', (event) => {
  if (activeOverlay && event.key === 'Tab') {
    const buttons = [...$(`${activeOverlay}-overlay`).querySelectorAll('button')];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (!playingMode() || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!manuallyPaused) pauseGame();
  } else if (event.code === 'Space' && !activeOverlay) {
    event.preventDefault();
    pauseGame();
  } else if (event.key === 'ArrowRight' && !activeOverlay) {
    event.preventDefault(); answer('correct');
  } else if (event.key === 'ArrowLeft' && !activeOverlay) {
    event.preventDefault(); answer('pass');
  }
});
window.addEventListener('resize', () => { updateOverlays(); lastFrame = performance.now(); });
document.addEventListener('visibilitychange', () => {
  if (!playingMode()) return;
  if (document.hidden) pauseGame();
  else { lastFrame = performance.now(); void acquireWakeLock(); }
});
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('./service-worker.js').catch(() => {}); });
}
