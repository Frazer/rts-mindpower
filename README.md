# Mind Blobs

A cartoon-blob real-time strategy game. You grow an empire mostly by **winning blobs over**. Fighting is possible, but police arrest attackers, and the better a society's tech, the better its police.

Built with TypeScript, PixiJS v8 and Vite. There is one simulation with two tunings: **Casual** (mobile, relaxed) and **Pro** (PC, fast, every stat shown).

**Play it free in your browser:** https://frazer.github.io/rts-mindpower/ (also on itch.io: https://neojex.itch.io/mind-blobs). Every push to `main` updates the GitHub Pages copy.

```bash
npm install
npm run dev        # http://localhost:5173  (?mode=casual|pro&seed=123 skips the menu, add &tut=hello for a tutorial)
npm test           # headless sim tests + balance tables (add --silent=false to see them)
npm run build      # type-check + production bundle in dist/
npm run package    # every build (web, CrazyGames, Poki), zipped in release/ for upload
npm run art        # portal covers and thumbnails, rendered to art/covers/ (needs Google Chrome)
npm run video      # gameplay preview videos in art/videos/ (needs Google Chrome and ffmpeg)
npm run video:short  # vertical Shorts/Reels clip with captions and sound: art/videos/short.mp4
```

## How it plays

| | Casual | Pro |
|---|---|---|
| Select | tap a blob | click, Shift+click, drag box, Ctrl+A, Ctrl+1–9 / 1–9 groups |
| Befriend a crowd | select yours, tap a stranger or just beside one (or **Befriend**, then tap a crowd) | right-click a stranger, or **F** then click |
| Walk | select yours, tap open grass; **✕** on the panel lets go | right-click the ground, or **G** then click |
| Teach | select yours, **Teach**, tap a teammate | right-click a teammate, or **C** then click |
| Take over a building | select yours, tap a rival building | right-click a rival building, or **U** then click |
| Find your best blobs | **👥 Team** | **Tab** |
| Pick a group | double-tap one of yours (or **Select nearby**) to pick the blobs around it, or Team → Select top 5 | drag a box, or double-click one of yours to pick the blobs around it |
| Bonk (violence) | **Bonk** button | **X** then click / right-click |
| Build | tap a button, tap your land | **Q W E R T Y** (Shift keeps placing) |
| Level up buildings | tap one, **Level up**; double-tap one (or **Select all**) to level up every one of that kind | click one, **V**; double-click one to pick every one of that kind, then **V** |
| Camera | drag, pinch | wheel zoom, right-drag pan, arrows, minimap, **H** home |
| Other | 🔊 mute button | **S** stop, **G** move, Space pause, +/- speed, **M** mute |

The menu only offers Pro on devices with a mouse or trackpad, or once a key has been pressed. Phones and tablets get Casual only (`?mode=pro` still forces it, for testing).

**A new player's first game:** a "First steps" card and a bobbing label walk you through picking a blob and befriending the strangers camped just outside your town, until your first new friend joins. It shows once. In Casual, the computer teams also hold off for the first minute before they send anyone out, and every town starts with a few wanderers of its own nearby.

**Buttons arrive as you play (Casual):** a blob's panel starts with 💗 Befriend, 📚 Teach and 🚶 Move. Select nearby and Stop come with your first new friend, then Take over, then jobs (or as soon as you build a school), then Bonk, each with a word on what it does. Once you've met a button it stays for every later game, and finishing every Casual tutorial brings them all in. Pro shows everything from the start.

You win by leading 90% of all blobs. When the game ends, charts show how every team's blobs, income, buildings and tech went over the game; you can close the results and pan around the map.

**Online:** 🌐 Play online lists the public games waiting for players; tap one to join, or make a game and share its code. The host can switch a game to private, so only people with the code can join.

## Tutorials

Each mode has its own list of little levels on the menu (🎓 Tutorials). Each level is a small hand-built map with the rival AI switched off, and it shows one or two ideas. A card at the top gives the current step and ticks it off when you do it. A bobbing label points at the blob or building the step is about. The wording follows the mode: taps in Casual, mouse and keys in Pro.

| # | Level | Shows |
|---|---|---|
| 1 | 👋 Say hello | selecting, befriending |
| (Pro) | ⌨️ Pro controls | box select, Ctrl+1 / 1 groups, right-click |
| 2 | 👥 Make lots of friends | group select, befriending a crowd |
| 3 | 🏠 Room for babies | houses, babies |
| 4 | 🏫 School days | schools, choosing what they teach |
| 5 | 🎓 Pass it on | Team panel, Teach, the Teacher job |
| 6 | ⛲ Friendship Fountain | fountains |
| 7 | 🏳️ Take it over | taking over a building |
| 8 | 🚓 Keep the peace | police and violence |
| 9 | 🌍 Unite the island | everything, with the normal 90% win |

Finished levels get a ✓ in the list. Progress is kept per mode in this browser's `localStorage` (if storage is blocked it lasts for the visit). Levels are defined in `src/tutorials.ts`: a setup function, steps with a `done` check, and optional progress bars and pointers. `tests/tutorials.test.ts` plays every level in both modes to prove each can be finished.

## Publishing

There are three builds of the same game. They differ only in which portal SDK they talk to:

| Build | Command | Output | For |
|---|---|---|---|
| Web | `npm run build` | `dist/` | itch.io, GitHub Pages, your own site. No ads. |
| CrazyGames | `npm run build:crazygames` | `dist-crazygames/` | CrazyGames SDK v3: ads, gameplay events, cloud save |
| Poki | `npm run build:poki` | `dist-poki/` | Poki SDK v2: ads, gameplay events |

`npm run package` builds all three and zips each one into `release/`, ready to upload. Each build only includes its own portal's SDK (portals can reject games that mention a rival's).

`src/platform.ts` is the only file that talks to a portal:
- **Gameplay start/stop** follow whether you're actually playing: not paused, not in a menu, not on the end screen, not watching an ad.
- **Ad breaks (midgame)** happen only at natural breaks, when you start another game or tutorial level after the first. Never mid-match, and never on Menu/Back buttons.
- **Rewarded ad (Poki only):** a 📺 +75 button appears under the stats in real games (not tutorials) every 3 game-minutes. Watching the ad gives 75 gold. The CrazyGames build doesn't show it: CrazyGames doesn't allow a reward button on the screen while you play, and Basic Launch has no ads anyway.
- **From the moment an ad is asked for,** the game pauses and ignores taps. It goes silent when the ad actually starts, as CrazyGames asks. On Poki it goes silent straight away, because Poki's start callback can be skipped.
- **If CrazyGames says ads are off** for the session (Basic Launch, Kids mode, offline), the game stops asking for them.
- **Saves** (tutorial ticks, mute) use the CrazyGames cloud save on CrazyGames, and `localStorage` elsewhere.
- **If a portal SDK fails to load** (ad blockers), the game runs as the plain web build.

**Try a portal in dev:** `?platform=crazygames` or `?platform=poki`. Both SDKs run in a local test mode on localhost, with placeholder ads.

**Other things portals check, already handled:**
- Relative asset paths.
- No outside requests: the Fredoka font is bundled.
- Arrow keys and the mouse wheel don't scroll the page around the game.
- Audio resumes on iOS after a tap.
- A loading screen.

**Covers and thumbnails** are in `art/covers/`. They're drawn in `art/cover.html` with the game's own blob shapes and colours, and rendered by `npm run art` with headless Chrome:

| File | Size | For |
|---|---|---|
| `crazygames-landscape.png` | 1920×1080 | CrazyGames landscape cover |
| `crazygames-portrait.png` | 800×1200 | CrazyGames portrait cover |
| `crazygames-square.png` | 800×800 | CrazyGames square cover |
| `poki-thumbnail.png` | 1080×1080 | Poki static thumbnail (no text, as Poki asks) |
| `itch-cover.png` | 1260×1000 | itch.io cover (2× its 630×500) |

The covers show only the title, with no borders or icons, as CrazyGames asks. The art uses no emoji, because emoji images belong to the OS vendor. To change a layout, edit `FORMATS` in `art/cover.html`, then open it in a browser with `?format=<name>` to preview it. If you add a size, add it to `scripts/art.sh` too.

**Gameplay videos** are in `art/videos/`, made by `npm run video` (`npm run video -- portrait` makes just one):

| File | Size | For |
|---|---|---|
| `crazygames-landscape.mp4` | 1920×1080, 17 s | CrazyGames landscape preview |
| `crazygames-portrait.mp4` | 1080×1620 (2:3), 17 s | CrazyGames portrait preview |

Each video opens on its cover and fades into a real Casual game: the blue blobs befriend a crowd of wanderers while pink and orange rivals go after the same crowd. The camera follows the action, pushes in slowly, then pulls back at the end. The videos have no sound and no extra text, and they play at normal speed, as CrazyGames asks. The landscape video uses a laptop-sized page at 1.5×; the portrait one uses the phone layout at 2×.

`scripts/video.mjs` plays the game in headless Chrome on a fake clock, advancing exactly one frame for each frame it captures, so the video plays at true speed however slow capturing is. It starts its own Vite server, so `npm run dev` doesn't need to be running. The scene is tuned to seed 42. If a balance change makes it dull, change `SEED` and `CROWD` there and look at the result again.

**Sound:** short effects are synthesised with Web Audio (`src/audio.ts`), so there are no audio files to download. You'll hear them when you befriend or lose a blob, for births, building, bonks, arrests, takeovers, tech, tutorial steps, wins and errors. Each sound has a minimum gap so busy moments don't get noisy. Mute with 🔊 (or **M**); the setting is saved.

## The 13 traits and what they do

| Trait | Effect |
|---|---|
| Intelligence, Science & Math | research → tech level |
| Teaching | how fast a blob teaches teammates and spreads its traits; also persuasion |
| Kindness, Honesty, Patience, Openness | persuasion power; kindness also makes teammates disgusted by violence |
| Openness to strangers | how easily *this* blob is persuaded |
| Allegiance | loyalty cap and recovery; resists fear conversion |
| Fitness, Strength | speed, hit damage, escaping or catching |
| Reproduction | birth rate (houses give room) |
| Violence | urge to attack; jail slowly reforms it |
| Financial smarts | gold income |

**Conversion:** every chat lowers the listener's loyalty, scaled by the speaker's charm, their faction's reputation and tech, nearby schools, and any grudge the listener's faction holds. When loyalty drops below 0, the blob switches teams. Chats also spread traits between blobs, so culture spreads too.

**Group befriending:** aim a group at a spot and each blob takes a different stranger within 150px. When a stranger joins, that blob moves on to the next one in the area, until nobody is left (or 2 minutes pass). "Send 3 friends" on a stranger sends your three most charming free blobs.

**Life:** ages are in blob-years. Blobs grow up at 12 and usually die of old age at about 85–110 (about 7½ minutes in Casual and 5 in Pro). Babies need room (hall 12, +5 per house). Social blobs have the most; busy blobs (befriending, teaching, taking over a building) have about a third as many, and blobs that are fighting or fleeing have none.

**Jobs** are standing orders that a blob goes back to whenever it's idle:
- 💬 **Social** (the default): hangs around home chatting. It keeps teammates loyal, wins over visitors, defends your buildings and has the most babies.
- 🎓 **Teacher:** keeps finding the nearby teammate it can teach the most, then gives that teammate a Teach lesson.
- 🌸 **Recruiter:** keeps befriending the strangers nearest to it.

The **👥 Team** panel ranks your blobs by Charm, Teaching, Smarts, Money, Power or Hot-headedness. From there you can select the top 5, make the top 3 Teachers or Recruiters, or send teachers to calm your hot heads.

**Homes:** each citizen lives near one of your buildings. Room per building: hall 10, house 5, school 4, lab and market 3, fountain 2. Towns spread out as you build, and blobs stroll over to new buildings.

**⛲ Friendship Fountain:** strangers inside its circle slowly lose loyalty and join you. Wanderers are drawn toward it.

**🏳️ Takeover:** blobs sent to stand at a rival's building count as attackers. Anyone of the owner's team nearby counts as a defender, and police count double. With at least 3 attackers and more attackers than defenders, a bar fills (bigger crowds fill it faster, town halls about 3× slower) and the building switches sides. Nobody gets hurt, so police don't arrest anyone, but the victim's team holds a small grudge. The Grumble Gang will try this on you.

**Spreading good traits:** there are three ways.
- **Teach:** one of your blobs gives a teammate 8 short lessons. The teammate's traits move toward the teacher's, but only on traits where the teacher is better (for violence, only where the teacher is calmer), so bad habits aren't copied. Lessons go faster with a good teacher, a patient student, a kid student, a nearby school or higher tech.
- **Schools:** your blobs inside a school's circle slowly gain the trait you pick for it.
- **Everyday chats:** blobs pick up a little of each other's traits, good and bad.

**Violence:** an attack steals gold and can scare weak blobs into joining (they stay disloyal). It also makes the attacker *wanted* 🚨, lowers the attacker's faction reputation, makes the victim's faction hold a grudge that blocks future conversion, and costs loyalty among the attacker's kind teammates.

**Police** patrol their land and arrest any wanted blob, including their own faction's. Tech raises their sight, speed and catch rate, and how fast jail reforms prisoners.

## Code map

```
src/sim/        pure game logic, no rendering; seeded RNG, fixed 20 Hz tick (replays/multiplayer-ready)
  world.ts      state, commands, helpers (convert, jail, kill, canPlace)
  systems/      behaviour · social · violence · police · life · economy · ai
                housing (homes) · jobs (teachers, recruiters, group befriend) · towns (fountains, takeovers)
  config.ts     balance constants and building defs
src/modes.ts    Casual vs Pro tuning
src/render/     Pixi: procedurally drawn blob textures, camera, buildings, emoji FX
src/ui/hud.ts   DOM overlay: top bar, build bar, selection panel, toasts, log, minimap
src/game.ts     main loop + input → sim commands
src/tutorials.ts  tutorial levels and the step tracker (pure logic, tested headless)
src/progress.ts   which tutorials you've finished (portal cloud save or localStorage)
src/platform.ts   portal SDKs (CrazyGames, Poki) behind one interface: ads, gameplay events, saves
src/audio.ts      synthesised sound effects and the mute switch
scripts/package.sh  builds and zips every version for upload
art/cover.html      portal covers and thumbnails as SVG; scripts/art.sh renders them to art/covers/
scripts/video.mjs   records the gameplay preview videos into art/videos/
tests/          headless sim tests, and a test that plays every tutorial level
```

The simulation never reads from the renderer. The UI sends `world.command(...)` and reads state and `drainEvents()`.

## Next steps

- Package for phones with **Capacitor** (iOS and Android) and for desktop with **Tauri**
- Run the sim in a Web Worker for Pro-scale populations
- Music and background sound (the sound effects are done), more varied AI personalities, fog of war
- Balance pass from real play (`npm test -- --silent=false` prints faction tables)
