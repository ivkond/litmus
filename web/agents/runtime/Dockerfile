FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pytest pytest-json-report

# Cursor CLI — Phase 2 shortcut, baked into image
RUN curl -fsSL https://www.cursor.com/install.sh | bash

WORKDIR /work
CMD ["sleep", "infinity"]
