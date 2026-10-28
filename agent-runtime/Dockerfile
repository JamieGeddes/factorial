# Agent runtime for Factorial: an AgentCore Runtime container whose entrypoint
# is Factorial's host process around the Claude Agent SDK (packages/agent-runtime).
# Built for linux/arm64 only (AgentCore Runtime requirement).
#
# The toolchain is Node 22, git, gh, jq and quiet (packages/agent-tools),
# plus python3 and cfn-lint so the builder can run the repository's full
# checks (npm run ci ends with cfn-lint). It is the only agent image. The
# image holds no credentials and no credential helpers: the model is reached
# through Bedrock with the execution role, and the orchestrator does all
# GitHub access.
#
# The host process runs as root and starts the SDK's Claude Code subprocess as
# the agent user through claude-as-agent, so the model's loop, shell and tools
# cannot signal or trace the host, change its hooks or limits, or edit the
# run's record in /var/lib/factorial. The host and the SDK are root-owned and
# read-only to the agent user (docs/security.md section 9). Commands sent
# through InvokeAgentRuntimeCommand also run as root.
#
# Base image pinned by digest (node:22-bookworm-slim, linux/arm64).
FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd

ARG GH_VERSION=2.102.0
ARG GH_SHA256=5006962696f01e1624b3fcf1f9d8e1a11547f24bf067dd2a0371b7b421945237

ENV DEBIAN_FRONTEND=noninteractive \
    GIT_TERMINAL_PROMPT=0 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=true

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      procps \
      python3 \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*

# cfn-lint at CI's version (.github/workflows/ci.yml), with every dependency
# pinned by hash in cfn-lint-requirements.txt, generated from cfn-lint.in with
# pip-compile --generate-hashes on python:3.11-slim-bookworm (Debian
# bookworm's python3 is 3.11).
COPY cfn-lint-requirements.txt /tmp/
RUN python3 -m venv /opt/cfn-lint \
 && /opt/cfn-lint/bin/pip install --no-cache-dir --require-hashes -r /tmp/cfn-lint-requirements.txt \
 && ln -s /opt/cfn-lint/bin/cfn-lint /usr/local/bin/cfn-lint \
 && chmod -R go-w /opt/cfn-lint \
 && rm /tmp/cfn-lint-requirements.txt

# GitHub CLI (read-only use without a token), verified against the release checksum.
RUN curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.deb" \
 && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
 && dpkg -i /tmp/gh.deb \
 && rm /tmp/gh.deb

RUN git config --system init.defaultBranch main \
 && git config --system user.name "Factorial" \
 && git config --system user.email "agent@factorial.invalid"
# The identity above only lets the agent commit. Commits are re-created with
# the GitHub App's bot identity in the clean-room push, outside this image.

# The agent user is the base image's node user (uid 1000), renamed.
RUN usermod --login agent --home /home/agent --move-home node \
 && groupmod --new-name agent node \
 && mkdir /workspace \
 && chown agent:agent /workspace

# The SDK from its own lockfile, without its peer dependencies (the host bundle
# carries what it uses), then the bundled host and quiet. Everything under
# /opt/factorial is root-owned with no group or other write, so the agent user
# can read and execute it but not change it.
WORKDIR /opt/factorial/agent-runtime
COPY package.json package-lock.json ./
# npm installs both the glibc and musl builds of the Claude Code binary on
# linux-arm64; Debian is glibc, so the musl one (about 270 MB) is removed.
RUN npm ci --omit=dev --omit=peer \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl \
 && npm cache clean --force
COPY dist/host.mjs dist/quiet.mjs dist/agent-ops.mjs claude-as-agent ./
RUN printf '#!/bin/sh\nexec node /opt/factorial/agent-runtime/quiet.mjs "$@"\n' > /usr/local/bin/quiet \
 && chmod 755 /usr/local/bin/quiet \
 && chown -R root:root /opt/factorial \
 && chmod -R go-w /opt/factorial \
 && mkdir -m 0700 /var/lib/factorial

# The host's own HOME and working directory are root-owned: as root it must
# never read configuration the agent user can write (an ~/.aws/config with a
# credential_process would run as root when the host signs a gateway call).
# The subprocess gets HOME=/home/agent and CLAUDE_CONFIG_DIR=/workspace/.claude
# from the host (packages/agent-runtime/src/environment.ts).
ENV HOME=/root \
    NODE_ENV=production

WORKDIR /opt/factorial/agent-runtime
EXPOSE 8080
# No USER: the host is root by design (see the top of this file).
ENTRYPOINT ["node", "/opt/factorial/agent-runtime/host.mjs"]
