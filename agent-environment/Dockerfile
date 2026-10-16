# Agent environment for the Factorial harness.
#
# The harness mounts its own managed agent loop into this image and ignores
# ENTRYPOINT and CMD; what matters is the toolchain available to the shell.
# Built for linux/arm64 only (AgentCore Runtime requirement).
#
# Base image pinned by digest (node:22-bookworm-slim, linux/arm64).
FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd

ARG GH_VERSION=2.102.0
ARG GH_SHA256=5006962696f01e1624b3fcf1f9d8e1a11547f24bf067dd2a0371b7b421945237

ENV DEBIAN_FRONTEND=noninteractive \
    GIT_TERMINAL_PROMPT=0 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-client \
      procps \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI, verified against the release checksum.
RUN curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.deb" \
 && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
 && dpkg -i /tmp/gh.deb \
 && rm /tmp/gh.deb

# Factorial's in-image tools: GitHub App token minting and the git credential helper.
COPY dist/factorial-github-token.mjs /usr/local/lib/factorial/factorial-github-token.mjs
COPY bin/factorial-github-token /usr/local/bin/factorial-github-token
COPY bin/git-credential-factorial /usr/local/bin/git-credential-factorial
RUN chmod 0755 /usr/local/bin/factorial-github-token /usr/local/bin/git-credential-factorial \
 && git config --system credential.helper factorial \
 && git config --system init.defaultBranch main \
 && git config --system user.name "Factorial" \
 && git config --system user.email "factorial[bot]@users.noreply.github.com"

# Sessions run as root inside an isolated microVM; the IAM execution role is the
# real boundary. The orchestrator's pre-invocation commands also run as root, so
# a non-root agent user would only create ownership mismatches.
WORKDIR /workspace
