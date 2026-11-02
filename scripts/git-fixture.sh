#!/bin/sh
# Print the git version and git's output for a fixed repository, so the same
# script run in each image and on the CI runner shows where their gits differ.
# scripts/check-git-version.ts compares the outputs (the ci.yml job "Image
# toolchains"). POSIX sh: it runs in the agent image (Debian), the
# orchestration image (Amazon Linux) and on the runner (Ubuntu).
#
# Each line after the first is output a test of Factorial's could depend on.
# Add a line when a difference between gits breaks one (#274: a UTC %aI).
set -eu

# Only the fixture's own settings: no system or user configuration.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C TZ=UTC

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
cd "$repo"

g() { git -c user.name=Fixture -c user.email=fixture@factorial.invalid -c init.defaultBranch=main "$@"; }
commit_at() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" g commit -q -m "$2"
}

g init -q .
printf 'one\n' > a.txt
g add a.txt
commit_at '2026-10-30T12:00:00+00:00' 'First, in UTC'
g mv a.txt b.txt
commit_at '2026-10-30T13:00:00+01:00' 'Rename, an hour east'

git --version
echo "aI utc: $(g log -1 --format=%aI HEAD~1)"
echo "cI utc: $(g log -1 --format=%cI HEAD~1)"
echo "ad iso-strict utc: $(g log -1 --date=iso-strict --format=%ad HEAD~1)"
echo "aI +01:00: $(g log -1 --format=%aI HEAD)"
echo "name-status rename: $(g diff --name-status -M HEAD~1 HEAD | tr '\t' ' ')"
