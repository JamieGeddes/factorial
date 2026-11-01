/**
 * The clean-room push: import the builder's bundle into a pristine clone and
 * push exactly the expected commits to the work branch, re-created under the
 * App's identity. It runs in the Collect Lambda (lib/git.ts), which no model
 * has ever run in, so no agent session holds a write token or runs a command
 * that sees one.
 *
 * `baseCommit` is the commit the work branch must currently point at: the
 * tip of the base branch for a new item, the head the agent started from for
 * rework or a later round. The rewrite replays the bundle's commits on top of
 * it, so the push is always a fast-forward; every check refuses anything
 * else, and no force is ever passed.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mustGit, runGit, withGitWorkspace, type GitWorkspace } from './git.ts';
import { assertCommitSha, assertGitBranch, assertGitHubName, assertGitHubToken, assertGitIdentity } from './shell.ts';

export interface CleanRoomPush {
  /** The remote to clone and push to; `githubRemote` in production, a local bare repository in a test. */
  remoteUrl: string;
  branch: string;
  baseCommit: string;
  /** The agent's head, which the bundle must carry. */
  headSha: string;
  /** True for rework or a later round, which push onto an existing branch; false for a fresh branch, which must not exist yet. */
  existingBranch: boolean;
  token: string;
  /** The bundle Collect exported from the agent's session: the commits from `baseCommit` to `headSha`. */
  bundle: Uint8Array;
  /** Author and committer for every pushed commit; the agent's own identity is discarded. */
  identity: { name: string; email: string };
}

/** The production remote for a repository. */
export function githubRemote(owner: string, name: string): string {
  return `https://github.com/${assertGitHubName(owner, 'repository owner')}/${assertGitHubName(name, 'repository name')}.git`;
}

/** Every command that could run a hook has hooks disabled; the clone is fresh, so none could be there anyway. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** The commit a ref points at, or undefined when it does not exist. */
async function refSha(workspace: GitWorkspace, cwd: string, ref: string): Promise<string | undefined> {
  const result = await runGit(workspace, ['rev-parse', '--verify', '--quiet', ref], { cwd });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && sha ? sha : undefined;
}

/** Push the bundle's commits and return the pushed head, which differs from the agent's. */
export async function cleanRoomPush(params: CleanRoomPush): Promise<string> {
  const branch = assertGitBranch(params.branch, 'work branch');
  const baseCommit = assertCommitSha(params.baseCommit, 'base commit');
  const headSha = assertCommitSha(params.headSha, 'head sha');
  const identity = assertGitIdentity(params.identity);
  const token = assertGitHubToken(params.token);
  const ref = `refs/heads/${branch}`;

  return withGitWorkspace(async (workspace) => {
    const bundlePath = path.join(workspace.dir, 'incoming.bundle');
    const repo = path.join(workspace.dir, 'repo.git');
    await writeFile(bundlePath, params.bundle);

    await mustGit(workspace, [...NO_HOOKS, 'clone', '--quiet', '--bare', '--filter=blob:none', params.remoteUrl, repo], { token });
    // The clone is blob-less, so importing the bundle makes git fetch the
    // unchanged files' blobs from origin on demand; that lazy fetch needs
    // the token too or it fails asking for a username.
    await mustGit(workspace, [...NO_HOOKS, 'fetch', '--quiet', bundlePath, 'HEAD'], { cwd: repo, token });

    const imported = await refSha(workspace, repo, 'FETCH_HEAD');
    if (imported !== headSha) throw new Error(`The bundle's head is ${imported ?? 'missing'}, not the agent's head ${headSha}`);

    // An existing branch must still be at the head the session started from,
    // so the push is a fast-forward; refuse and fail loudly if it has moved.
    // A fresh branch must not exist yet, so the push never overwrites one.
    const current = await refSha(workspace, repo, ref);
    if (params.existingBranch && current !== baseCommit) {
      throw new Error(`${branch} has moved: expected ${baseCommit}, found ${current ?? 'no branch'}; nothing was pushed`);
    }
    if (!params.existingBranch && current !== undefined) {
      throw new Error(`${branch} already exists at ${current}; nothing was pushed`);
    }

    const ancestry = await runGit(workspace, ['merge-base', '--is-ancestor', baseCommit, 'FETCH_HEAD'], { cwd: repo });
    if (ancestry.exitCode !== 0) throw new Error(`The agent's head ${headSha} does not descend from ${baseCommit}; nothing was pushed`);

    const range = `${baseCommit}..FETCH_HEAD`;
    const merges = (await mustGit(workspace, ['rev-list', '--merges', range], { cwd: repo })).trim();
    if (merges) throw new Error(`The agent's commits include a merge commit (${merges.split('\n')[0]}); nothing was pushed`);

    const ident = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    let head = baseCommit;
    const commits = (await mustGit(workspace, ['rev-list', '--reverse', range], { cwd: repo })).split('\n').filter((line) => line.length > 0);
    for (const commit of commits) {
      // Only the tree, the message and the author date are kept.
      const message = await mustGit(workspace, ['log', '-1', '--format=%B', commit], { cwd: repo });
      const authorDate = (await mustGit(workspace, ['log', '-1', '--format=%aI', commit], { cwd: repo })).trim();
      head = (
        await mustGit(workspace, ['commit-tree', `${commit}^{tree}`, '-p', head], { cwd: repo, input: message, env: { ...ident, GIT_AUTHOR_DATE: authorDate } })
      ).trim();
    }
    assertCommitSha(head, 'pushed head');

    await mustGit(workspace, [...NO_HOOKS, 'push', '--quiet', 'origin', `${head}:${ref}`], { cwd: repo, token, timeoutMs: 600_000 });
    return head;
  });
}
