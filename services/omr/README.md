# musicraft-omr

Recognition service for Musicraft. It turns page images and PDFs into MusicXML with
[homr](https://github.com/liebharc/homr) and runs on your own server behind `gateway.py`.

See [`docs/SERVER_SETUP.md`](../../docs/SERVER_SETUP.md) for installation.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `MUSICRAFT_OMR_HOST` | `127.0.0.1` | Address to listen on. Keep it local; `gateway.py` forwards to it. |
| `MUSICRAFT_OMR_PORT` | `8070` | Port to listen on. |
| `MUSICRAFT_OMR_API_KEY_FILE` | — | File holding the internal key that `gateway.py` sends. |
| `MUSICRAFT_OMR_API_KEY` | — | The internal key itself (instead of a file). Without a key, requests aren't checked. |
| `MUSICRAFT_OMR_CORS_ORIGINS` | `*` | Comma-separated origins allowed by CORS. |
| `MUSICRAFT_OMR_MAX_UPLOAD_MB` | `60` | Largest upload. |
| `MUSICRAFT_OMR_MAX_PAGES` | `40` | Most pages per job. |
| `MUSICRAFT_OMR_MAX_IMAGE_SIDE` | `4000` | Longest side of a page image given to homr (larger photos are scaled down). |
| `MUSICRAFT_OMR_JOB_TTL_HOURS` | `6` | How long finished jobs and their files are kept. |
| `MUSICRAFT_OMR_WORKDIR` | `/tmp/musicraft-omr` | Where uploads and results are stored while a job lives. |
| `MUSICRAFT_OMR_ENGINE` | `homr` | `fake` returns a fixed score, for tests and demos. |
| `MUSICRAFT_OMR_HOMR_COMMAND` | `homr` | Command that runs homr (e.g. a path inside a virtual environment). |
| `MUSICRAFT_OMR_HOMR_TIMEOUT_SECONDS` | `1800` | Longest a recognition run may take. |
