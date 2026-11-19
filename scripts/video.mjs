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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { fakeClock, ffmpeg, launchChrome } from './capture.mjs';

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

// ─── code that runs inside the page ───

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
