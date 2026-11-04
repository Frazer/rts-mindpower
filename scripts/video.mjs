#!/usr/bin/env node
/**
 * Records the gameplay preview videos portals ask for (CrazyGames: 15-20 s, 1080p, landscape 16:9
 * and portrait 2:3, no sound, opening on the cover) into art/videos/.
 *
 * It plays a real game in headless Chrome on a fake clock: every video frame advances the game by
 * exactly 1/FPS of a second, so the video is smooth and plays at true speed however slow capturing is.
 * The seed fixes the game itself, so every recording shows the same moves; small touches like blinks
 * and sparkle drift aren't seeded, so they differ a little each time. Frames go straight to ffmpeg.
 *
 * The scene is tuned to seed 42 (where the crowd is, when befriending starts). If a balance change
 * makes it dull, try another SEED and CROWD and look at the frames again.
 *
 * Usage: npm run video   (needs Google Chrome and ffmpeg; set CHROME=/path/to/chrome to pick a browser)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'art/videos');
const FPS = 30;
/** Seconds of gameplay after the intro. With the intro the video is about 17.5 s. */
const GAMEPLAY = 16.5;
/** The cover is held this long, then fades into the game over FADE. */
const INTRO = 0.6;
const FADE = 0.4;
/** The world and every move in it come from this. */
const SEED = 42;

const FORMATS = [
  // Laptop-sized page at 1.5x, so the HUD and blobs are the size players see them, in a 1920x1080 frame.
  // zoom: [start, after the push-in, after the closing pull-back]
  { name: 'crazygames-landscape', css: [1280, 720], scale: 1.5, cover: 'crazygames-landscape', zoom: [2.1, 2.45, 1.2] },
  // Phone-sized page at 2x: the phone layout, in a 1080x1620 (2:3) frame.
  { name: 'crazygames-portrait', css: [540, 810], scale: 2, cover: 'crazygames-portrait', zoom: [1.75, 2.05, 1.4] },
];

// ─── Chrome over the DevTools protocol ───

function findChrome() {
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

async function launchChrome() {
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
function fakeClock() {
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

/**
 * The scene: the blue blobs walk into a crowd of wanderers (with pink and orange rivals after the
 * same crowd) and befriend them one by one. The camera follows the blue group and slowly pushes in.
 * The first seconds of walking happen off camera.
 */
function scene({ fps, seconds, zoom }) {
  const g = window.__game;
  const w = g.world;
  const cam = g.r.camera;
  const PLAYER = 1;
  const CROWD = { x: 1000, y: 895 };
  const PREROLL = 13.5; // seconds of game time before the first frame: the group is just reaching the crowd

  const own = () => w.blobs.filter((b) => b.faction === PLAYER && b.role !== 'police');
  // Give an order the way a tap does (with the tap's pink ring), without the selection panel showing.
  const befriend = (x, y) => {
    g.selected = new Set(own().map((b) => b.id));
    g.befriendAt(x, y, null);
    g.selected.clear();
  };
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  /**
   * Where the action is: the middle of the blue group near `around` (median, so a straggler doesn't
   * drag the camera), then the average of everyone near that, so the crowd being befriended is in frame too.
   */
  const action = (around) => {
    const near = own().filter((b) => Math.hypot(b.x - around.x, b.y - around.y) < 380);
    const group = near.length >= 3 ? near : own();
    const mid = { x: median(group.map((b) => b.x)), y: median(group.map((b) => b.y)) };
    const all = w.blobs.filter((b) => b.role !== 'police' && Math.hypot(b.x - mid.x, b.y - mid.y) < 260);
    return { x: mean(all.map((b) => b.x)), y: mean(all.map((b) => b.y)) };
  };
  /**
   * Where the camera must be for world point p to sit midway between the top bar and the build bar.
   * (Not hud.freeArea(): that also keeps room for the selection panel, which never shows here.)
   */
  const camFor = (p) => {
    const top = document.querySelector('#hud .top').getBoundingClientRect().bottom;
    const bottom = document.querySelector('#hud .build').getBoundingClientRect().top;
    return { x: p.x, y: p.y - ((top + bottom) / 2 - cam.sh / 2) / cam.zoom };
  };

  __clock.start();
  g.paused = true;
  befriend(CROWD.x, CROWD.y);
  for (let i = 0; i < PREROLL * 20; i++) w.tick(1 / 20);
  w.drainEvents();
  g.paused = false;
  // Clear the welcome tip and use up the one-time teaching tip; toasts about what happens on camera still show.
  document.querySelector('.toasts')?.replaceChildren();
  g.once('tipTeach', Infinity);

  cam.zoom = zoom[0];
  cam.resize(g.r.app.screen.width, g.r.app.screen.height);
  let focus = action({ x: median(own().map((b) => b.x)), y: median(own().map((b) => b.y)) });
  Object.assign(cam, camFor(focus));

  const ease = (x) => x * x * (3 - 2 * x);
  let reorder = false;
  window.__frame = (i) => {
    const s = i / fps;
    if (!reorder && s >= 1.4) {
      // A second tap on the crowd: the pink ring shows the player giving the order, and new friends join in.
      reorder = true;
      const wild = w.blobs.filter((b) => b.faction === 0 && Math.hypot(b.x - cam.x, b.y - cam.y) < 300);
      const c = wild.length ? { x: wild.reduce((a, b) => a + b.x, 0) / wild.length, y: wild.reduce((a, b) => a + b.y, 0) / wild.length } : CROWD;
      befriend(c.x, c.y);
    }
    // Push in slowly on the befriending, then pull back at the end to show the towns around it.
    const pull = seconds - 4;
    cam.zoom =
      s < pull
        ? zoom[0] + (zoom[1] - zoom[0]) * ease(s / pull)
        : zoom[1] + (zoom[2] - zoom[1]) * ease(Math.min(1, (s - pull) / 3.2));
    const target = action(focus);
    const k = 1 - Math.exp(-1 / fps / 1.1); // eases toward the action over about a second
    focus = { x: focus.x + (target.x - focus.x) * k, y: focus.y + (target.y - focus.y) * k };
    Object.assign(cam, camFor(focus));
    __clock.step(1000 / fps);
  };
  return own().length;
}

// ─── recording ───

function ffmpeg(args) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, fail) => p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`)))));
  return { stdin: p.stdin, done };
}

async function record(fmt, base) {
  const [cw, ch] = fmt.css;
  const W = Math.round(cw * fmt.scale);
  const H = Math.round(ch * fmt.scale);
  const chrome = await launchChrome();
  const tmp = mkdtempSync(join(tmpdir(), 'mindblobs-cover-'));
  try {
    // First frame: the cover, drawn at the video's size.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.navigate', { url: `${base}art/cover.html?format=${fmt.cover}&w=${W}&h=${H}` });
    await chrome.waitFor('window.__ready && document.querySelector("svg") !== null');
    await chrome.evaluate('window.__ready');
    const cover = join(tmp, 'cover.png');
    writeFileSync(cover, Buffer.from((await chrome.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    // The game, on the fake clock.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: cw, height: ch, deviceScaleFactor: fmt.scale, mobile: false });
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${fakeClock})()` });
    await chrome.send('Page.navigate', { url: `${base}?mode=casual&seed=${SEED}` });
    await chrome.waitFor('!!window.__game');
    await chrome.evaluate(`(${scene})(${JSON.stringify({ fps: FPS, seconds: GAMEPLAY, zoom: fmt.zoom })})`);
    // Pixi had already asked for one real animation frame; let it land so every later frame is on the fake clock.
    await new Promise((r) => setTimeout(r, 300));

    const out = join(OUT, `${fmt.name}.mp4`);
    const enc = ffmpeg([
      '-loop', '1', '-framerate', String(FPS), '-t', String(INTRO + FADE), '-i', cover,
      '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      // Standard (TV) colour range: Chrome's JPEG frames are full range, which some players show washed out.
      '-filter_complex',
      `[0]scale=${W}:${H}:out_range=tv,setsar=1,format=yuv420p[c];[1]scale=${W}:${H}:in_range=pc:out_range=tv,setsar=1,format=yuv420p[g];` +
        `[c][g]xfade=transition=fade:duration=${FADE}:offset=${INTRO},format=yuv420p`,
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
      '-movflags', '+faststart', '-an', out,
    ]);
    const frames = Math.round(GAMEPLAY * FPS);
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      await chrome.evaluate(`__frame(${i})`);
      const shot = await chrome.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true });
      const buf = Buffer.from(shot.data, 'base64');
      if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
      if (i % FPS === 0) process.stdout.write(`\r${fmt.name}: ${Math.round((i / frames) * 100)}%`);
    }
    enc.stdin.end();
    await enc.done;
    console.log(`\r${fmt.name}: art/videos/${fmt.name}.mp4  ${W}x${H}, ${(INTRO + GAMEPLAY).toFixed(1)} s, recorded in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    await chrome.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5190, host: '127.0.0.1' } });
await server.listen();
const base = server.resolvedUrls.local[0];
try {
  const only = process.argv[2];
  for (const fmt of FORMATS) if (!only || fmt.name.includes(only)) await record(fmt, base);
} finally {
  await server.close();
}
