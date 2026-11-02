/**
 * Seed a session with the repository without the session reaching GitHub
 * (#262). The Lambda fetches the branches the session uses into a bare
 * repository in its own /tmp (lib/git.ts), writes them as a git bundle and
 * uploads it to the transfer bucket (lib/transfer.ts); the session script
 * downloads the bundle with a presigned URL and fetches from the file. The
 * read token is used only by the Lambda's git, as `http.extraHeader` in its
 * environment, so no GitHub token enters a session and no session needs
 * GitHub at all.
 *
 * The bundle carries full history: a bundle made from a shallow clone cannot
 * be fetched from, and a blob-less clone in the session would have nowhere to
 * fetch missing blobs from. Every target in view is well under 100 MB.
 *
 * Prepare, ContinueBuild and PrepareReview call `seedRepository`, and so will
 * the verifier sessions of #167.
 */
import path from 'node:path';

import { githubRemote } from './clean-room.ts';
import { NO_HOOKS, mustGit, runGit, withGitWorkspace, type GitWorkspace } from './git.ts';
import { repositoryToken } from './github.ts';
import { mustRun, type CommandResult, type SessionTarget } from './session.ts';
import { HARDENED_GIT_ENV, assertCommitSha, assertGitBranch, assertGitHubName, shellQuote } from './shell.ts';
import { s3Transfer, type Transfer } from './transfer.ts';

/** Which branches the session gets and where it starts. */
export interface RepoRefs {
  /** The work branch the session is put on. */
  branch: string;
  /** A new branch off the default head (or `at`), or the existing remote branch. */
  mode: 'create' | 'checkout';
  /**
   * The commit the session must start from, when another session has already
   * fixed it: a new branch is created there, and an existing branch must still
   * be there.
   */
  at?: string;
  /** A rework's base branch, when it is not the default branch: fetched as `origin/<baseBranch>` for three-dot diffs. */
  baseBranch?: string;
}

/** What the bundle holds and where the session will start, known before the session is touched. */
export interface BundledRepository {
  defaultBranch: string;
  /** The commit the work branch will be at in the session. */
  head: string;
  /** The branches in the bundle, each as `refs/heads/<name>`. */
  refs: string[];
}

/** Every file a session's seed may have left, removed before the repository is set up again. */
const SEED_PATHS = [
  '/workspace/repo',
  '/workspace/summary.md',
  '/workspace/workitem.json',
  '/workspace/rework.md',
  '/workspace/notes.md',
  '/workspace/logs',
  '/workspace/plan.md',
  '/workspace/plan.json',
  '/workspace/diff.patch',
  '/workspace/review.json',
];

function checkRefs(refs: RepoRefs): RepoRefs {
  return {
    branch: assertGitBranch(refs.branch, 'work branch'),
    mode: refs.mode,
    ...(refs.at === undefined ? {} : { at: assertCommitSha(refs.at, 'start commit') }),
    ...(refs.baseBranch === undefined ? {} : { baseBranch: assertGitBranch(refs.baseBranch, 'base branch') }),
  };
}

/** The branches the session uses, in order: the default, a rework base that differs from it, and the work branch in checkout mode. */
export function sessionBranches(refs: RepoRefs, defaultBranch: string): string[] {
  const branches = [defaultBranch];
  if (refs.baseBranch !== undefined && refs.baseBranch !== defaultBranch) branches.push(refs.baseBranch);
  if (refs.mode === 'checkout' && !branches.includes(refs.branch)) branches.push(refs.branch);
  return branches;
}

/** The default branch from `ls-remote --symref <remote> HEAD`. */
export function parseDefaultBranch(lsRemote: string): string {
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(lsRemote);
  if (!match?.[1]) throw new Error('the repository has no default branch');
  return assertGitBranch(match[1], 'default branch');
}

/**
 * In the Lambda: fetch the session's branches from the remote at full depth
 * into a bare repository and write them to `bundlePath` as a verified bundle.
 * The token, when given, reaches only `ls-remote` and `fetch`.
 */
export async function bundleRepository(
  workspace: GitWorkspace,
  params: RepoRefs & { remoteUrl: string; token?: string },
  bundlePath: string,
): Promise<BundledRepository> {
  const refs = checkRefs(params);
  const auth = params.token === undefined ? {} : { token: params.token };
  const repo = path.join(workspace.dir, 'seed.git');
  await mustGit(workspace, ['init', '--quiet', '--bare', repo]);

  const defaultBranch = parseDefaultBranch(await mustGit(workspace, [...NO_HOOKS, 'ls-remote', '--symref', params.remoteUrl, 'HEAD'], { cwd: repo, ...auth }));
  const branches = sessionBranches(refs, defaultBranch);
  const refspecs = branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`);
  await mustGit(workspace, [...NO_HOOKS, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', params.remoteUrl, ...refspecs], { cwd: repo, ...auth, timeoutMs: 600_000 }).catch(
    (error: Error) => {
      throw new Error(`${error.message}${refs.mode === 'checkout' ? ` (is ${refs.branch} on the remote?)` : ''}`);
    },
  );

  const tip = async (ref: string): Promise<string> => assertCommitSha((await mustGit(workspace, ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo })).trim(), ref);
  let head: string;
  if (refs.mode === 'checkout') {
    head = await tip(`refs/heads/${refs.branch}`);
    if (refs.at !== undefined && head !== refs.at) throw new Error(`branch ${refs.branch} is not at the expected commit ${refs.at}`);
  } else if (refs.at !== undefined) {
    const known = await runGit(workspace, ['cat-file', '-e', `${refs.at}^{commit}`], { cwd: repo });
    if (known.exitCode !== 0) throw new Error(`start commit ${refs.at} is not on ${branches.join(', ')}`);
    head = refs.at;
  } else {
    head = await tip(`refs/heads/${defaultBranch}`);
  }

  const bundled = branches.map((b) => `refs/heads/${b}`);
  await mustGit(workspace, ['bundle', 'create', '--quiet', bundlePath, ...bundled], { cwd: repo, timeoutMs: 600_000 });
  await mustGit(workspace, ['bundle', 'verify', '--quiet', bundlePath], { cwd: repo });
  const heads = (await mustGit(workspace, ['bundle', 'list-heads', bundlePath], { cwd: repo }))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(' ')[1]);
  if ([...heads].sort().join('\n') !== [...bundled].sort().join('\n')) throw new Error(`the bundle holds ${heads.join(', ')}, not ${bundled.join(', ')}`);

  return { defaultBranch, head, refs: bundled };
}

const BUNDLE_URL = /^(?:https:\/\/|file:\/\/\/)[^\s'"\\]+$/;

/**
 * In the session, as root, before any model runs: set the repository up from
 * the bundle at `bundleUrl` and put it on the work branch; print the head
 * commit and the default branch. It clears the seed's files but writes none:
 * those are the seed's (`lib/seed.ts`).
 *
 * `origin` is the GitHub URL, so `origin/<default>`, `origin/<base>` and the
 * three-dot diffs keep their names, but it is never contacted. The bundle is
 * downloaded into a directory only root can read and removed however the
 * script ends; the URL is an argument of this command only. Both are gone
 * before `handOverWorkspace` gives the workspace to the agent user.
 *
 * `bundleUrl` is a presigned `https://` URL in production; the local test
 * passes a `file:///` one.
 */
export function repoSeedScript(params: RepoRefs & { owner: string; name: string; defaultBranch: string; bundleUrl: string }): string {
  const refs = checkRefs(params);
  const url = githubRemote(assertGitHubName(params.owner, 'repository owner'), assertGitHubName(params.name, 'repository name'));
  const defaultBranch = assertGitBranch(params.defaultBranch, 'default branch');
  if (!BUNDLE_URL.test(params.bundleUrl)) throw new Error('bundle URL is not a plain https URL');
  const { branch, at } = refs;
  const refspecs = sessionBranches(refs, defaultBranch).map((b) => shellQuote(`+refs/heads/${b}:refs/remotes/origin/${b}`));
  const checkout =
    refs.mode === 'create'
      ? [`git checkout --quiet --no-track -b ${shellQuote(branch)} ${shellQuote(at ?? `origin/${defaultBranch}`)}`]
      : [
          `git checkout --quiet ${shellQuote(`origin/${branch}`)}`,
          `git branch --quiet ${shellQuote(branch)}`,
          ...(at ? [`test "$(git rev-parse HEAD)" = ${shellQuote(at)} || { echo ${shellQuote(`branch ${branch} is not at the expected commit ${at}`)} >&2; exit 1; }`] : []),
        ];
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    // mktemp -d makes the directory 0700, so the bundle is root's alone while it exists
    'seed_dir=$(mktemp -d /tmp/factorial-seed.XXXXXX)',
    `trap 'rm -rf "$seed_dir"' EXIT`,
    `rm -rf ${SEED_PATHS.join(' ')}`,
    'git init --quiet /workspace/repo',
    'cd /workspace/repo',
    `git remote add origin ${shellQuote(url)}`,
    `curl -fsS --retry 3 -o "$seed_dir/repo.bundle" ${shellQuote(params.bundleUrl)}`,
    'git bundle verify --quiet "$seed_dir/repo.bundle"',
    // no FETCH_HEAD, and a fixed reflog message, so the bundle's path is written nowhere in the repository
    `GIT_REFLOG_ACTION='fetch from bundle' git fetch --quiet --no-tags --no-write-fetch-head "$seed_dir/repo.bundle" ${refspecs.join(' ')}`,
    `git symbolic-ref refs/remotes/origin/HEAD ${shellQuote(`refs/remotes/origin/${defaultBranch}`)}`,
    ...checkout,
    'rm -rf "$seed_dir"',
    'git rev-parse HEAD',
    `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'`,
  ].join('\n');
}

/** The head and default branch the seed script printed, its last two lines. */
export function parseSeedOutput(stdout: string): { head: string; defaultBranch: string } {
  const lines = stdout.trim().split('\n');
  return {
    head: assertCommitSha(lines[lines.length - 2] ?? '', 'branch head'),
    defaultBranch: assertGitBranch(lines[lines.length - 1] ?? '', 'default branch'),
  };
}

export interface SeedRepositoryParams extends RepoRefs {
  target: SessionTarget;
  repository: { owner: string; name: string };
  /** Where the bundle goes in the transfer bucket (`transferKey`). */
  transferKey: string;
}

/** What seeding reaches outside this module; S3, GitHub and the session in production, local stand-ins in tests. */
export interface SeedRepositoryDeps {
  token(repository: { owner: string; name: string }): Promise<string | undefined>;
  remoteUrl(repository: { owner: string; name: string }): string;
  transfer: Transfer;
  run(target: SessionTarget, script: string, timeoutSeconds: number): Promise<CommandResult>;
}

export const defaultSeedDeps: SeedRepositoryDeps = {
  token: (repository) => repositoryToken(repository, { contents: 'read' }),
  remoteUrl: (repository) => githubRemote(repository.owner, repository.name),
  transfer: s3Transfer,
  run: mustRun,
};

/**
 * Fetch and bundle in the Lambda, upload, presign, and run the seed script in
 * the session. Returns the head the session is at and the default branch,
 * which the Lambda knew before the session ran and the session confirmed.
 * The transfer object is deleted once the session has it, or has failed to;
 * the bucket's lifecycle rule removes any a failed delete leaves.
 */
export async function seedRepository(params: SeedRepositoryParams, deps: SeedRepositoryDeps = defaultSeedDeps): Promise<{ head: string; defaultBranch: string }> {
  const { owner, name } = params.repository;
  const refs = checkRefs(params);
  const token = await deps.token({ owner, name });
  const remoteUrl = deps.remoteUrl({ owner, name });
  const bundled = await withGitWorkspace(async (workspace) => {
    const bundlePath = path.join(workspace.dir, 'repo.bundle');
    const result = await bundleRepository(workspace, { ...refs, remoteUrl, ...(token === undefined ? {} : { token }) }, bundlePath);
    await deps.transfer.upload(params.transferKey, bundlePath);
    return result;
  });
  try {
    const bundleUrl = await deps.transfer.presign(params.transferKey);
    const result = await deps.run(params.target, repoSeedScript({ ...refs, owner, name, defaultBranch: bundled.defaultBranch, bundleUrl }), 600);
    const seeded = parseSeedOutput(result.stdout);
    if (seeded.head !== bundled.head || seeded.defaultBranch !== bundled.defaultBranch) {
      throw new Error(`the session is at ${seeded.head} on ${seeded.defaultBranch}, not ${bundled.head} on ${bundled.defaultBranch}`);
    }
    return seeded;
  } finally {
    await deps.transfer.remove(params.transferKey).catch(() => {});
  }
}
