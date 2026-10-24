import { DECKS, getDeckCards } from './data.js?v=4';
import { Round, tiltState } from './game-core.js';
import { PartyHistory } from './party-history.js?v=4';
import { RoundRecorder } from './round-recorder.js?v=4';

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

let partyStorage = null;
try { partyStorage = window.localStorage; } catch { /* In-memory history still works. */ }
const partyHistory = new PartyHistory({ cards: getDeckCards('mix'), storage: partyStorage });
const allCards = getDeckCards('mix');
const cardsById = new Map(allCards.map((card) => [card.id, card]));
const recorder = new RoundRecorder({ onChange: renderRecorderState });

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
let lastVisibleCard = null;
let recordingRequested = false;
let lastRecordingError = '';
let videoFilename = '';
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
    const remaining = document.createElement('span');
    remaining.className = 'deck-remaining';
    remaining.dataset.remainingDeck = deck.id;
    info.append(remaining);
    const radio = document.createElement('span');
    radio.className = 'deck-radio';
    radio.setAttribute('aria-hidden', 'true');
    card.append(emoji, info, radio);
    label.append(input, card);
    $('deck-options').append(label);
    input.addEventListener('change', () => {
      settings.deck = deck.id;
      persistSettings();
      updatePartyStatus();
    });
  }
}

function updatePartyStatus() {
  for (const deck of DECKS) {
    const remaining = partyHistory.remaining(getDeckCards(deck.id)).length;
    const label = document.querySelector(`[data-remaining-deck="${deck.id}"]`);
    if (label) {
      label.textContent = remaining ? `${remaining} még nem volt` : 'Nincs új, engedélyezett lap';
      label.classList.toggle('deck-exhausted', remaining === 0);
    }
  }
  const remaining = partyHistory.remaining(getDeckCards(settings.deck)).length;
  const unseenCount = partyHistory.remaining(allCards).length;
  const playedCount = partyHistory.totalCount - unseenCount - partyHistory.excludedCount;
  $('party-progress').textContent = `${playedCount} már volt · ${unseenCount} új · ${partyHistory.excludedCount} kizárva`;
  $('excluded-count').textContent = partyHistory.excludedCount;
  $('party-message').textContent = remaining
    ? 'A látott feladványokat a következő körökben és pakliváltáskor is kihagyjuk.'
    : 'Nincs új, engedélyezett lap. Váltsatok paklit, kezdjetek új partit, vagy engedjetek vissza kizárt lapokat.';
  $('start-button').disabled = remaining === 0;
  $('reset-party').disabled = partyHistory.usedCount === 0;
  $('play-again').disabled = remaining === 0;
  $('remaining-summary').textContent = remaining
    ? `Ebben a pakliban még ${remaining} új feladvány vár rátok.`
    : 'Nincs új, engedélyezett lap. A pakliknál válthattok, új partit kezdhettek vagy visszaengedhettek lapokat.';
}

function recordVisibleCard(now) {
  if (mode !== 'playing' || round?.status !== 'playing' || activeOverlay || document.hidden || now < feedbackUntil) return;
  lastVisibleCard = round.current;
  if (partyHistory.markSeen(round.current.id)) updatePartyStatus();
}

function normalizeSearch(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('hu-HU');
}

function exclusionButton(card) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'exclude-button';
  button.dataset.cardId = card.id;
  updateExclusionButton(button);
  return button;
}

function updateExclusionButton(button) {
  const card = cardsById.get(button.dataset.cardId);
  const excluded = partyHistory.isExcluded(card.id);
  button.textContent = excluded ? 'Visszaengedés' : 'Kizárás';
  button.classList.toggle('is-excluded', excluded);
  button.setAttribute('aria-label', `${excluded ? 'Visszaengedés' : 'Kizárás'}: ${card.name}`);
  button.setAttribute('aria-pressed', String(excluded));
}

function renderExclusions(focusId = null) {
  const search = normalizeSearch($('card-search').value.trim());
  const onlyExcluded = $('exclusion-filter').value === 'excluded';
  const cards = allCards.filter((card) => (!onlyExcluded || partyHistory.isExcluded(card.id))
    && (!search || normalizeSearch(card.name).includes(search)))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'));
  $('exclusion-results-count').textContent = `${cards.length} találat · ${partyHistory.excludedCount} kizárt feladvány`;
  $('exclusion-list').replaceChildren();
  for (const card of cards) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'exclusion-card-name';
    name.textContent = card.name;
    const type = document.createElement('small');
    type.textContent = card.type === 'movie' ? 'Film' : 'Színész';
    name.append(type);
    li.append(name, exclusionButton(card));
    $('exclusion-list').append(li);
  }
  $('exclusion-empty').hidden = cards.length !== 0;
  if (focusId) {
    const button = [...$('exclusion-list').querySelectorAll('button')].find((item) => item.dataset.cardId === focusId);
    (button || $('card-search')).focus({ preventScroll: true });
  }
}

function toggleExclusion(event) {
  const button = event.target.closest('button[data-card-id]');
  if (!button) return;
  const id = button.dataset.cardId;
  if (!cardsById.has(id)) return;
  const excluded = partyHistory.isExcluded(id);
  if (excluded) partyHistory.restore(id);
  else partyHistory.exclude(id);
  updatePartyStatus();
  $('result-list').querySelectorAll('button[data-card-id]').forEach(updateExclusionButton);
  const message = excluded
    ? partyHistory.hasSeen(id) ? 'Visszaengedve. Ebben a partiban már volt; az Új parti után tér vissza.' : 'Visszaengedve a paklikba.'
    : 'Kizárva a következő partikból is. A Kizárt lapok menüben visszaengedhetitek.';
  if ($('exclusions-dialog').open) {
    renderExclusions(id);
    $('exclusion-feedback').textContent = message;
    $('exclusion-feedback').hidden = false;
  } else toast(message);
}

function clearVideoResult() {
  $('round-video').pause();
  $('round-video').removeAttribute('src');
  $('round-video').load();
  $('round-video').hidden = true;
  $('video-actions').hidden = true;
  $('round-video-panel').hidden = true;
  $('video-retention-note').hidden = true;
  $('download-video').removeAttribute('href');
  videoFilename = '';
}

function renderRecorderState() {
  const state = recorder.state;
  const waiting = playingMode() && recordingRequested && state === 'preparing';
  $('video-prepare-status').hidden = !waiting;
  $('skip-video-button').hidden = !waiting;
  $('countdown-screen').classList.toggle('is-preparing-video', waiting);
  const active = mode === 'playing' && ['recording', 'paused'].includes(state);
  $('recording-indicator').hidden = !active;
  $('recording-indicator').classList.toggle('is-paused', state === 'paused');
  $('recording-state-label').textContent = state === 'paused' ? 'VIDEÓ SZÜNETEL' : 'FELVÉTEL';
  if (recorder.error && recorder.error !== lastRecordingError) {
    lastRecordingError = recorder.error;
    toast(recorder.error);
  }
}

function showVideoResult(result) {
  if (!result) {
    if (!$('round-video-panel').hidden) {
      $('video-result-status').textContent = recorder.error || 'Ebben a körben nem készült menthető videó.';
    }
    return;
  }
  const extension = result.extension.replace(/^\./, '');
  videoFilename = `homlok-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${extension}`;
  $('round-video-panel').hidden = false;
  $('video-result-status').textContent = recorder.error || 'Nézzétek vissza a kör legjobb pillanatait!';
  $('round-video').src = result.url;
  $('round-video').hidden = false;
  $('download-video').href = result.url;
  $('download-video').download = videoFilename;
  $('video-actions').hidden = false;
  $('video-retention-note').hidden = false;
  let shareable = false;
  try {
    shareable = Boolean(navigator.share && navigator.canShare?.({ files: [new File([result.blob], videoFilename, { type: result.mimeType })] }));
  } catch { /* A letöltés megosztás nélkül is elérhető. */ }
  $('share-video').hidden = !shareable;
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
    if (overlay || document.hidden) {
      round.pause(now);
      recorder.pause();
    } else {
      round.resume(now);
      recorder.resume();
    }
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
  const available = partyHistory.remaining(getDeckCards(settings.deck));
  if (!available.length) {
    goHome();
    updatePartyStatus();
    toast('Ez a pakli elfogyott. Válasszatok másikat, vagy indítsatok új partit.');
    return;
  }
  const session = ++roundSession;
  preparing = true;
  ensureAudio();
  // iOS requires this call directly in the user's click event, before any await.
  const permission = requestMotion();
  clearVideoResult();
  lastRecordingError = '';
  void recorder.discard();
  recordingRequested = $('record-setting').checked;
  lastVisibleCard = null;
  round = new Round({ actors: available, duration: settings.duration });
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
  if (recordingRequested) void recorder.prepare();
  renderRecorderState();
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
  if (recordingRequested) recorder.start();
  $('game-deck').textContent = DECKS.find((deck) => deck.id === settings.deck).name.toLocaleUpperCase('hu-HU');
  showScreen('game');
  renderActor();
  renderTimer(now);
  updateOverlays();
  recordVisibleCard(now);
  renderRecorderState();
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
  const answeredCard = round.current;
  if (!round.answer(outcome, now)) {
    if (round.status === 'finished') showResults();
    return;
  }
  if (partyHistory.markSeen(answeredCard.id)) updatePartyStatus();
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
  const endingRound = round;
  mode = 'results';
  preparing = false;
  roundSession += 1;
  manuallyPaused = false;
  $('answer-feedback').hidden = true;
  updateOverlays();
  updatePartyStatus();
  const results = round.results;
  const displayed = [...results];
  if (lastVisibleCard && !results.some((entry) => entry.actor.id === lastVisibleCard.id)) {
    displayed.push({ actor: lastVisibleCard, outcome: 'unanswered' });
  }
  const correct = results.filter((entry) => entry.outcome === 'correct').length;
  const passed = results.length - correct;
  $('correct-count').textContent = correct;
  $('pass-count').textContent = passed;
  $('accuracy-value').textContent = results.length ? `${Math.round(correct / results.length * 100)}%` : '—';
  $('results-reason').textContent = { time: 'LEJÁRT AZ IDŐ', exhausted: 'ELFOGYOTT A PAKLI!', stopped: 'KÖR BEFEJEZVE' }[round.reason];
  $('results-title').textContent = correct ? 'Tapsot a főszereplőnek!' : 'A következő kör a tiéd!';
  const deckName = DECKS.find((deck) => deck.id === settings.deck).name;
  $('result-summary').textContent = `${deckName} · ${settings.duration} másodperces kör · ${correct} helyes megfejtés`;
  $('result-total').textContent = `${displayed.length} FELADVÁNY`;
  $('round-details').open = false;
  $('result-list').replaceChildren();
  if (!displayed.length) {
    const li = document.createElement('li');
    li.textContent = 'Ebben a körben még nem érkezett válasz.';
    li.className = 'result-empty';
    $('result-list').append(li);
  }
  for (const result of displayed) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = result.actor.name;
    const outcome = document.createElement('span');
    outcome.className = `result-outcome${result.outcome === 'pass' ? ' pass' : ''}`;
    outcome.textContent = result.outcome === 'correct' ? '✓ Megvan' : result.outcome === 'pass' ? '↷ Passz' : 'Válasz nélkül';
    li.append(name, outcome, exclusionButton(result.actor));
    $('result-list').append(li);
  }
  showScreen('results');
  $('round-video-panel').hidden = !recordingRequested && !recorder.result;
  $('video-result-status').textContent = 'A videó összeállítása…';
  void recorder.stop().then((result) => {
    if (mode === 'results' && round === endingRound) showVideoResult(result);
  });
  renderRecorderState();
  releaseDevice();
  beep('end');
  ($('play-again').disabled ? $('back-home') : $('play-again')).focus({ preventScroll: true });
}

function goHome() {
  if (round && round.status !== 'finished') round.finish(performance.now());
  mode = 'home';
  roundSession += 1;
  preparing = false;
  manuallyPaused = false;
  round = null;
  recordingRequested = false;
  clearVideoResult();
  void recorder.discard();
  updatePartyStatus();
  updateOverlays();
  showScreen('home');
  releaseDevice();
  ($('start-button').disabled ? $('manage-exclusions') : $('start-button')).focus({ preventScroll: true });
}

function pauseGame() {
  if (!playingMode()) return;
  manuallyPaused = true;
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
  if (mode === 'countdown' && !preparing && recorder.state !== 'preparing' && !manuallyPaused && !needsLandscape() && !document.hidden) {
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
    else if (now >= feedbackUntil) {
      $('answer-feedback').hidden = true;
      recordVisibleCard(now);
    }
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
updatePartyStatus();
$('total-cards').textContent = `${getDeckCards('mix').length} FELADVÁNY · VÉGTELEN TIPP`;
syncSound();
$('tilt-setting').checked = settings.tilt;
$('record-setting').checked = false;
$('record-setting').disabled = !RoundRecorder.supported();
$('recording-help').hidden = RoundRecorder.supported();
if (!RoundRecorder.supported()) $('recording-help').textContent = 'Ebben a böngészőben a videófelvétel nem érhető el. A játékot videó nélkül is játszhatjátok.';
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
$('record-setting').addEventListener('change', () => { $('recording-help').hidden = !$('record-setting').checked; });
$('skip-video-button').addEventListener('click', () => {
  recordingRequested = false;
  $('record-setting').checked = false;
  void recorder.discard();
  lastFrame = performance.now();
});
$('share-video').addEventListener('click', async () => {
  const result = recorder.result;
  if (!result || !videoFilename) return;
  try {
    await navigator.share({ files: [new File([result.blob], videoFilename, { type: result.mimeType })], title: 'Homlok! — A kör videója' });
  } catch (error) {
    if (error.name !== 'AbortError') toast('A megosztás nem sikerült. A Letöltés gombbal menthetitek a videót.');
  }
});
$('delete-video').addEventListener('click', () => {
  clearVideoResult();
  void recorder.discard();
  toast('A videó törölve erről az oldalról.');
});
$('manage-exclusions').addEventListener('click', () => {
  $('card-search').value = '';
  $('exclusion-filter').value = partyHistory.excludedCount ? 'excluded' : 'all';
  $('exclusion-feedback').hidden = true;
  $('exclusion-feedback').textContent = '';
  renderExclusions();
  $('exclusions-dialog').showModal();
});
$('close-exclusions').addEventListener('click', () => $('exclusions-dialog').close());
$('card-search').addEventListener('input', () => renderExclusions());
$('exclusion-filter').addEventListener('change', () => renderExclusions());
$('exclusion-list').addEventListener('click', toggleExclusion);
$('result-list').addEventListener('click', toggleExclusion);
$('reset-party').addEventListener('click', () => $('reset-party-dialog').showModal());
$('cancel-party-reset').addEventListener('click', () => $('reset-party-dialog').close());
$('confirm-party-reset').addEventListener('click', () => {
  partyHistory.reset();
  $('reset-party-dialog').close();
  updatePartyStatus();
  ($('start-button').disabled ? $('manage-exclusions') : $('start-button')).focus({ preventScroll: true });
  toast('Új parti indult. A nem kizárt lapok újra játszhatók.');
});

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
window.addEventListener('pagehide', () => { void recorder.discard(); });
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('./service-worker.js').catch(() => {}); });
}
