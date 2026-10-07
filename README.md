# Arabic Scrabble

A two-player Arabic Scrabble game for one device, with per-player clocks, blank tiles, swap/pass/undo and a human-judge challenge system.

## Technology

HTML, CSS and vanilla JavaScript (ES Modules). No frameworks, no build step, no dependencies. Fonts: Amiri (Arabic) and Tinos (Latin/digits), bundled locally.

## Folder Structure

```
├── index.html
├── README.md
├── css/style.css
├── js/
│   ├── config.js    static data and constants
│   ├── state.js     game state and snapshots
│   ├── game.js      gameplay flow, clock, turns
│   ├── scoring.js   move analysis and scoring
│   ├── judge.js     judge voting and verdicts
│   ├── audio.js     background music + sound effects
│   ├── ui.js        DOM rendering, toasts, dialogs
│   ├── input.js     click, drag/drop, keyboard, buttons
│   └── main.js      entry point
├── assets/fonts/    Amiri-Regular/Bold, Tinos-Regular/Bold (.woff2)
└── assets/audio/    music.mp3 (background music, you supply it)
```

## Usage

ES Modules require HTTP, so opening `index.html` via `file://` will not work. Serve the folder locally, e.g. `python3 -m http.server`, then open `http://localhost:8000/`. Pick a game length, select a tile and tap a board square (or drag it), then press the score button.

## Audio

Sound effects are generated in code (no files). Background music is loaded from `assets/audio/music.mp3` and loops during play; the 🔊 button mutes everything and the choice is remembered. Use music you have the rights to. If the file is missing, a generated loop plays instead. To use another path, edit `MUSIC_SRC` in `js/config.js`.

## GitHub Pages Deployment

1. Upload the project files to a GitHub repository (`index.html` at the repository root).
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
4. Open `https://USERNAME.github.io/REPOSITORY/`.

## Credits

By esbepe.
