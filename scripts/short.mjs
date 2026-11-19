#!/usr/bin/env node
/**
 * Records a vertical clip for YouTube Shorts and Instagram Reels into art/videos/short.mp4:
 * 1080x1920, about 24 s, with captions and the game's own sound effects.
 *
 *   1. The hook, then blue blobs chatting a crowd of strangers into joining them.
 *   2. A few minutes later: the same town, grown (the computer plays blue, kindly, for the skip).
 *   3. An end card with the name and where to play.
 *
 * Like video.mjs it plays a real game in headless Chrome on a fake clock, one game frame per
 * video frame. Chrome can't record its own sound headless, so every sound the game asks for is
 * logged with its time and then played again into an OfflineAudioContext, which gives the
 * soundtrack. The captions are HTML laid over the game, so they use the game's font.
 *
 * Usage: npm run video:short             the video
 *        npm run video:short -- --stills a few PNG frames in art/videos/short-stills/, to check framing fast
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { fakeClock, ffmpeg, launchChrome } from './capture.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'art/videos');
const FPS = 30;
const SEED = 42;
/** A phone-sized page at 2x: the phone layout, in a 1080x1920 (9:16) frame. */
const CSS = [540, 960];
const SCALE = 2;
/** Video seconds for each part. */
const PART = { befriend: 12, later: 8, end: 4 };
/** Game seconds that pass between part 1 and part 2. */
const SKIP = 240;
const ITCH = 'neojex.itch.io/mind-blobs';

const CAPTIONS = [
  { from: 0, to: 3.1, html: 'An RTS where you win<br>by making friends 💗', size: 34 },
  { from: 3.3, to: 7.5, html: 'Send your friendliest blobs<br>to chat with strangers…' },
  { from: 7.7, to: 12, html: '…until they join you!' },
  { from: 12, to: 14, html: 'A few minutes later…', size: 24 },
  { from: 14.2, to: 20, html: 'Grow a whole town<br>of friends' },
];

/** Times (video seconds) saved as stills with --stills. */
const STILLS = [0.5, 2.5, 5, 8, 11.5, 12.5, 15, 19, 20.6, 23.5];

// ─── code that runs inside the page ───

/** Before the game loads: skip the first-game guide and the "new buttons" tips, which would cover the captions. */
function quietStart() {
  try {
    localStorage.setItem('mindblobs.coached.v1', '1');
    localStorage.setItem('mindblobs.unlocks.v1', JSON.stringify(['nearby', 'stop', 'usurp', 'jobs', 'attack']));
  } catch {}
}

async function scene({ fps, part, skip, captions, itch }) {
  const g = window.__game;
  const w = g.world;
  const cam = g.r.camera;
  const PLAYER = 1;
  const audio = await import('/src/audio.ts');

  // ── sound: log what the game plays (with the same gaps the game keeps between repeats) ──
  let now = 0;
  let listening = true;
  const heard = [];
  const last = new Map();
  audio.sound.play = (name) => {
    if (!listening) return;
    if (now - (last.get(name) ?? -Infinity) < (audio.GAP[name] ?? 0)) return;
    last.set(name, now);
    heard.push([now, name]);
  };
  window.__soundtrack = async (seconds) => {
    const rate = 48000;
    const c = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
    const out = c.createGain();
    out.gain.value = audio.VOLUME;
    out.connect(c.destination);
    for (const [t, name] of heard) audio.sound.playInto(c, out, name, t);
    backingTune(c, out, seconds);
    const d = (await c.startRendering()).getChannelData(0);
    const pcm = new Int16Array(d.length);
    for (let i = 0; i < d.length; i++) pcm[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
    const bytes = new Uint8Array(pcm.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { rate, sounds: heard.length, pcm: btoa(s) };
  };

  /**
   * A quiet music-box tune under the game's sounds, in C like the befriend chime: 100 bpm, so
   * one bar is 2.4 s and the cut to part 2 (12 s) lands on a bar line. It ends on a held C chord.
   */
  function backingTune(c, out, seconds) {
    const BAR = 2.4;
    const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
    const bus = c.createGain();
    bus.connect(out);
    bus.gain.setValueAtTime(1, Math.max(0, seconds - 0.6));
    bus.gain.linearRampToValueAtTime(0, seconds);
    const note = (type, midi, at, dur, vol) => {
      const o = c.createOscillator();
      const v = c.createGain();
      o.type = type;
      o.frequency.value = hz(midi);
      v.gain.setValueAtTime(0.0001, at);
      v.gain.exponentialRampToValueAtTime(vol, at + 0.008);
      v.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(v).connect(bus);
      o.start(at);
      o.stop(at + dur + 0.02);
    };
    // Chord tones from the root up (MIDI 60 = middle C): C, A minor, F, G.
    const C = [60, 64, 67], Am = [57, 60, 64], F = [53, 57, 60], G = [55, 59, 62];
    const bars = [C, Am, F, G, C, Am, F, G, C, C];
    const ARP = [0, 1, 2, 3, 2, 1, 2, 1]; // eighth notes; 3 is the root an octave up
    bars.forEach((chord, b) => {
      const t0 = b * BAR;
      if (t0 >= seconds) return;
      const tones = [...chord, chord[0] + 12];
      const last = b === bars.length - 1;
      // Bass on beats 1 and 3.
      note('triangle', chord[0] - 12, t0, last ? 2.2 : 0.55, 0.05);
      if (!last) note('triangle', chord[0] - 12, t0 + BAR / 2, 0.55, 0.04);
      if (last) {
        // The ending: one rising arpeggio, then the chord rings out.
        tones.forEach((m, k) => note('sine', m + 12, t0 + k * 0.12, 2.1 - k * 0.12, 0.03));
        return;
      }
      ARP.forEach((k, i) => note('sine', tones[k] + 12, t0 + i * (BAR / 8), 0.32, i % 2 ? 0.022 : 0.03));
    });
  }

  // ── overlay: captions and the end card ──
  const INK = '#3a2730';
  const CREAM = '#fff8ec';
  const outline = (r) =>
    Array.from({ length: 16 }, (_, k) => `${(r * Math.cos((k * Math.PI) / 8)).toFixed(1)}px ${(r * Math.sin((k * Math.PI) / 8)).toFixed(1)}px 0 ${INK}`).join(',');
  const style = document.createElement('style');
  style.textContent = `
    .toasts { display: none !important; }
    #short-cap { position: fixed; left: 0; right: 0; top: 150px; display: flex; justify-content: center; pointer-events: none; z-index: 9999; }
    #short-cap div { max-width: 480px; text-align: center; font: 700 30px/1.18 'Fredoka Variable', 'Fredoka', sans-serif; color: ${INK};
      background: ${CREAM}; border: 4px solid ${INK}; border-radius: 24px; padding: 10px 20px 12px; box-shadow: 0 6px 0 rgba(58,39,48,.35); }
    #short-end { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
      pointer-events: none; z-index: 9999; background: rgba(40, 26, 36, .45); }
    #short-end h1 { margin: 0 0 6px; font: 700 76px/1 'Fredoka Variable', 'Fredoka', sans-serif; color: ${CREAM}; letter-spacing: -1px;
      text-shadow: ${outline(6)}, 0 10px 0 ${INK}; }
    #short-end p { margin: 0; font: 600 27px/1.2 'Fredoka Variable', 'Fredoka', sans-serif; color: ${INK}; background: ${CREAM};
      border: 4px solid ${INK}; border-radius: 22px; padding: 9px 20px 11px; box-shadow: 0 6px 0 rgba(58,39,48,.35); }
    #short-end p.url { font-size: 24px; background: #ffd6e8; }
  `;
  document.head.append(style);
  const cap = document.createElement('div');
  cap.id = 'short-cap';
  const capText = document.createElement('div');
  cap.append(capText);
  const end = document.createElement('div');
  end.id = 'short-end';
  end.innerHTML = `<h1>Mind Blobs</h1><p>Free to play in your browser 💗</p><p class="url">${itch}</p>`;
  document.body.append(cap, end);

  const ease = (x) => x * x * (3 - 2 * x);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  let shown = -1;
  const showCaption = (s) => {
    const i = captions.findIndex((c) => s >= c.from && s < c.to);
    if (i !== shown) {
      shown = i;
      if (i >= 0) {
        capText.innerHTML = captions[i].html;
        capText.style.fontSize = `${captions[i].size ?? 30}px`;
        heard.push([s, 'select']); // a little blip as each caption pops in
      }
    }
    if (i < 0) {
      cap.style.opacity = '0';
      return;
    }
    const c = captions[i];
    // Pops in over 0.2 s; fades out over the last 0.15 s.
    const t = clamp01((s - c.from) / 0.2);
    const out = c.to - s < 0.15 ? clamp01((c.to - s) / 0.15) : 1;
    cap.style.opacity = String(Math.min(t * 2, 1) * out);
    cap.style.transform = `scale(${0.82 + 0.18 * (1 - (1 - t) ** 3) + 0.03 * Math.sin(Math.PI * t)})`;
  };

  // ── part 1: befriending a crowd ──
  const own = () => w.blobs.filter((b) => b.alive && b.faction === PLAYER && b.role !== 'police');
  const wild = () => w.blobs.filter((b) => b.alive && b.faction === 0);
  const befriend = (x, y) => {
    g.selected = new Set(own().map((b) => b.id));
    g.befriendAt(x, y, null);
    g.selected.clear();
  };
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const near = (list, p, r) => list.filter((b) => Math.hypot(b.x - p.x, b.y - p.y) < r);

  // The biggest crowd of strangers a short walk from town (not the little camp by the hall).
  const hall = w.hall(PLAYER);
  let crowd = null;
  let best = -Infinity;
  for (const b of wild()) {
    const d = Math.hypot(b.x - hall.x, b.y - hall.y);
    if (d < 420 || d > 1000) continue;
    const score = near(wild(), b, 140).length - d / 400;
    if (score > best) {
      best = score;
      crowd = b;
    }
  }
  const group = near(wild(), crowd, 140);
  const CROWD = { x: mean(group.map((b) => b.x)), y: mean(group.map((b) => b.y)) };

  const action = (around) => {
    const mine = near(own(), around, 380);
    const set = mine.length >= 3 ? mine : own();
    const mid = { x: median(set.map((b) => b.x)), y: median(set.map((b) => b.y)) };
    const all = near(
      w.blobs.filter((b) => b.alive && b.role !== 'police'),
      mid,
      260,
    );
    return { x: mean(all.map((b) => b.x)), y: mean(all.map((b) => b.y)) };
  };
  /** The camera spot that puts world point p midway between the top bar and the build bar. */
  const camFor = (p) => {
    const top = document.querySelector('#hud .top').getBoundingClientRect().bottom;
    const bottom = document.querySelector('#hud .build').getBoundingClientRect().top;
    return { x: p.x, y: p.y - ((top + bottom) / 2 - cam.sh / 2) / cam.zoom };
  };

  __clock.start();
  g.paused = true;
  befriend(CROWD.x, CROWD.y);
  // Walk there off camera: start as the group reaches the crowd.
  for (let i = 0; i < 25 * 20; i++) {
    w.tick(1 / 20);
    const m = own();
    if (Math.hypot(median(m.map((b) => b.x)) - CROWD.x, median(m.map((b) => b.y)) - CROWD.y) < 170) break;
  }
  w.drainEvents();
  g.paused = false;
  g.once('tipTeach', Infinity);

  const ZOOM1 = [1.7, 2.05];
  cam.zoom = ZOOM1[0];
  cam.resize(g.r.app.screen.width, g.r.app.screen.height);
  let focus = action(CROWD);
  Object.assign(cam, camFor(focus));

  // ── part 2: the town, minutes later ──
  let town = null;
  const skipAhead = () => {
    listening = false;
    const f = w.factions[PLAYER];
    // The computer plays blue for the skip, kindly (no bonking).
    const kept = f.ai;
    f.ai = { weights: { house: 2, school: 2, lab: 1, market: 2, police: 1, fountain: 2 }, aggression: 0, diplomacy: 1 };
    f.aiTimer = 0;
    for (let i = 0; i < skip * 20; i++) w.tick(1 / 20);
    f.ai = kept;
    w.drainEvents();
    listening = true;
    const mine = w.buildings.filter((b) => b.faction === PLAYER);
    const xs = mine.map((b) => b.x);
    const ys = mine.map((b) => b.y);
    const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    const span = Math.max(Math.max(...xs) - Math.min(...xs) + 260, (Math.max(...ys) - Math.min(...ys) + 260) * 0.75);
    const fit = Math.min(1.3, Math.max(0.45, cam.sw / span));
    town = { c, fit };
  };

  let reorder = false;
  const t2 = part.befriend;
  const t3 = part.befriend + part.later;
  window.__frame = (i) => {
    const s = i / fps;
    now = s;
    if (s < t2) {
      if (!reorder && s >= 1.4) {
        // A second tap on the crowd: the pink ring shows the order, and new friends join in.
        reorder = true;
        const left = near(wild(), cam, 300);
        befriend(left.length ? mean(left.map((b) => b.x)) : CROWD.x, left.length ? mean(left.map((b) => b.y)) : CROWD.y);
      }
      cam.zoom = ZOOM1[0] + (ZOOM1[1] - ZOOM1[0]) * ease(s / t2);
      const target = action(focus);
      const k = 1 - Math.exp(-1 / fps / 1.1);
      focus = { x: focus.x + (target.x - focus.x) * k, y: focus.y + (target.y - focus.y) * k };
      Object.assign(cam, camFor(focus));
    } else {
      if (!town) skipAhead();
      // Pull back slowly over the town, then further out under the end card.
      const a = ease(clamp01((s - t2) / part.later));
      const b = ease(clamp01((s - t3) / part.end));
      cam.zoom = town.fit * (1.15 - 0.15 * a) * (1 - 0.12 * b);
      Object.assign(cam, camFor(town.c));
    }
    showCaption(s);
    if (s >= t3 && s - 1 / fps < t3) heard.push([s, 'win']); // the end card arrives with the win tune
    const e = clamp01((s - t3) / 0.45);
    end.style.opacity = String(e);
    end.style.transform = `scale(${0.94 + 0.06 * ease(e)})`;
    __clock.step(1000 / fps);
  };
  return { crowd: CROWD, own: own().length, nearby: group.length };
}

// ─── recording ───

async function record(base, stills) {
  const [cw, ch] = CSS;
  const W = cw * SCALE;
  const H = ch * SCALE;
  const total = PART.befriend + PART.later + PART.end;
  const chrome = await launchChrome();
  const tmp = mkdtempSync(join(tmpdir(), 'mindblobs-short-'));
  try {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: cw, height: ch, deviceScaleFactor: SCALE, mobile: false });
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${quietStart})();(${fakeClock})()` });
    await chrome.send('Page.navigate', { url: `${base}?mode=casual&seed=${SEED}` });
    await chrome.waitFor('!!window.__game');
    await chrome.evaluate('document.fonts.ready.then(() => true)');
    const info = await chrome.evaluate(
      `(${scene})(${JSON.stringify({ fps: FPS, part: PART, skip: SKIP, captions: CAPTIONS, itch: ITCH })})`,
    );
    console.log(`crowd of ${info.nearby} at (${Math.round(info.crowd.x)}, ${Math.round(info.crowd.y)}), ${info.own} blue blobs`);
    // Pixi had already asked for one real animation frame; let it land so every later frame is on the fake clock.
    await new Promise((r) => setTimeout(r, 300));

    const frames = Math.round(total * FPS);
    const shot = async (format) =>
      Buffer.from((await chrome.send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 94 : undefined, optimizeForSpeed: true })).data, 'base64');

    if (stills) {
      const dir = join(OUT, 'short-stills');
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const want = new Set(STILLS.map((s) => Math.round(s * FPS)));
      for (let i = 0; i < frames; i++) {
        await chrome.evaluate(`__frame(${i})`);
        if (want.has(i)) writeFileSync(join(dir, `${(i / FPS).toFixed(1).padStart(4, '0')}s.png`), await shot('png'));
      }
      console.log(`stills in art/videos/short-stills/`);
      return;
    }

    const silent = join(tmp, 'video.mp4');
    const enc = ffmpeg([
      '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      // Standard (TV) colour range: Chrome's JPEG frames are full range, which some players show washed out.
      '-vf', `scale=${W}:${H}:in_range=pc:out_range=tv,setsar=1,format=yuv420p`,
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-an', silent,
    ]);
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      await chrome.evaluate(`__frame(${i})`);
      const buf = await shot('jpeg');
      if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
      if (i % FPS === 0) process.stdout.write(`\rshort: ${Math.round((i / frames) * 100)}%`);
    }
    enc.stdin.end();
    await enc.done;

    const sound = await chrome.evaluate(`__soundtrack(${total})`);
    const raw = join(tmp, 'sound.raw');
    writeFileSync(raw, Buffer.from(sound.pcm, 'base64'));
    const out = join(OUT, 'short.mp4');
    await ffmpeg([
      '-i', silent, '-f', 's16le', '-ar', String(sound.rate), '-ac', '1', '-i', raw,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,volume=2.5dB,aresample=48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
      '-shortest', '-movflags', '+faststart', out,
    ]).done;
    console.log(`\rshort: art/videos/short.mp4  ${W}x${H}, ${total} s, ${sound.sounds} sounds, recorded in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    await chrome.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5191, host: '127.0.0.1' } });
await server.listen();
try {
  await record(server.resolvedUrls.local[0], process.argv.includes('--stills'));
} finally {
  await server.close();
}
