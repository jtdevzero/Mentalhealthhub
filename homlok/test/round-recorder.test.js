import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundRecorder } from '../round-recorder.js';

const WEBM = 'video/webm;codecs=vp8,opus';
const MP4 = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
const failure = name => Object.assign(new Error(name), { name });

function makeStream() {
  const tracks = ['video', 'audio'].map(kind => {
    const listeners = new Set();
    return {
      kind,
      stopped: false,
      stop() { this.stopped = true; },
      addEventListener(type, fn) { if (type === 'ended') listeners.add(fn); },
      removeEventListener(type, fn) { if (type === 'ended') listeners.delete(fn); },
      end() { this.stopped = true; for (const fn of [...listeners]) fn(); },
    };
  });
  return { tracks, getTracks: () => tracks };
}

async function browser(options, run) {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const env = { stream: makeStream(), requests: [], recorders: [], urls: [], revoked: [] };
  class Recorder {
    static isTypeSupported(type) { return (options.types ?? [WEBM, 'video/webm']).includes(type); }
    constructor(stream, settings = {}) {
      if (options.constructorError) throw options.constructorError;
      this.stream = stream;
      this.mimeType = settings.mimeType ?? options.defaultMimeType ?? WEBM;
      this.state = 'inactive';
      env.recorders.push(this);
    }
    start(timeslice) {
      if (options.startError) throw options.startError;
      this.timeslice = timeslice;
      this.state = 'recording';
    }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    data(value = 'chunk') { this.ondataavailable?.({ data: value instanceof Blob ? value : new Blob([value], { type: this.mimeType }) }); }
    stop() {
      this.state = 'inactive';
      if (options.hangStop) return;
      queueMicrotask(() => {
        if (options.finalChunk !== false) this.data('final');
        this.onstop?.();
      });
    }
  }
  replace('isSecureContext', options.secure ?? true);
  replace('window', { MediaRecorder: options.unsupported ? undefined : Recorder });
  replace('navigator', {
    mediaDevices: {
      getUserMedia(constraints) {
        env.requests.push(constraints);
        return options.getUserMedia ? options.getUserMedia(env) : Promise.resolve(env.stream);
      },
    },
  });
  replace('URL', {
    createObjectURL(blob) { const url = `blob:local-${env.urls.length}`; env.urls.push({ url, blob }); return url; },
    revokeObjectURL(url) { env.revoked.push(url); },
  });
  try {
    await run(env);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('construction is inert and unavailable APIs fail without prompting', async () => {
  await browser({ unsupported: true }, async env => {
    let changes = 0;
    const recorder = new RoundRecorder({ onChange: () => { changes += 1; } });
    assert.equal(recorder.state, 'idle');
    assert.equal(recorder.result, null);
    assert.equal(changes, 0);
    assert.equal(env.requests.length, 0);
    assert.equal(RoundRecorder.supported(), false);
    assert.equal(await recorder.prepare(), false);
    assert.equal(recorder.state, 'error');
    assert.match(recorder.error, /nem támogatja/);
    assert.equal(env.requests.length, 0);
  });
  await browser({ secure: false }, async env => {
    assert.equal(await new RoundRecorder().prepare(), false);
    assert.equal(env.requests.length, 0);
  });
});

test('permission, missing device and busy-device failures are handled in Hungarian', async () => {
  for (const [name, message] of [
    ['NotAllowedError', /engedélye nincs megadva/],
    ['NotFoundError', /Nem található/],
    ['NotReadableError', /másik alkalmazás/],
  ]) {
    await browser({ getUserMedia: () => Promise.reject(failure(name)) }, async env => {
      const states = [];
      const recorder = new RoundRecorder({ onChange: value => states.push(value.state) });
      assert.equal(await recorder.prepare(), false);
      assert.match(recorder.error, message);
      assert.deepEqual(states, ['preparing', 'error']);
      assert.equal(env.recorders.length, 0);
      await recorder.discard();
      assert.equal(recorder.state, 'idle');
      assert.equal(recorder.error, '');
    });
  }
});

test('discard cancels a pending permission request and releases a late stream', async () => {
  let allow;
  await browser({ getUserMedia: () => new Promise(resolve => { allow = resolve; }) }, async env => {
    const recorder = new RoundRecorder();
    const pending = recorder.prepare();
    assert.equal(recorder.prepare(), pending);
    assert.equal(recorder.state, 'preparing');
    const discarded = recorder.discard();
    assert.equal(recorder.state, 'idle');
    await discarded;
    allow(env.stream);
    assert.equal(await pending, false);
    assert.ok(env.stream.tracks.every(track => track.stopped));
    assert.equal(env.recorders.length, 0);
    assert.equal(recorder.state, 'idle');
  });
});

test('record, pause, resume and stop produce a local WebM with immediate device release', async () => {
  await browser({}, async env => {
    const states = [];
    const recorder = new RoundRecorder({ onChange: value => states.push(value.state) });
    assert.equal(recorder.start(), false);
    assert.equal(await recorder.prepare(), true);
    assert.deepEqual(env.requests[0], {
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true,
    });
    assert.equal(recorder.pause(), false);
    assert.equal(recorder.start(), true);
    assert.equal(env.recorders[0].timeslice, 1000);
    env.recorders[0].data('first');
    assert.equal(recorder.pause(), true);
    assert.equal(recorder.pause(), false);
    assert.equal(recorder.resume(), true);
    assert.equal(recorder.resume(), false);
    const stopping = recorder.stop();
    assert.equal(recorder.state, 'stopping');
    assert.ok(env.stream.tracks.every(track => track.stopped));
    assert.equal(recorder.stop(), stopping);
    const result = await stopping;
    assert.equal(result.extension, 'webm');
    assert.equal(result.mimeType, WEBM);
    assert.equal(await result.blob.text(), 'firstfinal');
    assert.match(result.url, /^blob:/);
    assert.equal(recorder.result, result);
    assert.equal(recorder.state, 'finished');
    assert.equal(await recorder.stop(), result);
    assert.deepEqual(states, ['preparing', 'ready', 'recording', 'paused', 'recording', 'stopping', 'finished']);
    const discarded = recorder.discard();
    assert.equal(recorder.result, null);
    assert.deepEqual(env.revoked, [result.url]);
    await discarded;
  });
});

test('MP4 is preferred when supported and a fresh prepare frees the old video', async () => {
  await browser({ types: [WEBM, MP4] }, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    recorder.start();
    const result = await recorder.stop();
    assert.equal(result.mimeType, MP4);
    assert.equal(result.extension, 'mp4');
    assert.equal(await recorder.prepare(), true);
    assert.equal(recorder.state, 'ready');
    assert.equal(recorder.result, null);
    assert.deepEqual(env.revoked, [result.url]);
    await recorder.discard();
  });
});

test('stopping a prepared camera creates no empty video and releases both tracks', async () => {
  await browser({}, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    assert.equal(await recorder.stop(), null);
    assert.equal(recorder.state, 'finished');
    assert.equal(env.urls.length, 0);
    assert.ok(env.stream.tracks.every(track => track.stopped));
  });
});

test('discard settles a pending stop and ignores late recorder events', async () => {
  await browser({ hangStop: true }, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    recorder.start();
    env.recorders[0].data();
    const stopping = recorder.stop();
    await recorder.discard();
    assert.equal(await stopping, null);
    env.recorders[0].data('too late');
    env.recorders[0].onstop?.();
    assert.equal(env.urls.length, 0);
    assert.equal(recorder.state, 'idle');
  });
});

test('an ended device stops every track and preserves already recorded data', async () => {
  await browser({}, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    recorder.start();
    env.recorders[0].data('before interruption');
    env.stream.tracks[0].end();
    assert.ok(env.stream.tracks.every(track => track.stopped));
    const result = await recorder.stop();
    assert.ok(result.blob.size > 0);
    assert.match(recorder.error, /kapcsolata megszakadt/);
    assert.equal(recorder.state, 'error');
    await recorder.discard();
  });
});

test('start and recorder errors release devices without rejecting a gameplay call', async () => {
  await browser({ startError: failure('NotSupportedError') }, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    assert.equal(recorder.start(), false);
    assert.equal(recorder.state, 'error');
    assert.ok(env.stream.tracks.every(track => track.stopped));
    assert.equal(await recorder.stop(), null);
  });
  await browser({}, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    recorder.start();
    env.recorders[0].onerror({ error: failure('NotReadableError') });
    assert.ok(env.stream.tracks.every(track => track.stopped));
    await recorder.stop();
    assert.equal(recorder.state, 'error');
    assert.match(recorder.error, /másik alkalmazás/);
    await recorder.discard();
  });
});

test('the memory cap stops recording without retaining an oversized chunk', async () => {
  await browser({}, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    recorder.start();
    env.recorders[0].data('small');
    env.recorders[0].ondataavailable({ data: { size: 100 * 1024 * 1024, type: WEBM } });
    assert.ok(env.stream.tracks.every(track => track.stopped));
    const result = await recorder.stop();
    assert.equal(await result.blob.text(), 'smallfinal');
    assert.match(recorder.error, /100 MiB/);
    assert.equal(recorder.state, 'finished');
    await recorder.discard();
  });
});

test('a missing stop event is bounded to four seconds with devices already released', async () => {
  await browser({ hangStop: true }, async env => {
    const recorder = new RoundRecorder();
    await recorder.prepare();
    recorder.start();
    env.recorders[0].data('saved');
    const original = globalThis.setTimeout;
    let timeout;
    globalThis.setTimeout = (callback, milliseconds) => {
      assert.equal(milliseconds, 4000);
      timeout = callback;
      return { unref() {} };
    };
    try {
      const stopping = recorder.stop();
      assert.ok(env.stream.tracks.every(track => track.stopped));
      timeout();
      const result = await stopping;
      assert.equal(await result.blob.text(), 'saved');
      assert.match(recorder.error, /lezárása nem fejeződött be/);
      await recorder.discard();
    } finally {
      globalThis.setTimeout = original;
    }
  });
});

test('observer exceptions and cancellation inside an observer do not leak resources', async () => {
  await browser({}, async env => {
    const recorder = new RoundRecorder({ onChange: () => { throw new Error('UI error'); } });
    assert.equal(await recorder.prepare(), true);
    assert.equal(recorder.start(), true);
    await recorder.stop();
    await recorder.discard();
    assert.ok(env.stream.tracks.every(track => track.stopped));
  });
  await browser({}, async env => {
    const recorder = new RoundRecorder({ onChange: value => {
      if (value.state === 'stopping') void value.discard();
    } });
    await recorder.prepare();
    recorder.start();
    assert.equal(await recorder.stop(), null);
    assert.equal(recorder.state, 'idle');
    assert.equal(recorder.error, '');
    assert.ok(env.stream.tracks.every(track => track.stopped));
  });
});
