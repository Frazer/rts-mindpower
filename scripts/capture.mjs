/**
 * Shared by the video scripts (video.mjs, short.mjs): headless Chrome over the DevTools protocol,
 * a fake clock for the page so every frame is exactly 1/FPS of game time, and an ffmpeg pipe.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Chrome over the DevTools protocol ───

export function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  return found;
}

export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'mindblobs-video-'));
  const proc = spawn(
    findChrome(),
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) throw new Error('Chrome did not start');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  const session = await connect(page.webSocketDebuggerUrl);
  // Page events must be on for scripts added with addScriptToEvaluateOnNewDocument to run.
  await session.send('Page.enable');
  return {
    ...session,
    async close() {
      session.close();
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject: fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expression).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  return { send, evaluate, waitFor, close: () => ws.close() };
}

// ─── code that runs inside the page ───

/**
 * Installed before the page's own scripts. Until __clock.start(), time is real. After it,
 * performance.now, animation frames and timers only move when __clock.step(ms) is called.
 */
export function fakeClock() {
  const real = {
    now: performance.now.bind(performance),
    raf: window.requestAnimationFrame.bind(window),
    st: window.setTimeout.bind(window),
    si: window.setInterval.bind(window),
    ct: window.clearTimeout.bind(window),
    ci: window.clearInterval.bind(window),
  };
  let on = false;
  let t = 0;
  let nextId = 1e7;
  const frames = new Map();
  const timers = new Map();
  performance.now = () => (on ? t : real.now());
  window.requestAnimationFrame = (cb) => {
    if (!on) return real.raf(cb);
    frames.set(++nextId, cb);
    return nextId;
  };
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  window.cancelAnimationFrame = (id) => (frames.delete(id) ? undefined : cancelFrame(id));
  const timer = (every) => (fn, ms = 0, ...args) => {
    if (!on) return (every ? real.si : real.st)(fn, ms, ...args);
    const gap = Math.max(every ? 1 : 0, Number(ms) || 0);
    timers.set(++nextId, { at: t + gap, every: every ? gap : 0, fn, args });
    return nextId;
  };
  window.setTimeout = timer(false);
  window.setInterval = timer(true);
  window.clearTimeout = (id) => (timers.delete(id) ? undefined : real.ct(id));
  window.clearInterval = (id) => (timers.delete(id) ? undefined : real.ci(id));
  window.__clock = {
    start() {
      t = real.now();
      on = true;
    },
    step(ms) {
      t += ms;
      const due = [...timers].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at);
      for (const [id, x] of due) {
        if (x.every) x.at += x.every;
        else timers.delete(id);
        if (typeof x.fn === 'function') x.fn(...x.args);
      }
      const ready = [...frames.values()];
      frames.clear();
      for (const cb of ready) cb(t);
    },
  };
}

// ─── encoding ───

export function ffmpeg(args) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, fail) => p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`)))));
  return { stdin: p.stdin, done };
}

