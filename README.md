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

## Development

Requirements: Node.js 22+, and for the recognition service Python 3.11+ with
[uv](https://docs.astral.sh/uv/).

```bash
npm install
npm run dev          # web app on http://localhost:5173
npm test             # unit tests (score engine and web app)
npm run typecheck
npm run build        # production build in apps/web/dist

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
