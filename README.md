# Musicraft

Musicraft turns sheet music (PDFs and phone photos) into an editable digital score and lets you
transform it: transpose, switch instruments, arrange for other ensembles, edit by hand, or describe the
change to your own AI model. Export to PDF, MusicXML and MIDI.

- **Web app** (`apps/web`): runs entirely in the browser; host it on Vercel or Netlify. Scores are kept in
  your browser.
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
   server reads them. The original pages stay next to the score so you can compare bar by bar.
2. **Check it.** The Checks tab lists bars that don't add up and notes outside an instrument's range.
   With a vision model, *Proofread against the original with AI* compares every line of the original
   with the recognised notes and proposes fixes (and missed dynamics, text and tempo marks) that you
   apply one by one.
3. **Change it.**
   - *Parts* panel: change an instrument (e.g. Bb trumpet → C trumpet or clarinet, same sound),
     transpose, move by octaves, add or remove parts, and *Arrange for…* an ensemble (piano → brass
     quintet, quartet, trio, or any list of instruments) as a first draft.
   - Edit by hand: click a note or rest and type. `A`–`G` enter notes, `↑`/`↓` move by semitones,
     `1`–`7` set lengths, `.` dots, `+` ties, `Delete` makes a rest; the toolbar does the same by touch,
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

- **Web app:** import the repository in Vercel or Netlify. `vercel.json` and `netlify.toml` contain the
  build settings and security headers. Optionally set `VITE_DEFAULT_SERVER_URL` so the app starts with
  your server's address filled in.
- **Server:** see [`docs/SERVER_SETUP.md`](docs/SERVER_SETUP.md).

## License

GPL-3.0. The recognition container includes homr (AGPL-3.0).
