import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TaskKind = "implement" | "investigate";
export type ReviewPolicy = "off" | "loop";
export type TaskState =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "needs_decision"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProjectRecord {
  id: string;
  root_path: string;
  created_at: string;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  kind: TaskKind;
  instruction: string;
  review_policy: ReviewPolicy;
  state: TaskState;
  base_sha: string | null;
  candidate_sha: string | null;
  summary: string | null;
  verification_summary: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRecord {
  task_id: string;
  path: string;
  branch: string;
  created_at: string;
}

export interface WorkerRecord {
  id: string;
  task_id: string;
  state: "starting" | "active" | "stopped";
  tmux_window: string;
  created_at: string;
  ended_at: string | null;
}

export interface MessageRecord {
  id: string;
  task_id: string;
  recipient: "worker" | "supervisor";
  text: string;
  state: "pending" | "delivered";
  created_at: string;
  delivered_at: string | null;
}

export interface DecisionRecord {
  id: string;
  task_id: string;
  question: string;
  context: string | null;
  options_json: string | null;
  state: "open" | "resolved";
  answer: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ReviewRecord {
  id: string;
  task_id: string;
  candidate_sha: string;
  state: "running" | "changes_requested" | "clean" | "failed";
  attempts: number;
  tmux_window: string;
  path: string;
  summary: string | null;
  created_at: string;
  completed_at: string | null;
  startup_reserved: number;
  runtime_starting: number;
  runtime_starter_pid: number | null;
}

export interface FindingRecord {
  id: string;
  review_id: string;
  summary: string;
  rationale: string;
  required_change: string;
  path: string | null;
  line: number | null;
}

export interface EventRecord {
  id: number;
  task_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

const SCHEMA_VERSION = 2;

export class StateStore {
  readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.configure();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  event(taskId: string | null, type: string, payload: unknown = {}): void {
    this.db
      .prepare("INSERT INTO events(task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, type, JSON.stringify(payload), now());
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRecord
      | undefined;
  }

  getProjectByRoot(rootPath: string): ProjectRecord | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE root_path = ?").get(rootPath) as
      | ProjectRecord
      | undefined;
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at, id")
      .all() as unknown as ProjectRecord[];
  }

  getTask(id: string): TaskRecord | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRecord | undefined;
  }

  listTasks(): TaskRecord[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC")
      .all() as unknown as TaskRecord[];
  }

  getWorkspace(taskId: string): WorkspaceRecord | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE task_id = ?").get(taskId) as
      | WorkspaceRecord
      | undefined;
  }

  getActiveWorker(taskId: string): WorkerRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM workers WHERE task_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as WorkerRecord | undefined;
  }

  getLiveWorker(taskId: string): WorkerRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM workers WHERE task_id = ? AND state IN ('starting','active') ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as WorkerRecord | undefined;
  }

  listWorkers(taskId: string): WorkerRecord[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE task_id = ? ORDER BY created_at, id")
      .all(taskId) as unknown as WorkerRecord[];
  }

  listPendingMessages(taskId: string, recipient: "worker" | "supervisor"): MessageRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE task_id = ? AND recipient = ? AND state = 'pending' ORDER BY created_at, id",
      )
      .all(taskId, recipient) as unknown as MessageRecord[];
  }

  getOpenDecision(taskId: string): DecisionRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM decisions WHERE task_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as DecisionRecord | undefined;
  }

  getDecision(id: string): DecisionRecord | undefined {
    return this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
      | DecisionRecord
      | undefined;
  }

  getReview(id: string): ReviewRecord | undefined {
    return this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as
      | ReviewRecord
      | undefined;
  }

  getLatestReview(taskId: string): ReviewRecord | undefined {
    return this.db
      .prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(taskId) as ReviewRecord | undefined;
  }

  listReviews(taskId: string): ReviewRecord[] {
    return this.db
      .prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, id DESC")
      .all(taskId) as unknown as ReviewRecord[];
  }

  getRunningReviewForCandidate(taskId: string, candidateSha: string): ReviewRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM reviews WHERE task_id = ? AND candidate_sha = ? AND state = 'running'",
      )
      .get(taskId, candidateSha) as ReviewRecord | undefined;
  }

  listFindings(reviewId: string): FindingRecord[] {
    return this.db
      .prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY rowid")
      .all(reviewId) as unknown as FindingRecord[];
  }

  listEvents(taskId?: string): EventRecord[] {
    if (taskId) {
      return this.db
        .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id")
        .all(taskId) as unknown as EventRecord[];
    }
    return this.db.prepare("SELECT * FROM events ORDER BY id").all() as unknown as EventRecord[];
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) {
      throw new Error(
        `database schema ${row.user_version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (row.user_version === SCHEMA_VERSION) return;

    this.transaction(() => {
      if (row.user_version === 0) {
        this.db.exec(`
          CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            root_path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
          );
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            kind TEXT NOT NULL CHECK(kind IN ('implement','investigate')),
            instruction TEXT NOT NULL,
            review_policy TEXT NOT NULL CHECK(review_policy IN ('off','loop')),
            state TEXT NOT NULL CHECK(state IN ('queued','starting','running','waiting','needs_decision','reviewing','completed','failed','cancelled')),
            base_sha TEXT,
            candidate_sha TEXT,
            summary TEXT,
            verification_summary TEXT,
            failure TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE workspaces (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id),
            path TEXT NOT NULL UNIQUE,
            branch TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
          );
          CREATE TABLE workers (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            state TEXT NOT NULL CHECK(state IN ('starting','active','stopped')),
            tmux_window TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ended_at TEXT
          );
          CREATE UNIQUE INDEX one_live_worker_per_task ON workers(task_id) WHERE state IN ('starting','active');
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            recipient TEXT NOT NULL CHECK(recipient IN ('worker','supervisor')),
            text TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
            created_at TEXT NOT NULL,
            delivered_at TEXT
          );
          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            question TEXT NOT NULL,
            context TEXT,
            options_json TEXT,
            state TEXT NOT NULL CHECK(state IN ('open','resolved')),
            answer TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
          );
          CREATE UNIQUE INDEX one_open_decision_per_task ON decisions(task_id) WHERE state='open';
          CREATE TABLE reviews (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            candidate_sha TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('running','changes_requested','clean','failed')),
            attempts INTEGER NOT NULL DEFAULT 1,
            tmux_window TEXT NOT NULL,
            path TEXT NOT NULL,
            summary TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT
          );
          CREATE TABLE findings (
            id TEXT PRIMARY KEY,
            review_id TEXT NOT NULL REFERENCES reviews(id),
            summary TEXT NOT NULL,
            rationale TEXT NOT NULL,
            required_change TEXT NOT NULL,
            path TEXT,
            line INTEGER
          );
          CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT REFERENCES tasks(id),
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          PRAGMA user_version = 1;
        `);
      }
    });

    this.transaction(() => {
      if (row.user_version <= 1) {
        this.db.exec(`
          ALTER TABLE reviews ADD COLUMN startup_reserved INTEGER NOT NULL DEFAULT 0
            CHECK(startup_reserved IN (0,1));
          ALTER TABLE reviews ADD COLUMN runtime_starting INTEGER NOT NULL DEFAULT 0
            CHECK(runtime_starting IN (0,1));
          ALTER TABLE reviews ADD COLUMN runtime_starter_pid INTEGER;
        `);

        const activeReviews = this.db
          .prepare(
            "SELECT id, task_id, candidate_sha FROM reviews WHERE state='running' ORDER BY created_at DESC, id DESC",
          )
          .all() as Array<{ id: string; task_id: string; candidate_sha: string }>;
        const seenCandidates = new Set<string>();
        for (const review of activeReviews) {
          const key = `${review.task_id}:${review.candidate_sha}`;
          if (!seenCandidates.has(key)) {
            seenCandidates.add(key);
            continue;
          }
          const failure =
            "superseded by a newer active Review for the same candidate during migration";
          this.db
            .prepare(
              "UPDATE reviews SET state='failed', summary=?, completed_at=? WHERE id=? AND state='running'",
            )
            .run(failure, now(), review.id);
          this.event(review.task_id, "review.superseded", {
            review_id: review.id,
            candidate_sha: review.candidate_sha,
            failure,
          });
        }

        this.db.exec(`
          CREATE UNIQUE INDEX one_running_review_per_candidate
            ON reviews(task_id, candidate_sha) WHERE state='running';
          PRAGMA user_version = 2;
        `);
      }
    });
  }
}

export function now(): string {
  return new Date().toISOString();
}
