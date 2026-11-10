# Musicraft

Musicraft turns sheet music (PDFs and phone photos) into an editable digital score and lets you
transform it: transpose, switch instruments, arrange for other ensembles, edit by hand, or describe the
change to your own AI model. Export to PDF, MusicXML and MIDI.

- **Web app** (`apps/web`): runs entirely in the browser; host it on Netlify or GitHub Pages (see
  [Deployment](#deployment)). Scores are kept in your browser.
- **Score engine** (`packages/score-core`): the music model, MusicXML import/export, transposition,
  checks and arranging, in TypeScript.
- **Recognition service** (`services/omr`): a Docker container on your server that reads pages with
  [homr](https://github.com/liebharc/homr).
- **AI**: any OpenAI-compatible server; built for llama.cpp's `llama-server`. The model is detected at
  runtime.

The plan and design decisions are in [`docs/PLAN.md`](docs/PLAN.md); server installation is in
[`docs/SERVER_SETUP.md`](docs/SERVER_SETUP.md).

## Using Musicraft

1. **Open music.** Drop a MusicXML/MXL file, a PDF or phone photos on the start page, or start a new
   score. Photos and PDFs go through a short wizard: check the pages (corners are detected and
   straightened), say which instrument the music is written for, and the recognition service on your
   server reads them (with two versions of homr, if the server has both, keeping the better reading of
   each page). Musicraft then corrects what the music itself gives away and lists it before you
   open the score: a misread time signature (e.g. 12/8 read as 2/2, when the bars add up to 12/8), a
   bass clef read in a part for an instrument that never uses one, a tempo mark taken for the title.
   The original pages stay next to the score so you can compare bar by bar.
2. **Check it.** The Checks tab lists bars that don't add up and notes outside an instrument's range.
   For scanned parts it also lists the rests: recognition reads a multi-bar rest (one bar with a number
   above it) as a single bar, so click each rest to see it on the original and type in how many bars it
   lasts (or use **Bar → Multi-bar rest…**).
   With a vision model, *Proofread against the original with AI* compares every line of the original
   with the recognised notes and proposes fixes that you apply one by one: wrong notes, missed key and
   time signatures (applying a key signature also respells the notes that follow it), dynamics, text,
   tempo marks and multi-bar rest counts. If recognition goes badly wrong on a page, the wizard's
   **Recognition output** button saves what the service read, before any corrections, for a bug report.
3. **Change it.**
   - *Parts* panel: change an instrument (e.g. Bb trumpet → C trumpet or clarinet, same sound),
     transpose, move by octaves, add or remove parts, and *Arrange for…* an ensemble (piano → brass
     quintet, quartet, trio, or any list of instruments) as a first draft.
   - Edit by hand: click a note or rest and type. `A`–`G` enter notes, `↑`/`↓` move by semitones,
     `2`–`7` set lengths, `.` dots, `+` ties, `Delete` makes a rest; the toolbar does the same by touch,
     and its `?` button lists every shortcut. *Concert pitch* switches between written and sounding pitch.
   - *Assistant* (✨ in the header): describe the change, e.g. "make this a trumpet in C part and move
     bars 17–24 down an octave". The model works through Musicraft's music tools on a draft; changed
     bars turn green, you can play them back, and you keep or discard the result. Select bars or notes
     first to talk about "this".
4. **Export** PDF (score or parts), MusicXML (written or concert pitch), MXL, MIDI or MEI. Every change
   can be undone, and the History tab keeps versions.

### What the language model needs

- An OpenAI-compatible `/v1` endpoint reachable from the browser through your gateway (with CORS, see
  [`docs/SERVER_SETUP.md`](docs/SERVER_SETUP.md)). The model, its context size and whether it accepts
  images are read from `/v1/models` and `/props`; nothing is hardcoded, and Settings can override them.
- Tool calling: start `llama-server` with `--jinja` and a model whose chat template supports tools.
  Models that write tool calls as text (`<tool_call>…`, `[TOOL_CALLS]…`) are understood too.
- For proofreading and `look_at_page`, a vision model (`--mmproj`).
- 16k tokens of context or more is comfortable; the assistant reads the bars it needs rather than the
  whole score, and trims old tool results when space runs out.

## Development

Requirements: Node.js 22+, and for the recognition service Python 3.11+ with
[uv](https://docs.astral.sh/uv/).

```bash
npm install
npm run dev          # web app on http://localhost:5173
npm test             # unit tests (score engine and web app)
npm run typecheck
npm run build        # production build in apps/web/dist
npm run e2e          # browser tests of the build (first time: npx playwright install chromium),
                     # against e2e/mock-server.mjs, a stand-in for gateway.py with llama-server and
                     # the recognition service behind it
node apps/web/e2e/mock-server.mjs   # the same stand-in on :8790 for trying the app without a server
                                    # (Settings: http://localhost:8790, API key test-key)

cd services/omr
uv sync --group dev
uv run pytest
MUSICRAFT_OMR_ENGINE=fake uv run musicraft-omr   # service with a stand-in engine on :8070
```

## Deployment

The web app is a set of static files, so any static host works. Scores and your API key stay in the
browser; the API key is never part of the build. Two ready-made setups:

### Netlify (recommended)

1. In Netlify: **Add new site → Import an existing project → GitHub**, and pick this repository.
2. **Branch to deploy:** `main`, or a work branch to try it before merging. Leave the build settings
   empty: `netlify.toml` sets them (`npm run build`, publish `apps/web/dist`, Node 22).
3. Optional: **Site configuration → Environment variables →** `VITE_DEFAULT_SERVER_URL` with your
   server's address, so the app starts with it filled in.
4. Deploy. The app is at `https://<site-name>.netlify.app` (the name can be changed in Site
   configuration). Netlify also sends the security headers from `netlify.toml`.

### GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions** (once).
2. Every push to `main` runs `.github/workflows/pages.yml`, which builds the app for
   `https://<owner>.github.io/<repository>/` and publishes it. You can also start it from the Actions tab.
3. Optional: **Settings → Secrets and variables → Actions → Variables →** `MUSICRAFT_SERVER_URL` with your
   server's address (it ends up in the public site, but it isn't a secret; the key is).

GitHub Pages can't send HTTP headers, so every build also carries the Content-Security-Policy as a
`<meta>` tag. The only protection missing compared with Netlify is the one against other sites framing
the app.

### Your server

Allow the site's origin in `gateway.py`'s CORS settings: `https://<site-name>.netlify.app` or
`https://<owner>.github.io` (an origin has no path). See [`docs/SERVER_SETUP.md`](docs/SERVER_SETUP.md).

## License

GPL-3.0. The recognition container includes homr (AGPL-3.0).
