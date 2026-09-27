import { createHash } from "node:crypto";
import type { SwitchYardPaths } from "./home.ts";
import type { ProjectRecord, StateStore } from "./state.ts";
import { now } from "./state.ts";
import { assertRegisterableProject, canonicalRepositoryRoot } from "./worktree.ts";

export async function addProject(
  store: StateStore,
  paths: SwitchYardPaths,
  input: string,
): Promise<ProjectRecord> {
  const root = await canonicalRepositoryRoot(input);
  await assertRegisterableProject(root, paths.worktrees);
  const existing = store.getProjectByRoot(root);
  if (existing) return existing;
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  store.transaction(() => {
    store.db
      .prepare("INSERT INTO projects(id, root_path, created_at) VALUES (?, ?, ?)")
      .run(id, root, now());
  });
  const project = store.getProject(id);
  if (!project) throw new Error("failed to persist project");
  return project;
}
