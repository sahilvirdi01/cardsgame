# Bhabhi Thulla 🃏

A real-time multiplayer browser card game for the classic Indian shedding game **Bhabhi** (also known as **Thulla** or **Getaway**). Play with 2–10 friends in the same room — complete with peer-to-peer voice/video, a meme soundboard, GIF reactions and live chat.

> Don't be the last one holding cards, or you're the **Bhabhi**!

## Features

- 🎮 **Full game engine** — rules enforced server-side (hidden information safe, no cheating by inspecting state).
- 👥 **2–10 players** per room, join with a short 4-character room code.
- 🃏 **House rules** the host can tweak: turn direction, escape timing, and who leads after an escape.
- 🎙️ **Peer-to-peer voice & video** over WebRTC (mesh) with mic/camera indicators in the lobby.
- 🔊 **Soundboard** — fire off desi meme sounds so everyone hears them in real time.
- 😂 **GIF reactions & animations** — "THULLA!" takedown overlay, deal animation, winner/loser reveal.
- 💬 **Live chat** in both the lobby and the game, plus table stats.
- 🔄 **Reconnect-safe** — if a player drops mid-game the table pauses for them for a grace period, then auto-plays a random legal card so play keeps moving. Refreshing the page rejoins your seat automatically.
- 📱 **Responsive UI** — a clean, simplified layout on phones (no table stats or camera grid clutter), fuller desktop layout on bigger screens.

## Tech stack

- **Backend:** Node.js, [Express](https://expressjs.com/), [Socket.IO](https://socket.io/)
- **Frontend:** Vanilla JavaScript, HTML, CSS (no build step)
- **Realtime media:** WebRTC (peer-to-peer mesh), Socket.IO for signalling
- **Tests:** Plain Node.js with `assert`, real Socket.IO clients for E2E

## Getting started

Requires **Node.js 18+** (works great on 20/22/24).

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
# → http://localhost:3000
```

Open the URL in a browser, create a room, share the 4-letter code with friends (on the same network or via a deployed host) and start playing.

### Development

```bash
npm run dev     # auto-restart on file changes (node --watch)
PORT=3001 npm start   # run on a different port
```

## Tests

```bash
npm test              # engine + end-to-end tests
npm run test:engine   # rules integrity, termination, hidden-info safety
npm run test:e2e      # boots the real server and plays full games
```

## Project structure

```
.
├── server.js            # Express + Socket.IO server, rooms, lobby & game orchestration
├── game/
│   └── bhabhi.js        # Pure game engine (rules only, no UI / networking)
├── public/              # Static client (served by Express)
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── app.js       # UI + socket event wiring
│   │   ├── webrtc.js    # Peer-to-peer audio/video mesh
│   │   ├── soundboard.js
│   │   └── animations.js
│   ├── gifs/            # Thulla reaction GIFs (auto-discovered)
│   │   └── bhabhi/      # Loser/Bhabhi GIFs shown on the game-over screen
│   └── sounds/          # Meme sounds + manifest
├── scripts/
│   └── gen-gifs.sh      # Regenerate the GIF reaction library (needs ImageMagick)
└── test/
    ├── engine.js        # Deterministic engine tests
    ├── e2e.js           # Full multiplayer end-to-end test
    ├── reconnect.js     # Drop-out grace period, auto-play & seat reclaim
    └── rematch.js       # Unanimous Play-Again voting + GIF endpoint
```

## How to play

1. **Goal:** empty your hand. The last player still holding cards is the **Bhabhi / Thulla** (loser).
2. The holder of the **Ace of Spades** starts by playing it.
3. The leader plays any card — its **suit** is what everyone must follow.
4. If you have the led suit, you **must** play it.
5. If you don't, play any card — that's a **Thulla**. The trick stops instantly and the player who played the **highest card of the led suit picks up the whole pile**.
6. If nobody Thullas, the cards are discarded and the highest card of the led suit leads next.
7. Empty your hand to escape safely — the last player still holding cards is the Bhabhi.

Ranking is **A > K > Q > J > 10 > … > 2**.

## Customizing the reaction GIFs

The reaction GIFs are auto-discovered, so you never edit code or JSON:

- **Thulla GIFs** (mid-game `THULLA!` popups) live in `public/gifs/`.
- **Bhabhi GIFs** (the loser shown on the game-over screen) live in
  `public/gifs/bhabhi/`. If that folder is empty, the Thulla pool is used.

For either set:

- **Add:** drop a `.gif` (or `.webp`/`.apng`/`.png`/`.jpg`) file into the folder.
- **Replace:** overwrite the existing file with your own, keeping the same name.
- **Remove:** delete the file.

The server builds the lists fresh on every page load (`GET /gifs/index.json`), so just
refresh the browser. Labels default to the filename (e.g. `thulla-time.gif` becomes
"Thulla Time").

To set custom labels or control order, optionally add a `manifest.json` in the
relevant folder — it only overrides label/order for files that exist; missing entries
are ignored and unlisted files are still included. Note: `npm run gen:gifs` only
regenerates placeholder art into `public/gifs/` and never touches `manifest.json`.

## Deployment

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Just set the `PORT` env var if required and run `npm start`. For WebRTC across the open internet you may want a TURN server; on a LAN the built-in STUN config is enough.

## License

Released under the [MIT License](LICENSE).

---

Made by **sahil virdi**.
