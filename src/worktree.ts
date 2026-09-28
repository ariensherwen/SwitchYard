import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceInfo {
  path: string;
  branch: string;
  baseSha: string;
}

export async function canonicalRepositoryRoot(input: string): Promise<string> {
  const absolute = path.resolve(input);
  const { stdout } = await git(absolute, ["rev-parse", "--show-toplevel"]);
  return await realpath(stdout.trim());
}

export async function assertRegisterableProject(
  root: string,
  managedRoots: string[],
): Promise<void> {
  const canonical = await realpath(root);
  for (const managedRoot of managedRoots) {
    const canonicalManagedRoot = await realpath(managedRoot);
    const relative = path.relative(canonicalManagedRoot, canonical);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      throw new Error("SwitchYard-managed checkouts cannot be registered as Projects");
    }
  }
}

export async function cloneRepository(remoteUrl: string, destination: string): Promise<void> {
  const absoluteDestination = path.resolve(destination);
  await mkdir(path.dirname(absoluteDestination), { recursive: true });
  await git(path.dirname(absoluteDestination), ["clone", "--", remoteUrl, absoluteDestination]);
}

export async function createLocalRepository(destination: string): Promise<void> {
  const absoluteDestination = path.resolve(destination);
  await mkdir(absoluteDestination, { recursive: true });
  await git(absoluteDestination, ["init"]);
  await git(absoluteDestination, [
    "-c",
    "user.name=SwitchYard",
    "-c",
    "user.email=switchyard@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize SwitchYard Project",
  ]);
}

export async function moveRepository(source: string, destination: string): Promise<void> {
  await rename(source, destination);
}

export async function resolveRemoteRevision(remoteUrl: string, ref: string): Promise<string> {
  const selectedRef = ref.trim();
  if (!selectedRef) throw new Error("remote Git ref is required");
  const peeledRef = `${selectedRef}^{}`;
  const { stdout } = await git(process.cwd(), [
    "ls-remote",
    "--",
    remoteUrl,
    selectedRef,
    peeledRef,
  ]);
  const matches = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2);
  const peeledRevisions = matches
    .filter((parts) => parts[1] === peeledRef)
    .map((parts) => parts[0]?.toLowerCase())
    .filter((value): value is string => !!value);
  const directRevisions = matches
    .filter((parts) => parts[1] === selectedRef)
    .map((parts) => parts[0]?.toLowerCase())
    .filter((value): value is string => !!value);
  const revisions = [...new Set(peeledRevisions.length ? peeledRevisions : directRevisions)];
  if (revisions.length !== 1 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revisions[0] ?? ""))
    throw new Error("remote ref did not resolve to one concrete Git commit");
  return revisions[0] as string;
}

export async function ensureTransientRepository(
  remoteUrl: string,
  destination: string,
  revision?: string,
  sourceRef?: string,
): Promise<string> {
  const created = !existsSync(destination);
  if (created) await cloneRepository(remoteUrl, destination);
  const root = await canonicalRepositoryRoot(destination);
  if (revision) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision))
      throw new Error("transient source revision must be a full Git commit SHA");
    if (created) {
      await git(root, ["fetch", "--no-tags", "origin", sourceRef ?? revision]);
    }
    const actual = await resolveCommit(root, revision);
    if (actual !== revision.toLowerCase())
      throw new Error("transient source revision resolved to a different commit");
    const head = await currentHead(root);
    if (head !== actual) {
      if (!created) throw new Error("transient checkout moved from its pinned revision");
      await git(root, ["checkout", "--detach", actual]);
    }
  }
  return root;
}

export async function assertProjectClean(root: string): Promise<void> {
  if (await projectHasChanges(root)) throw new Error(`project checkout is dirty: ${root}`);
}

export async function projectHasChanges(root: string): Promise<boolean> {
  const { stdout } = await git(root, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

export async function projectIsSafeLandingTarget(root: string): Promise<boolean> {
  const { stdout } = await git(root, ["status", "--porcelain", "--ignored"]);
  return stdout.trim().length === 0;
}

export async function resolveCommit(root: string, revision: string): Promise<string> {
  const { stdout } = await git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  return stdout.trim().toLowerCase();
}

export async function resolveRemoteBase(root: string, ref: string): Promise<string> {
  if (!ref.trim()) throw new Error("base ref is required");
  return await resolveCommit(root, ref.trim());
}

export async function registerGitIdentity(root: string, expected?: string | null): Promise<string> {
  let configured: string | undefined;
  try {
    configured = (
      await git(root, ["config", "--local", "--get", "switchyard.projectIdentity"])
    ).stdout.trim();
  } catch {
    configured = undefined;
  }
  if (expected && configured !== expected)
    throw new Error("repository identity changed at the registered Project path");
  const identity = configured ?? expected ?? randomUUID();
  if (!configured) {
    if (expected) throw new Error("registered Project identity is missing from Git configuration");
    await git(root, ["config", "--local", "switchyard.projectIdentity", identity]);
  }
  return identity;
}

export async function repositoryRemotes(root: string): Promise<
  Array<{
    name: string;
    fetchUrls: string[];
    pushUrls: string[];
  }>
> {
  const names = (await git(root, ["remote"])).stdout.split(/\r?\n/).filter(Boolean);
  const remotes = [];
  for (const name of names) {
    const fetchUrls = await remoteUrls(root, name, false);
    const pushUrls = await remoteUrls(root, name, true);
    remotes.push({ name, fetchUrls, pushUrls });
  }
  return remotes;
}

export async function addGitRemote(root: string, name: string, url: string): Promise<void> {
  validateRemoteName(name);
  await git(root, ["remote", "add", name, url]);
}

export async function updateGitRemote(
  root: string,
  name: string,
  url: string,
  direction: "fetch" | "push" = "fetch",
): Promise<void> {
  validateRemoteName(name);
  if (direction === "push") {
    await git(root, ["remote", "set-url", "--push", name, url]);
  } else {
    await git(root, ["remote", "set-url", name, url]);
  }
}

export async function removeGitRemote(root: string, name: string): Promise<void> {
  validateRemoteName(name);
  await git(root, ["remote", "remove", name]);
}

async function remoteUrls(root: string, name: string, push: boolean): Promise<string[]> {
  try {
    return (
      await git(root, ["remote", "get-url", ...(push ? ["--push"] : []), "--all", name])
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function validateRemoteName(name: string): void {
  if (!name.trim() || name.startsWith("-") || /[\s\0]/.test(name))
    throw new Error("invalid Git remote name");
}

export async function currentHead(root: string): Promise<string> {
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function currentBranch(root: string): Promise<string> {
  return (await git(root, ["branch", "--show-current"])).stdout.trim();
}

export async function taskWorkspaceBase(
  projectRoot: string,
  destination: string,
  branch: string,
  baseRef?: string,
  dirtyAcknowledged = false,
): Promise<string> {
  if (existsSync(destination)) {
    const actualBranch = (await git(destination, ["branch", "--show-current"])).stdout.trim();
    if (actualBranch !== branch)
      throw new Error(`workspace is on unexpected branch ${actualBranch}`);
    return currentHead(destination);
  }
  if (!dirtyAcknowledged) await assertProjectClean(projectRoot);
  return baseRef ? resolveRemoteBase(projectRoot, baseRef) : currentHead(projectRoot);
}

export async function ensureTaskWorkspace(
  projectRoot: string,
  destination: string,
  branch: string,
  baseSha: string,
): Promise<WorkspaceInfo> {
  if (existsSync(destination)) {
    const actualBranch = (await git(destination, ["branch", "--show-current"])).stdout.trim();
    if (actualBranch !== branch)
      throw new Error(`workspace is on unexpected branch ${actualBranch}`);
    const actualHead = await currentHead(destination);
    if (actualHead !== baseSha)
      throw new Error("unprovisioned workspace moved from its reserved base");
    return { path: destination, branch, baseSha };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  if (await localBranchExists(projectRoot, branch)) {
    const branchHead = (
      await git(projectRoot, ["rev-parse", `refs/heads/${branch}`])
    ).stdout.trim();
    if (branchHead !== baseSha) throw new Error("reserved workspace branch moved from its base");
    await git(projectRoot, ["worktree", "add", destination, branch]);
  } else {
    await git(projectRoot, ["worktree", "add", "-b", branch, destination, baseSha]);
  }
  return { path: destination, branch, baseSha };
}

export async function createWorkspace(
  projectRoot: string,
  destination: string,
  branch: string,
): Promise<WorkspaceInfo> {
  await assertProjectClean(projectRoot);
  const baseSha = await currentHead(projectRoot);
  return ensureTaskWorkspace(projectRoot, destination, branch, baseSha);
}

export async function validateImplementCandidate(
  workspace: string,
  branch: string,
  baseSha: string,
): Promise<string> {
  const status = (await git(workspace, ["status", "--porcelain"])).stdout.trim();
  if (status) throw new Error("candidate workspace must be clean; commit all task work first");
  const head = await currentHead(workspace);
  await git(workspace, ["cat-file", "-e", `${head}^{commit}`]);
  const currentBranch = (await git(workspace, ["branch", "--show-current"])).stdout.trim();
  if (currentBranch !== branch) throw new Error(`candidate must be on expected branch ${branch}`);
  try {
    await git(workspace, ["merge-base", "--is-ancestor", baseSha, head]);
  } catch {
    throw new Error("candidate does not descend from task base revision");
  }
  return head;
}

export async function validateInvestigateCompletion(
  workspace: string,
  baseSha: string,
): Promise<void> {
  const status = (await git(workspace, ["status", "--porcelain"])).stdout.trim();
  if (status) throw new Error("investigate workspace must remain clean");
  const head = await currentHead(workspace);
  if (head !== baseSha) throw new Error("investigate task must not create source commits");
}

export async function changedPaths(
  workspace: string,
  baseSha: string,
  candidateSha: string,
): Promise<string[]> {
  const { stdout } = await git(workspace, ["diff", "--name-only", `${baseSha}..${candidateSha}`]);
  return stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

export async function diffText(
  workspace: string,
  baseSha: string,
  candidateSha: string,
): Promise<string> {
  return (await git(workspace, ["diff", "--no-ext-diff", `${baseSha}..${candidateSha}`])).stdout;
}

export async function createReviewWorktree(
  projectRoot: string,
  reviewPath: string,
  candidateSha: string,
): Promise<void> {
  await git(projectRoot, ["worktree", "add", "--detach", reviewPath, candidateSha]);
}

export async function validateReviewCheckout(
  reviewPath: string,
  candidateSha: string,
): Promise<void> {
  const head = await currentHead(reviewPath);
  if (head !== candidateSha)
    throw new Error("review checkout no longer points at the candidate revision");
  const status = (await git(reviewPath, ["status", "--porcelain"])).stdout.trim();
  if (status) throw new Error("review checkout must be clean before certification");
}

export async function canSafelyCleanTransientSource(
  sourceRoot: string,
  baseSha: string,
): Promise<boolean> {
  const sourceStatus = (
    await git(sourceRoot, ["status", "--porcelain", "--ignored"])
  ).stdout.trim();
  return !sourceStatus && (await currentHead(sourceRoot)) === baseSha;
}

export async function canSafelyCleanTransient(
  sourceRoot: string,
  workspace: string,
  baseSha: string,
): Promise<boolean> {
  const sourceStatus = (
    await git(sourceRoot, ["status", "--porcelain", "--ignored"])
  ).stdout.trim();
  const workspaceStatus = (
    await git(workspace, ["status", "--porcelain", "--ignored"])
  ).stdout.trim();
  if (sourceStatus || workspaceStatus) return false;
  return (await currentHead(sourceRoot)) === baseSha && (await currentHead(workspace)) === baseSha;
}

export async function canSafelyClean(
  projectRoot: string,
  workspace: string,
  baseSha: string,
): Promise<boolean> {
  const status = (await git(workspace, ["status", "--porcelain", "--ignored"])).stdout.trim();
  if (status) return false;
  const head = await currentHead(workspace);
  if (head === baseSha) return true;
  const projectHead = await currentHead(projectRoot);
  try {
    await git(projectRoot, ["merge-base", "--is-ancestor", head, projectHead]);
    return true;
  } catch {
    return false;
  }
}

export async function removeWorktree(projectRoot: string, workspace: string): Promise<void> {
  // Never force-delete a Task workspace. If Git refuses removal, preserve the workspace
  // and surface the error so a human can inspect it.
  await git(projectRoot, ["worktree", "remove", workspace]);
}

export async function fastForwardOnly(
  projectRoot: string,
  baseSha: string,
  candidateSha: string,
): Promise<
  | { status: "landed"; branch: string; head: string }
  | { status: "diverged"; branch: string; head: string }
> {
  const branch = await currentBranch(projectRoot);
  if (!branch) throw new Error("cannot land into a detached Project checkout");
  const head = await currentHead(projectRoot);
  if (head !== baseSha) return { status: "diverged", branch, head };
  await git(projectRoot, ["merge", "--ff-only", candidateSha]);
  const landedHead = await currentHead(projectRoot);
  if (landedHead !== candidateSha)
    throw new Error("fast-forward landing did not reach the Task candidate");
  return { status: "landed", branch, head: landedHead };
}

export async function validateRemoteBranch(root: string, branch: string): Promise<void> {
  if (!branch.trim() || branch.startsWith("switchyard/task-"))
    throw new Error("publication requires a human-readable remote branch name");
  await git(root, ["check-ref-format", `refs/heads/${branch}`]);
}

export async function choosePushRemote(root: string, branch: string): Promise<string> {
  const configured =
    (await gitConfig(root, `branch.${branch}.pushRemote`)) ??
    (await gitConfig(root, "remote.pushDefault")) ??
    (await gitConfig(root, `branch.${branch}.remote`));
  const remotes = (await git(root, ["remote"])).stdout.split(/\r?\n/).filter(Boolean);
  if (configured) {
    if (configured === ".")
      throw new Error("configured push target is the local Project, not a remote");
    if (!remotes.includes(configured))
      throw new Error(`configured push remote '${configured}' does not exist`);
    return configured;
  }
  const onlyRemote = remotes.length === 1 ? remotes[0] : undefined;
  if (onlyRemote) return onlyRemote;
  if (remotes.length > 1) throw new Error("push target is ambiguous; select a Git remote");
  throw new Error("Project has no configured Git remote");
}

export async function pushCommit(
  root: string,
  commitSha: string,
  remoteBranch: string,
  remote: string,
): Promise<void> {
  if (!remote || remote === ".") throw new Error("publication requires a configured Git remote");
  await validateRemoteBranch(root, remoteBranch);
  const refspec = `${commitSha}:refs/heads/${remoteBranch}`;
  await git(root, ["push", "--", remote, refspec]);
}

async function gitConfig(root: string, key: string): Promise<string | undefined> {
  try {
    return (await git(root, ["config", "--get", key])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function localBranchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await git(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd, windowsHide: true });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}
