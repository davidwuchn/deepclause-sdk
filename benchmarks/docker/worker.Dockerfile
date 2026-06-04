FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /work

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        jq \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*
