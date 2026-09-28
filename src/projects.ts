import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SwitchYardPaths } from "./home.ts";
import type { ProjectRecord, StateStore } from "./state.ts";
import { now } from "./state.ts";
import { assertRegisterableProject, canonicalRepositoryRoot, cloneRepository } from "./worktree.ts";

export async function addProject(
  store: StateStore,
  paths: SwitchYardPaths,
  input: string,
  name?: string,
  remoteUrl?: string,
): Promise<ProjectRecord> {
  const root = await canonicalRepositoryRoot(input);
  await assertRegisterableProject(root, [paths.worktrees, paths.sources, paths.reviews]);
  const existing = store.getProjectByRoot(root);
  if (existing) return existing;
  const projectName = normalizeProjectName(name ?? path.basename(root));
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  store.transaction(() => {
    store.db
      .prepare(
        "INSERT INTO projects(id, name, root_path, remote_url, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, projectName, root, remoteUrl ?? null, now());
  });
  const project = store.getProject(id);
  if (!project) throw new Error("failed to persist project");
  return project;
}

export async function cloneProject(
  store: StateStore,
  paths: SwitchYardPaths,
  remoteUrl: string,
  name: string,
  location: string,
): Promise<ProjectRecord> {
  if (!isRemoteGitUrl(remoteUrl)) throw new Error("project URL must be an HTTPS or SSH Git URL");
  const projectName = normalizeProjectName(name);
  const destination = path.resolve(location);
  if (existsSync(destination)) throw new Error(`project location already exists: ${destination}`);
  await cloneRepository(remoteUrl, destination);
  return addProject(store, paths, destination, projectName, remoteUrl);
}

export function isRemoteGitUrl(value: string): boolean {
  if (/^[^/@\s]+@[^:/\s]+:.+/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "ssh:") && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function normalizeProjectName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("project name is required");
  return normalized;
}
