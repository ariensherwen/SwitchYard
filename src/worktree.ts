import { execFile } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
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

export async function assertRegisterableProject(root: string, switchyardWorktrees: string): Promise<void> {
  const canonical = await realpath(root);
  const generated = path.resolve(switchyardWorktrees) + path.sep;
  if ((canonical + path.sep).startsWith(generated)) {
    throw new Error("generated SwitchYard worktrees cannot be registered as Projects");
  }
}

export async function assertProjectClean(root: string): Promise<void> {
  const { stdout } = await git(root, ["status", "--porcelain"]);
  if (stdout.trim()) throw new Error(`project checkout is dirty: ${root}`);
}

export async function currentHead(root: string): Promise<string> {
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function createWorkspace(
  projectRoot: string,
  destination: string,
  branch: string,
): Promise<WorkspaceInfo> {
  await assertProjectClean(projectRoot);
  const baseSha = await currentHead(projectRoot);
  await git(projectRoot, ["worktree", "add", "-b", branch, destination, baseSha]);
  return { path: destination, branch, baseSha };
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

export async function validateInvestigateCompletion(workspace: string, baseSha: string): Promise<void> {
  const status = (await git(workspace, ["status", "--porcelain"])).stdout.trim();
  if (status) throw new Error("investigate workspace must remain clean");
  const head = await currentHead(workspace);
  if (head !== baseSha) throw new Error("investigate task must not create source commits");
}

export async function changedPaths(workspace: string, baseSha: string, candidateSha: string): Promise<string[]> {
  const { stdout } = await git(workspace, ["diff", "--name-only", `${baseSha}..${candidateSha}`]);
  return stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
}

export async function diffText(workspace: string, baseSha: string, candidateSha: string): Promise<string> {
  return (await git(workspace, ["diff", "--no-ext-diff", `${baseSha}..${candidateSha}`])).stdout;
}

export async function createReviewWorktree(projectRoot: string, reviewPath: string, candidateSha: string): Promise<void> {
  await git(projectRoot, ["worktree", "add", "--detach", reviewPath, candidateSha]);
}

export async function validateReviewCheckout(reviewPath: string, candidateSha: string): Promise<void> {
  const head = await currentHead(reviewPath);
  if (head !== candidateSha) throw new Error("review checkout no longer points at the candidate revision");
  const status = (await git(reviewPath, ["status", "--porcelain"])).stdout.trim();
  if (status) throw new Error("review checkout must be clean before certification");
}

export async function canSafelyClean(projectRoot: string, workspace: string, baseSha: string): Promise<boolean> {
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
  try {
    await git(projectRoot, ["worktree", "remove", workspace]);
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    await git(projectRoot, ["worktree", "prune"]);
    throw error;
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
