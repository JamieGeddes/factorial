# Harness invoker: a small Fargate task that runs one harness invocation to
# completion, streaming the transcript to its logs, so Step Functions can wait
# on it with ecs:runTask.sync for as long as a build takes.
#
# Built for linux/arm64. Base image pinned by digest (node:22-bookworm-slim).
FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd

ENV NODE_ENV=production
WORKDIR /app
COPY dist/invoker.mjs /app/invoker.mjs
USER node
ENTRYPOINT ["node", "--enable-source-maps", "/app/invoker.mjs"]
