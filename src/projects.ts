import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SwitchYardPaths } from "./home.ts";
import type { ProjectRecord, StateStore, TaskRecord } from "./state.ts";
import { now } from "./state.ts";
import {
  addGitRemote,
  assertRegisterableProject,
  canonicalRepositoryRoot,
  cloneRepository,
  createLocalRepository,
  currentBranch,
  currentHead,
  moveRepository,
  projectChanges,
  registerGitIdentity,
  removeGitRemote,
  repositoryRemotes,
  updateGitRemote,
} from "./worktree.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function addProject(
  store: StateStore,
  paths: SwitchYardPaths,
  input: string,
  name?: string,
  options: { confirmIdentityChange?: boolean } = {},
): Promise<ProjectRecord> {
  const root = await canonicalRepositoryRoot(resolveUserPath(input));
  await assertRegisterableProject(root, [paths.worktrees, paths.sources, paths.reviews]);
  const existing = store.getProjectByRoot(root);
  let identity: string;
  try {
    identity = await registerGitIdentity(
      root,
      existing?.git_identity && !options.confirmIdentityChange ? existing.git_identity : undefined,
    );
  } catch {
    throw new Error(
      `repository identity changed for the Project at ${root}; ask for confirmation before replacing its registration`,
    );
  }

  const identityMatches = store
    .listAllProjects()
    .filter((project) => project.git_identity === identity);
  const movedIdentity = !existing && identityMatches.length === 1 ? identityMatches[0] : undefined;
  if (existing?.relocation_token || movedIdentity?.relocation_token)
    throw new Error("cannot register or repair a Project while it is being relocated");
  if (
    identityMatches.some((project) => project.id !== existing?.id) &&
    (!movedIdentity || existsSync(movedIdentity.root_path))
  ) {
    throw new Error("this repository identity is already registered to another Project");
  }

  if (!existing && identityMatches.length === 1) {
    const previous = identityMatches[0];
    if (!previous) throw new Error("repository identity lookup failed");
    if (existsSync(previous.root_path))
      throw new Error(`this repository identity is already registered at ${previous.root_path}`);
    if (activeTasks(store, previous.id).length)
      throw new Error("cannot repair a Project location while it has active Tasks");
    if (retainedWorkspaceTasks(store, previous.id).length)
      throw new Error("cannot repair a Project location while it has retained Task Workspaces");
    const projectName = normalizeProjectName(name ?? previous.name);
    store.transaction(() => {
      const changed = store.db
        .prepare(`UPDATE projects SET name=?, root_path=?, registration_state='registered'
          WHERE id=? AND root_path=?`)
        .run(projectName, root, previous.id, previous.root_path);
      if (changed.changes !== 1) throw new Error("Project location changed concurrently");
      store.event(null, "project.relocated", {
        project_id: previous.id,
        from: previous.root_path,
        to: root,
        repaired: true,
      });
      if (previous.registration_state !== "registered")
        store.event(null, "project.registered", { project_id: previous.id, name: projectName });
      if (previous.name !== projectName)
        store.event(null, "project.renamed", { project_id: previous.id, name: projectName });
    });
    return requiredProject(store, previous.id);
  }

  const projectName = normalizeProjectName(name ?? existing?.name ?? path.basename(root));
  if (existing) {
    store.transaction(() => {
      store.db
        .prepare(`UPDATE projects SET name=?, registration_state='registered', git_identity=?
          WHERE id=?`)
        .run(projectName, identity, existing.id);
      if (existing.registration_state !== "registered") {
        store.event(null, "project.registered", { project_id: existing.id, name: projectName });
      }
      if (existing.name !== projectName) {
        store.event(null, "project.renamed", { project_id: existing.id, name: projectName });
      }
      if (existing.git_identity && existing.git_identity !== identity) {
        store.event(null, "project.identity_replaced", { project_id: existing.id });
      }
    });
    return requiredProject(store, existing.id);
  }
  const id = randomUUID();
  store.transaction(() => {
    store.db
      .prepare(`INSERT INTO projects(
      id, name, root_path, git_identity, registration_state, created_at
    ) VALUES (?, ?, ?, ?, 'registered', ?)`)
      .run(id, projectName, root, identity, now());
    store.event(null, "project.registered", { project_id: id, name: projectName, root_path: root });
  });
  return requiredProject(store, id);
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
  const destination = resolveUserPath(location);
  await assertDestinationOutsideManagedRoots(paths, destination);
  if (existsSync(destination)) throw new Error(`project location already exists: ${destination}`);
  await cloneRepository(remoteUrl, destination);
  return addProject(store, paths, destination, projectName);
}

export async function createProject(
  store: StateStore,
  paths: SwitchYardPaths,
  name: string,
  location: string,
): Promise<ProjectRecord> {
  const projectName = normalizeProjectName(name);
  const destination = resolveUserPath(location);
  await assertDestinationOutsideManagedRoots(paths, destination);
  if (existsSync(destination)) throw new Error(`project location already exists: ${destination}`);
  await createLocalRepository(destination);
  return addProject(store, paths, destination, projectName);
}

export async function inspectProject(
  store: StateStore,
  projectId: string,
): Promise<{
  project: ProjectRecord;
  head: string;
  branch: string;
  dirty: boolean;
  changes: Awaited<ReturnType<typeof projectChanges>>;
  remotes: Awaited<ReturnType<typeof repositoryRemotes>>;
}> {
  const project = requiredProject(store, projectId);
  const root = await validateProjectCheckout(store, project);
  const changes = await projectChanges(root);
  return {
    project: requiredProject(store, projectId),
    head: await currentHead(root),
    branch: await currentBranch(root),
    dirty: changes.length > 0,
    changes,
    remotes: await repositoryRemotes(root),
  };
}

export async function renameProject(
  store: StateStore,
  projectId: string,
  name: string,
): Promise<ProjectRecord> {
  requiredProject(store, projectId);
  const normalized = normalizeProjectName(name);
  store.transaction(() => {
    const changed = store.db
      .prepare("UPDATE projects SET name=? WHERE id=?")
      .run(normalized, projectId);
    if (changed.changes !== 1) throw new Error("Project not found");
    store.event(null, "project.renamed", { project_id: projectId, name: normalized });
  });
  return requiredProject(store, projectId);
}

export function unregisterProject(store: StateStore, projectId: string): ProjectRecord {
  const project = requiredProject(store, projectId);
  if (project.relocation_token)
    throw new Error("cannot unregister a Project while it is being relocated");
  const active = activeTasks(store, projectId);
  if (active.length)
    throw new Error(
      `cannot unregister a Project with active Tasks: ${active.map((task) => task.title).join(", ")}`,
    );
  store.transaction(() => {
    if (requiredProject(store, projectId).relocation_token)
      throw new Error("cannot unregister a Project while it is being relocated");
    const changed = store.db
      .prepare(
        "UPDATE projects SET registration_state='unregistered' WHERE id=? AND registration_state='registered'",
      )
      .run(projectId);
    if (changed.changes !== 1) throw new Error("Project is already unregistered");
    store.event(null, "project.unregistered", { project_id: projectId, name: project.name });
  });
  return requiredProject(store, projectId);
}

interface ProjectRelocationHooks {
  afterReservation?: () => void | Promise<void>;
}

export async function relocateProject(
  store: StateStore,
  paths: SwitchYardPaths,
  projectId: string,
  destinationInput: string,
  hooks: ProjectRelocationHooks = {},
): Promise<ProjectRecord> {
  const project = requiredProject(store, projectId);
  if (project.registration_state !== "registered")
    throw new Error("unregistered Projects cannot be relocated");
  const root = await validateProjectCheckout(store, project);
  const destination = resolveUserPath(destinationInput);
  await assertDestinationOutsideManagedRoots(paths, destination);
  if (destination === root) return project;
  const relative = path.relative(root, destination);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== "..")
    throw new Error("Project destination cannot be inside its current checkout");
  if (existsSync(destination))
    throw new Error(`Project destination already exists: ${destination}`);

  const token = reserveProjectRelocation(store, projectId, root, destination);
  let moved = false;
  try {
    await hooks.afterReservation?.();
    await mkdir(path.dirname(destination), { recursive: true });
    await moveRepository(root, destination);
    moved = true;
    const movedRoot = await canonicalRepositoryRoot(destination);
    const identity = await registerGitIdentity(movedRoot, project.git_identity);
    store.transaction(() => {
      const changed = store.db
        .prepare(`UPDATE projects SET root_path=?, git_identity=?, relocation_token=NULL,
          relocation_destination=NULL, relocation_pid=NULL
          WHERE id=? AND root_path=? AND relocation_token=?`)
        .run(movedRoot, identity, projectId, root, token);
      if (changed.changes !== 1) throw new Error("Project location reservation was lost");
      store.event(null, "project.relocated", { project_id: projectId, from: root, to: movedRoot });
    });
  } catch (error) {
    if (moved && existsSync(destination) && !existsSync(root)) {
      try {
        await moveRepository(destination, root);
        moved = false;
      } catch (rollbackError) {
        store.transaction(() =>
          store.event(null, "project.relocation_recovery_required", {
            project_id: projectId,
            from: root,
            to: destination,
            failure: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          }),
        );
        throw new Error("Project relocation failed and its checkout could not be restored");
      }
    }
    releaseProjectRelocation(store, projectId, token, error);
    throw error;
  }
  return requiredProject(store, projectId);
}

export async function recoverProjectRelocations(store: StateStore): Promise<void> {
  for (const project of store.listAllProjects()) {
    if (!project.relocation_token || processIsAlive(project.relocation_pid)) continue;
    const destination = project.relocation_destination;
    if (!destination) continue;
    const sourceExists = existsSync(project.root_path);
    const destinationExists = existsSync(destination);
    if (sourceExists === destinationExists) continue;

    const survivingPath = sourceExists ? project.root_path : destination;
    try {
      const root = await canonicalRepositoryRoot(survivingPath);
      const identity = await registerGitIdentity(root, project.git_identity);
      store.transaction(() => {
        const current = requiredProject(store, project.id);
        if (current.relocation_token !== project.relocation_token) return;
        if (sourceExists) {
          const changed = store.db
            .prepare(`UPDATE projects SET relocation_token=NULL, relocation_destination=NULL,
              relocation_pid=NULL WHERE id=? AND relocation_token=?`)
            .run(project.id, project.relocation_token);
          if (changed.changes === 1)
            store.event(null, "project.relocation_aborted", {
              project_id: project.id,
              from: project.root_path,
              to: destination,
              recovered: true,
            });
          return;
        }
        const changed = store.db
          .prepare(`UPDATE projects SET root_path=?, git_identity=?, relocation_token=NULL,
            relocation_destination=NULL, relocation_pid=NULL WHERE id=? AND root_path=?
            AND relocation_token=?`)
          .run(root, identity, project.id, project.root_path, project.relocation_token);
        if (changed.changes !== 1) throw new Error("Project relocation reservation changed");
        store.event(null, "project.relocated", {
          project_id: project.id,
          from: project.root_path,
          to: root,
          recovered: true,
        });
      });
    } catch (error) {
      store.transaction(() =>
        store.event(null, "project.relocation_recovery_failed", {
          project_id: project.id,
          from: project.root_path,
          to: destination,
          failure: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export async function listProjectRemotes(
  store: StateStore,
  projectId: string,
): Promise<Awaited<ReturnType<typeof repositoryRemotes>>> {
  const project = requiredProject(store, projectId);
  return await repositoryRemotes(await validateProjectCheckout(store, project));
}

export async function addProjectRemote(
  store: StateStore,
  projectId: string,
  name: string,
  url: string,
): Promise<void> {
  const project = requiredProject(store, projectId);
  await addGitRemote(await validateProjectCheckout(store, project), name, url);
  projectEvent(store, "project.remote_added", project, { remote: name, url });
}

export async function updateProjectRemote(
  store: StateStore,
  projectId: string,
  name: string,
  url: string,
  direction: "fetch" | "push" = "fetch",
): Promise<void> {
  const project = requiredProject(store, projectId);
  await updateGitRemote(await validateProjectCheckout(store, project), name, url, direction);
  projectEvent(store, "project.remote_updated", project, { remote: name, direction, url });
}

export async function removeProjectRemote(
  store: StateStore,
  projectId: string,
  name: string,
): Promise<void> {
  const project = requiredProject(store, projectId);
  await removeGitRemote(await validateProjectCheckout(store, project), name);
  projectEvent(store, "project.remote_removed", project, { remote: name });
}

export async function validateProjectCheckout(
  store: StateStore,
  project: ProjectRecord,
): Promise<string> {
  if (project.registration_state !== "registered")
    throw new Error(
      `Project ${project.name} is unregistered; provide its current local checkout to register it again`,
    );
  let root: string;
  try {
    root = await canonicalRepositoryRoot(project.root_path);
  } catch {
    throw new Error(
      `cannot find ${project.name} at ${project.root_path}; provide its current local checkout`,
    );
  }
  if (root !== project.root_path)
    throw new Error(
      `repository identity changed at ${project.root_path}; refusing to replace ${project.name}`,
    );
  const identity = await registerGitIdentity(root, project.git_identity);
  if (!project.git_identity) {
    store.transaction(() => {
      store.db
        .prepare("UPDATE projects SET git_identity=? WHERE id=? AND git_identity IS NULL")
        .run(identity, project.id);
    });
  }
  return root;
}

async function assertDestinationOutsideManagedRoots(
  paths: SwitchYardPaths,
  destination: string,
): Promise<void> {
  const canonicalDestination = await canonicalizeProspectivePath(destination);
  for (const managedRoot of [paths.worktrees, paths.sources, paths.reviews]) {
    const relative = path.relative(await realpath(managedRoot), canonicalDestination);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      throw new Error("Project location cannot be inside SwitchYard-managed storage");
    }
  }
}

async function canonicalizeProspectivePath(input: string): Promise<string> {
  let current = path.resolve(input);
  const missingSegments: string[] = [];
  while (true) {
    try {
      await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current)
        throw new Error("cannot safely resolve Project location through filesystem links");
      missingSegments.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.resolve(await realpath(current), ...missingSegments);
    } catch {
      throw new Error("cannot safely resolve Project location through filesystem links");
    }
  }
}

export function resolveUserPath(value: string): string {
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith(`~${path.sep}`)
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(process.env.SWITCHYARD_LAUNCH_CWD ?? process.cwd(), expanded);
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

function processIsAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function activeTasks(store: StateStore, projectId: string): TaskRecord[] {
  return store
    .listTasks()
    .filter((task) => task.project_id === projectId && !TERMINAL.has(task.state));
}

function reserveProjectRelocation(
  store: StateStore,
  projectId: string,
  root: string,
  destination: string,
): string {
  const token = randomUUID();
  store.transaction(() => {
    const project = requiredProject(store, projectId);
    if (project.registration_state !== "registered")
      throw new Error("unregistered Projects cannot be relocated");
    if (project.root_path !== root) throw new Error("Project location changed concurrently");
    if (project.relocation_token) throw new Error("Project is already being relocated");
    const active = activeTasks(store, projectId);
    if (active.length)
      throw new Error(
        `cannot relocate a Project with active Tasks: ${active.map((task) => task.title).join(", ")}`,
      );
    const workspaces = retainedWorkspaceTasks(store, projectId);
    if (workspaces.length)
      throw new Error(
        `cannot relocate a Project with retained Task Workspaces: ${workspaces.map((task) => task.title).join(", ")}`,
      );
    const changed = store.db
      .prepare(`UPDATE projects SET relocation_token=?, relocation_destination=?, relocation_pid=?
        WHERE id=? AND root_path=? AND registration_state='registered' AND relocation_token IS NULL`)
      .run(token, destination, process.pid, projectId, root);
    if (changed.changes !== 1) throw new Error("Project relocation reservation failed");
    store.event(null, "project.relocation_started", {
      project_id: projectId,
      from: root,
      to: destination,
    });
  });
  return token;
}

function releaseProjectRelocation(
  store: StateStore,
  projectId: string,
  token: string,
  error: unknown,
): void {
  store.transaction(() => {
    const project = store.getProject(projectId);
    if (!project) return;
    const changed = store.db
      .prepare(`UPDATE projects SET relocation_token=NULL, relocation_destination=NULL,
        relocation_pid=NULL WHERE id=? AND relocation_token=?`)
      .run(projectId, token);
    if (changed.changes === 1)
      store.event(null, "project.relocation_aborted", {
        project_id: projectId,
        from: project.root_path,
        to: project.relocation_destination,
        failure: error instanceof Error ? error.message : String(error),
      });
  });
}

function retainedWorkspaceTasks(store: StateStore, projectId: string): TaskRecord[] {
  return store
    .listTasks()
    .filter((task) => task.project_id === projectId)
    .filter((task) => {
      const workspace = store.getWorkspace(task.id);
      return (
        workspace?.provisioned === 1 || (workspace !== undefined && existsSync(workspace.path))
      );
    });
}

function projectEvent(
  store: StateStore,
  type: string,
  project: ProjectRecord,
  payload: Record<string, unknown>,
): void {
  store.transaction(() => store.event(null, type, { project_id: project.id, ...payload }));
}

function requiredProject(store: StateStore, projectId: string): ProjectRecord {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function normalizeProjectName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("Project name is required");
  return normalized;
}
