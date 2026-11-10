# Musicraft recognition service, CPU build.
#   docker build -t musicraft-omr:cpu services/omr
# homr is installed from a pinned commit of its main branch, which adds ROCm
# support, multi-measure rests, dynamics and note positions over the PyPI release.
FROM python:3.12-slim

# Which homr to install (a pip requirement): by default a pinned commit of its main branch.
ARG HOMR_SPEC="homr[cpu] @ git+https://github.com/liebharc/homr@33dd138b0a79a6e513bf2b2e31caddde12c01063"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# homr's own downloader times out after 5 s; fetch the models patiently first, then let
# `homr --init` verify that everything is in place.
COPY scripts/fetch_homr_models.py /tmp/fetch_homr_models.py
RUN pip install "${HOMR_SPEC}" \
 && python /tmp/fetch_homr_models.py \
 && homr --init

# A second homr, the PyPI release, in its own environment and on the CPU. Versions read some pages
# differently, so the app can have every page read by both and keep the better reading (Settings
# shows whether it's there). Build with --build-arg HOMR_SECOND_SPEC= to leave it out: the image
# is then about 450 MB smaller.
ARG HOMR_SECOND_SPEC="homr==0.7.0"
RUN if [ -n "${HOMR_SECOND_SPEC}" ]; then \
      python -m venv /opt/homr-second \
      && /opt/homr-second/bin/pip install "${HOMR_SECOND_SPEC}" \
      && /opt/homr-second/bin/python /tmp/fetch_homr_models.py \
      && /opt/homr-second/bin/homr --init; \
    fi \
 && rm /tmp/fetch_homr_models.py
ENV MUSICRAFT_OMR_SECOND_HOMR_COMMAND=/opt/homr-second/bin/homr

WORKDIR /app
COPY pyproject.toml README.md ./
COPY musicraft_omr ./musicraft_omr
RUN pip install .

RUN useradd --create-home --uid 10001 omr \
 && mkdir -p /tmp/musicraft-omr && chown omr /tmp/musicraft-omr
USER omr

ENV MUSICRAFT_OMR_HOST=0.0.0.0 \
    MUSICRAFT_OMR_PORT=8070
EXPOSE 8070
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8070/health')"
CMD ["musicraft-omr"]
