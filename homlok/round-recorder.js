const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
const MAX_RECORDING_MS = 5 * 60 * 1000;
const STOP_TIMEOUT_MS = 4000;
const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function mediaRecorderClass() {
  return globalThis.window?.MediaRecorder ?? globalThis.MediaRecorder;
}

function mediaDevices() {
  return globalThis.navigator?.mediaDevices ?? globalThis.window?.navigator?.mediaDevices;
}

function friendlyError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'A kamera és a mikrofon engedélye nincs megadva. A játék felvétel nélkül folytatható.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Nem található használható kamera vagy mikrofon.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'A kamera vagy a mikrofon most nem érhető el. Lehet, hogy másik alkalmazás használja.';
    case 'NotSupportedError':
      return 'Ez a böngésző nem támogatja a videófelvételt. A játék felvétel nélkül folytatható.';
    default:
      return 'A videófelvétel nem sikerült. A játék felvétel nélkül folytatható.';
  }
}

function stopStream(stream) {
  try {
    for (const track of stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* A többi eszközt akkor is elengedjük. */ }
    }
  } catch { /* Egy már megszűnt stream nem akadályozhatja a játékot. */ }
}

/** A felvétel kizárólag a böngésző memóriájában marad; a modul nem tölt fel adatot. */
export class RoundRecorder {
  constructor({ onChange = () => {} } = {}) {
    this._onChange = typeof onChange === 'function' ? onChange : () => {};
    this._state = 'idle';
    this._error = '';
    this._result = null;
    this._generation = 0;
    this._stream = null;
    this._recorder = null;
    this._trackListeners = [];
    this._chunks = [];
    this._size = 0;
    this._hasStarted = false;
    this._fatalError = false;
    this._preparePromise = null;
    this._stopPromise = null;
    this._resolveStop = null;
    this._stopTimer = null;
    this._maxTimer = null;
    this._requestedMimeType = '';
  }

  static supported() {
    try {
      const secure = globalThis.isSecureContext ?? globalThis.window?.isSecureContext;
      return secure === true
        && typeof mediaDevices()?.getUserMedia === 'function'
        && typeof mediaRecorderClass() === 'function';
    } catch {
      return false;
    }
  }

  get state() { return this._state; }
  get error() { return this._error; }
  get result() { return this._result; }

  _notify() {
    try { this._onChange(this); } catch { /* A felület hibája nem tarthatja nyitva a kamerát. */ }
  }

  _setState(state) {
    this._state = state;
    this._notify();
  }

  _clearTimers() {
    if (this._stopTimer !== null) clearTimeout(this._stopTimer);
    if (this._maxTimer !== null) clearTimeout(this._maxTimer);
    this._stopTimer = null;
    this._maxTimer = null;
  }

  _stopTracks() {
    for (const [track, listener] of this._trackListeners) {
      try { track.removeEventListener('ended', listener); } catch { /* Már megszűnhetett. */ }
    }
    this._trackListeners = [];
    const stream = this._stream;
    this._stream = null;
    stopStream(stream);
  }

  _detachRecorder() {
    if (!this._recorder) return;
    this._recorder.ondataavailable = null;
    this._recorder.onstop = null;
    this._recorder.onerror = null;
  }

  _reset() {
    this._generation += 1;
    this._clearTimers();
    this._detachRecorder();
    this._stopTracks();
    try {
      if (this._recorder && this._recorder.state !== 'inactive') this._recorder.stop();
    } catch { /* A trackek ekkorra már leálltak. */ }
    this._recorder = null;
    if (this._result?.url) {
      try { globalThis.URL.revokeObjectURL(this._result.url); } catch { /* Már visszavonható volt. */ }
    }
    this._result = null;
    this._chunks = [];
    this._size = 0;
    this._hasStarted = false;
    this._fatalError = false;
    this._requestedMimeType = '';
    this._preparePromise = null;
    this._resolveStop?.(null);
    this._resolveStop = null;
    this._stopPromise = null;
    this._error = '';
  }

  async discard() {
    this._reset();
    this._setState('idle');
  }

  prepare() {
    if (this._state === 'preparing') return this._preparePromise;
    if (['ready', 'recording', 'paused'].includes(this._state)) return Promise.resolve(true);
    this._reset();
    if (!RoundRecorder.supported()) {
      this._error = friendlyError({ name: 'NotSupportedError' });
      this._fatalError = true;
      this._setState('error');
      return Promise.resolve(false);
    }

    const generation = this._generation;
    this._state = 'preparing';
    const promise = (async () => {
      let stream;
      try {
        stream = await mediaDevices().getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
        if (generation !== this._generation) {
          stopStream(stream);
          return false;
        }
        this._stream = stream;
        const Recorder = mediaRecorderClass();
        let recorder;
        for (const mimeType of MIME_TYPES) {
          if (typeof Recorder.isTypeSupported !== 'function' || !Recorder.isTypeSupported(mimeType)) continue;
          try {
            recorder = new Recorder(stream, { mimeType });
            this._requestedMimeType = mimeType;
            break;
          } catch { /* Másik, támogatottnak jelzett formátumot is kipróbálunk. */ }
        }
        recorder ??= new Recorder(stream);
        this._recorder = recorder;
        recorder.ondataavailable = event => {
          if (generation !== this._generation || this._recorder !== recorder) return;
          const chunk = event?.data;
          if (!chunk?.size) return;
          if (this._size + chunk.size > MAX_RECORDING_BYTES) {
            this._error = 'A felvétel elérte a 100 MiB méretkorlátot, ezért leállt. Az addigi videó menthető.';
            this._notify();
            if (generation === this._generation && this._recorder === recorder) void this.stop();
            return;
          }
          this._chunks.push(chunk);
          this._size += chunk.size;
        };
        recorder.onerror = event => {
          if (generation !== this._generation || this._recorder !== recorder) return;
          this._error = friendlyError(event?.error);
          this._fatalError = true;
          this._notify();
          if (generation === this._generation && this._recorder === recorder) void this.stop();
        };
        recorder.onstop = () => {
          if (generation !== this._generation || this._recorder !== recorder) return;
          if (!this._stopPromise) void this.stop();
          this._finishStop(generation);
        };
        for (const track of stream.getTracks()) {
          const ended = () => {
            if (generation !== this._generation || this._state === 'stopping') return;
            this._error = 'A kamera vagy a mikrofon kapcsolata megszakadt. A játék tovább folytatható.';
            this._fatalError = true;
            this._notify();
            if (generation === this._generation && this._recorder === recorder) void this.stop();
          };
          track.addEventListener('ended', ended);
          this._trackListeners.push([track, ended]);
        }
        this._setState('ready');
        return generation === this._generation && this._state === 'ready';
      } catch (error) {
        if (generation !== this._generation) {
          stopStream(stream);
          return false;
        }
        this._detachRecorder();
        this._recorder = null;
        this._stopTracks();
        this._error = friendlyError(error);
        this._fatalError = true;
        this._setState('error');
        return false;
      }
    })();
    this._preparePromise = promise;
    this._notify();
    return promise;
  }

  start() {
    if (this._state !== 'ready' || !this._recorder) return false;
    const recorder = this._recorder;
    const generation = this._generation;
    try {
      this._hasStarted = true;
      recorder.start(1000);
      if (this._recorder !== recorder || this._fatalError || this._stopPromise) return false;
      this._maxTimer = setTimeout(() => {
        if (generation !== this._generation || this._recorder !== recorder) return;
        this._error = 'A felvétel elérte az 5 perces időkorlátot, ezért leállt. Az addigi videó menthető.';
        this._notify();
        if (generation === this._generation && this._recorder === recorder) void this.stop();
      }, MAX_RECORDING_MS);
      this._maxTimer?.unref?.();
      this._setState('recording');
      return true;
    } catch (error) {
      this._error = friendlyError(error);
      this._fatalError = true;
      this._detachRecorder();
      this._stopTracks();
      this._recorder = null;
      this._chunks = [];
      this._size = 0;
      this._setState('error');
      return false;
    }
  }

  pause() {
    if (this._state !== 'recording' || !this._recorder) return false;
    const generation = this._generation;
    const recorder = this._recorder;
    try {
      this._recorder.pause();
      this._setState('paused');
      return true;
    } catch (error) {
      this._error = friendlyError(error);
      this._fatalError = true;
      this._notify();
      if (generation === this._generation && this._recorder === recorder) void this.stop();
      return false;
    }
  }

  resume() {
    if (this._state !== 'paused' || !this._recorder) return false;
    const generation = this._generation;
    const recorder = this._recorder;
    try {
      this._recorder.resume();
      this._setState('recording');
      return true;
    } catch (error) {
      this._error = friendlyError(error);
      this._fatalError = true;
      this._notify();
      if (generation === this._generation && this._recorder === recorder) void this.stop();
      return false;
    }
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (this._state === 'preparing') {
      void this.discard();
      return Promise.resolve(null);
    }
    if (!this._recorder) {
      this._stopTracks();
      return Promise.resolve(this._result);
    }
    if (!this._hasStarted) {
      this._detachRecorder();
      this._stopTracks();
      this._recorder = null;
      this._setState(this._fatalError ? 'error' : 'finished');
      return Promise.resolve(null);
    }

    const generation = this._generation;
    const recorder = this._recorder;
    this._stopPromise = new Promise(resolve => { this._resolveStop = resolve; });
    const promise = this._stopPromise;
    if (this._maxTimer !== null) clearTimeout(this._maxTimer);
    this._maxTimer = null;
    this._stopTracks();
    this._stopTimer = setTimeout(() => {
      if (generation !== this._generation) return;
      if (!this._error) this._error = 'A felvétel lezárása nem fejeződött be. Az addigi videó menthető lehet.';
      this._finishStop(generation);
    }, STOP_TIMEOUT_MS);
    this._stopTimer?.unref?.();
    this._setState('stopping');
    try {
      if (generation === this._generation && this._recorder === recorder && recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      this._error = friendlyError(error);
      this._fatalError = true;
      this._finishStop(generation);
    }
    return promise;
  }

  _finishStop(generation) {
    if (generation !== this._generation || !this._resolveStop) return;
    this._clearTimers();
    this._stopTracks();
    this._detachRecorder();
    const mimeType = this._recorder?.mimeType || this._chunks[0]?.type || this._requestedMimeType || 'video/webm';
    this._recorder = null;
    try {
      if (this._chunks.length) {
        const blob = new Blob(this._chunks, { type: mimeType });
        if (blob.size) {
          this._result = {
            blob,
            url: globalThis.URL.createObjectURL(blob),
            mimeType,
            extension: mimeType.toLowerCase().includes('mp4') ? 'mp4' : 'webm',
          };
        }
      }
      if (!this._result && !this._error) {
        this._error = 'Nem érkezett menthető videóadat. A játék felvétel nélkül folytatható.';
        this._fatalError = true;
      }
    } catch (error) {
      this._error = friendlyError(error);
      this._fatalError = true;
    }
    this._chunks = [];
    this._size = 0;
    const resolve = this._resolveStop;
    this._resolveStop = null;
    this._setState(this._fatalError ? 'error' : 'finished');
    resolve(this._result);
  }
}
