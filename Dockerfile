FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY web ./web

# Editable: the server locates web/ by walking up from its own file.
RUN pip install --no-cache-dir -e .

# VideoToolbox is macOS-only and fails rather than falling back.
ENV TRACKOVERLAY_CODEC=libx264 \
    PYTHONUNBUFFERED=1

EXPOSE 8712
VOLUME ["/data"]

ENTRYPOINT ["trackoverlay", "serve", "--data", "/data", "--host", "0.0.0.0", \
            "--port", "8712", "--no-browser"]
