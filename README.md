# Mind Blobs

A cartoon-blob real-time strategy game. You grow an empire mostly by **winning blobs over**. Fighting is possible, but police arrest attackers, and the better a society's tech, the better its police.

Built with TypeScript, PixiJS v8 and Vite. There is one simulation with two tunings: **Casual** (mobile, relaxed) and **Pro** (PC, fast, every stat shown).

```bash
npm install
npm run dev        # http://localhost:5173  (?mode=casual|pro&seed=123 skips the menu)
npm test           # headless sim tests + balance tables (add --silent=false to see them)
npm run build      # type-check + production bundle in dist/
```

## How it plays

| | Casual | Pro |
|---|---|---|
| Select | tap a blob | click, Shift+click, drag box, Ctrl+A, Ctrl+1–9 / 1–9 groups |
| Befriend a crowd | select yours, tap a stranger (or **Befriend**, then tap a crowd) | right-click a stranger, or **F** then click |
| Teach | select yours, **Teach**, tap a teammate | right-click a teammate, or **C** then click |
| Take over a building | select yours, tap a rival building | right-click a rival building, or **U** then click |
| Find your best blobs | **👥 Team** | **Tab** |
| Pick a group | **Select nearby**, or Team → Select top 5 | drag a box |
| Bonk (violence) | **Bonk** button | **X** then click / right-click |
| Build | tap a button, tap your land | **Q W E R T Y** (Shift keeps placing) |
| Camera | drag, pinch | wheel zoom, right-drag pan, arrows, minimap, **H** home |
| Other | | **S** stop, **G** move, Space pause, +/- speed |

The menu only offers Pro on devices with a mouse or trackpad, or once a key has been pressed. Phones and tablets get Casual only (`?mode=pro` still forces it, for testing).

You win by leading 90% of all blobs. When the game ends you can close the results and pan around the map.

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
tests/          headless sim tests
```

The simulation never reads from the renderer. The UI sends `world.command(...)` and reads state and `drainEvents()`.

## Next steps

- Package for phones with **Capacitor** (iOS and Android) and for desktop with **Tauri**
- Run the sim in a Web Worker for Pro-scale populations
- Sound, building upgrades, more varied AI personalities, fog of war
- Balance pass from real play (`npm test -- --silent=false` prints faction tables)
