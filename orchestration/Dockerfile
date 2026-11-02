# Orchestration image: the Lambda functions that run git (Collect's
# clean-room push, lib/clean-room.ts), which the managed nodejs24.x runtime
# cannot, since it has no git. Every other orchestration function stays a zip.
#
# The handlers are the esbuild bundles packages/orchestration/build.ts writes
# to orchestration/dist/<name>/, the AWS SDK included, as for the zips. The
# image adds git and its libraries from the distribution and nothing else.
# Each function names its handler with ImageConfig.Command
# (templates/orchestration.yml), such as collect/index.handler.
#
# Built for linux/arm64. Base image pinned by digest
# (public.ecr.aws/lambda/nodejs:24, linux/arm64).
FROM public.ecr.aws/lambda/nodejs:24@sha256:a8b1898fb070ae2f43179aa9c3b259765efe239e8b974c7121447b22952dfcff

RUN dnf install -y git-core && dnf clean all && rm -rf /var/cache/dnf && git --version

COPY dist/ ${LAMBDA_TASK_ROOT}/
