ARG SWEBENCH_VERSION=latest
FROM python:3.11-slim

ARG SWEBENCH_VERSION
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /work

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && if [ "$SWEBENCH_VERSION" = "latest" ]; then \
         python -m pip install --no-cache-dir swebench; \
       else \
         python -m pip install --no-cache-dir "swebench==$SWEBENCH_VERSION"; \
       fi
