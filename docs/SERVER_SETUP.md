# Server setup

Musicraft's web app runs in your browser. It talks to two services on your server, both through your
existing `gateway.py` behind Tailscale Funnel:

```
Browser ──HTTPS + your API key──▶ Tailscale Funnel ──▶ gateway.py ─┬─ /v1/…  ──▶ llama-server   (internal key)
                                                                   └─ /omr/… ──▶ musicraft-omr  (internal key)
```

Nothing changes in Funnel or on your router. You add one container and one route in `gateway.py`, and
make sure `gateway.py` handles the browser's CORS requests.

## 1. Start the recognition service

You need, on the machine that runs llama-server and `gateway.py`:

- **Docker Engine with the Compose plugin** (`docker compose version` should work).
- For the GPU build only: the AMD GPU kernel driver on the host (if llama.cpp already uses the W7800 through
  ROCm or Vulkan, it is there). ROCm itself comes inside the container; it needs access to `/dev/kfd` and
  `/dev/dri`, which the compose file grants.
- A checkout of this repository. Until the work is merged into `main`, use its branch:

```bash
git clone https://github.com/misterclarity/musicraft.git
cd musicraft
git checkout claude/music-sheet-digitizer-01so9g
```

Then, from the repository folder:

```bash
cd deploy
openssl rand -hex 32 > omr_internal_key.txt
chmod 600 omr_internal_key.txt
# The CPU image runs as user 10001, which must be able to read the key
# (without this the container exits at start-up). Needs the `acl` package.
setfacl -m u:10001:r omr_internal_key.txt

# CPU build (works everywhere):
docker compose up -d --build

# or the AMD GPU build for the Radeon Pro W7800 (ROCm 7.0):
docker compose -f docker-compose.yml -f docker-compose.rocm.yml up -d --build
```

The first build downloads two versions of homr and their models (about 1 GB in all; see
[Two homr versions](#two-homr-versions)), so it takes a while. The service listens on
`127.0.0.1:8070` only.

Check it:

```bash
curl http://127.0.0.1:8070/health
# {"status":"ok","version":"0.1.0","engine":{"name":"homr","version":"…","available":true,"device":"rocm"},…}
```

`device` shows `rocm` when the GPU build found your W7800 and `cpu` otherwise. On CPU a page takes
roughly 30–60 seconds; on the GPU it should be a few seconds.

### Settings

All settings are environment variables in `deploy/docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `MUSICRAFT_OMR_API_KEY_FILE` | — | File holding the internal key. Requests without `Authorization: Bearer <key>` get 401 (except `/health`). |
| `MUSICRAFT_OMR_CORS_ORIGINS` | `*` | Comma-separated origins allowed by CORS. The key is what protects the service, so `*` is fine. |
| `MUSICRAFT_OMR_MAX_UPLOAD_MB` | `60` | Largest upload per job. |
| `MUSICRAFT_OMR_MAX_PAGES` | `40` | Most pages per job. |
| `MUSICRAFT_OMR_JOB_TTL_HOURS` | `6` | Finished jobs and their files are deleted after this time. |
| `MUSICRAFT_OMR_MAX_IMAGE_SIDE` | `4000` | Larger photos are scaled down to this many pixels on the longest side. |

## 2. Add the `/omr` route to `gateway.py`

`gateway.py` already checks outside API keys and forwards `/v1/…` to llama-server with the internal key.
The recognition service needs the same treatment:

1. **Match** requests whose path starts with `/omr/`.
2. **Check the outside key** exactly as for `/v1/…`.
3. **Forward** to `http://127.0.0.1:8070` with the same path. Stripping the `/omr` prefix is optional; the
   service accepts both `/omr/health` and `/health`.
4. **Replace** the `Authorization` header with `Bearer <contents of omr_internal_key.txt>`.
5. **Pass the body through** for `POST` requests. Uploads are multipart forms of up to 60 MB, so raise any
   request-size limit in `gateway.py` accordingly.
6. **Methods:** `GET`, `POST`, `DELETE` (and `OPTIONS`, see below).

Recognition runs as a background job: the app uploads pages (`POST /omr/v1/omr/jobs`), then polls
(`GET /omr/v1/omr/jobs/<id>`) every couple of seconds. No request has to stay open for minutes.

If you share `gateway.py` (or just its routing part), I can write the exact patch.

## 3. CORS in `gateway.py` (needed for both `/v1` and `/omr`)

The app is served from a different domain (Netlify or GitHub Pages, or `http://localhost:5173` while
developing), so the browser applies CORS rules to every call to your server:

- **Preflight.** Before a request that carries an `Authorization` header, the browser sends an `OPTIONS`
  request **without** the API key. `gateway.py` must not reject it with 401. Either answer it itself with
  status 204 and the headers below, or forward it unchanged; llama-server and musicraft-omr both answer
  preflight requests correctly.
- **Headers on every response,** including `gateway.py`'s own errors such as 401 or 429 and the streamed
  (`text/event-stream`) chat responses. Without them the browser hides the response, and the app can only
  report "couldn't reach the server".

```
Access-Control-Allow-Origin:  https://<site-name>.netlify.app   or   https://<owner>.github.io
                              (or * — the API key is the protection)
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Max-Age:       600
```

The origin is scheme and host only: for GitHub Pages it is `https://<owner>.github.io` even though the
app lives at `https://<owner>.github.io/<repository>/`. To allow several sites, compare the request's
`Origin` header with your list and echo it back (adding `Vary: Origin`).

When `gateway.py` passes the backend's response headers through, the backends already add
`Access-Control-Allow-Origin` (llama-server reflects the caller's origin). Then only `gateway.py`'s own
responses (preflights it answers itself and its error responses) need the headers added.

For streaming chat, make sure `gateway.py` forwards llama-server's response as it arrives instead of
buffering it, so the app can show the answer as it is written.

## 4. Optional: `/props` for context-size detection

The app reads the model list from `/v1/models`. It also tries `GET /props` (llama-server's server
properties) to learn the configured context size and whether the model accepts images. If `gateway.py`
doesn't forward `/props`, everything still works; the app then uses safe defaults that you can override
in Settings.

## 5. Connect the app

Open the app, go to **Settings**, enter your server URL (`https://<machine>.<tailnet>.ts.net`) and your
outside API key, and press **Test connection**. It reports the detected model, its context size, vision
support, and whether the recognition service is reachable and on which device it runs.

## Updating

```bash
git pull
cd deploy
docker compose up -d --build            # add -f docker-compose.rocm.yml for the GPU build
```

### Two homr versions

homr versions read some pages differently, and neither is better everywhere. The image therefore
holds two: a pinned commit of homr's main branch (on the GPU in the ROCm build; it also reports where
each note is on the page), and the PyPI release 0.7.0 (on the CPU). When reading pages, the app can
have every page read by both and keep the reading whose bars add up best; the wizard has a checkbox
for it and the review says which reading it kept. **Settings → Test connection** lists both versions.

Build arguments choose the versions (each a pip requirement):

```bash
cd deploy
# Leave out the second version (the image is about 450 MB smaller, pages are read once):
docker compose build --build-arg HOMR_SECOND_SPEC= && docker compose up -d
# Another commit of the main branch (use homr[rocm] with the ROCm override):
docker compose build --build-arg "HOMR_SPEC=homr[cpu] @ git+https://github.com/liebharc/homr@<commit>" && docker compose up -d
# Back to the defaults:
docker compose build && docker compose up -d
```
