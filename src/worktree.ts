import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
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
  switchyardWorktrees: string,
): Promise<void> {
  const canonical = await realpath(root);
  const generated = path.resolve(switchyardWorktrees) + path.sep;
  if ((canonical + path.sep).startsWith(generated)) {
    throw new Error("generated SwitchYard worktrees cannot be registered as Projects");
  }
}

export async function cloneRepository(remoteUrl: string, destination: string): Promise<void> {
  const absoluteDestination = path.resolve(destination);
  await mkdir(path.dirname(absoluteDestination), { recursive: true });
  await git(path.dirname(absoluteDestination), ["clone", "--", remoteUrl, absoluteDestination]);
}

export async function ensureTransientRepository(
  remoteUrl: string,
  destination: string,
): Promise<string> {
  if (!existsSync(destination)) await cloneRepository(remoteUrl, destination);
  return await canonicalRepositoryRoot(destination);
}

export async function assertProjectClean(root: string): Promise<void> {
  const { stdout } = await git(root, ["status", "--porcelain"]);
  if (stdout.trim()) throw new Error(`project checkout is dirty: ${root}`);
}

export async function currentHead(root: string): Promise<string> {
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function taskWorkspaceBase(
  projectRoot: string,
  destination: string,
  branch: string,
): Promise<string> {
  if (existsSync(destination)) {
    const actualBranch = (await git(destination, ["branch", "--show-current"])).stdout.trim();
    if (actualBranch !== branch)
      throw new Error(`workspace is on unexpected branch ${actualBranch}`);
    return currentHead(destination);
  }
  await assertProjectClean(projectRoot);
  return currentHead(projectRoot);
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
  const status = (await git(workspace, ["status", "--porcelain"])).stdout.trim();
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
