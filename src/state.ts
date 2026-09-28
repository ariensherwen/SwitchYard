import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
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
  name: string;
  root_path: string;
  remote_url: string | null;
  registration_state: "registered" | "unregistered";
  git_identity: string | null;
  relocation_token: string | null;
  relocation_destination: string | null;
  relocation_pid: number | null;
  created_at: string;
}

export interface TaskRecord {
  id: string;
  project_id: string | null;
  source_path: string | null;
  source_url: string | null;
  source_label: string | null;
  source_ref: string | null;
  source_revision: string | null;
  base_ref: string | null;
  dirty_acknowledged: number;
  title: string;
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
  provisioned: number;
  provisioner_pid: number | null;
  provisioner_token: string | null;
  created_at: string;
}

export interface WorkerRecord {
  id: string;
  task_id: string;
  state: "starting" | "active" | "stopped";
  tmux_window: string;
  runtime_starting: number;
  runtime_starter_pid: number | null;
  runtime_startup_token: string | null;
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
  state: "open" | "resolved" | "cancelled";
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
  runtime_startup_token: string | null;
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

const SCHEMA_VERSION = 10;
const MAX_READABLE_SCHEMA_VERSION = 11;

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
      .prepare(
        "SELECT * FROM projects WHERE registration_state='registered' ORDER BY created_at, id",
      )
      .all() as unknown as ProjectRecord[];
  }

  listAllProjects(): ProjectRecord[] {
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
    if (row.user_version > MAX_READABLE_SCHEMA_VERSION) {
      throw new Error(
        `database schema ${row.user_version} is newer than supported ${MAX_READABLE_SCHEMA_VERSION}`,
      );
    }
    if (row.user_version >= SCHEMA_VERSION) return;

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

    this.transaction(() => {
      if (row.user_version <= 2) {
        this.db.exec(`
          ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT '';
          ALTER TABLE projects ADD COLUMN remote_url TEXT;
          ALTER TABLE workspaces ADD COLUMN provisioned INTEGER NOT NULL DEFAULT 1
            CHECK(provisioned IN (0,1));
          PRAGMA user_version = 3;
        `);
        const projects = this.db
          .prepare("SELECT id, root_path FROM projects WHERE name = ''")
          .all() as Array<{ id: string; root_path: string }>;
        const updateName = this.db.prepare("UPDATE projects SET name=? WHERE id=?");
        for (const project of projects) updateName.run(basename(project.root_path), project.id);
      }
    });

    if (row.user_version <= 3) {
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE tasks_new (
              id TEXT PRIMARY KEY,
              project_id TEXT REFERENCES projects(id),
              source_path TEXT,
              source_url TEXT,
              title TEXT NOT NULL,
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
              updated_at TEXT NOT NULL,
              CHECK (
                (project_id IS NOT NULL AND source_path IS NULL AND source_url IS NULL)
                OR (project_id IS NULL AND source_path IS NOT NULL AND source_url IS NOT NULL
                  AND kind='investigate' AND review_policy='off')
              )
            );
            INSERT INTO tasks_new(
              id, project_id, source_path, source_url, title, kind, instruction, review_policy,
              state, base_sha, candidate_sha, summary, verification_summary, failure, created_at,
              updated_at
            )
            SELECT id, project_id, NULL, NULL, instruction, kind, instruction, review_policy,
              state, base_sha, candidate_sha, summary, verification_summary, failure, created_at,
              updated_at FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_new RENAME TO tasks;

            CREATE TABLE decisions_new (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              question TEXT NOT NULL,
              context TEXT,
              options_json TEXT,
              state TEXT NOT NULL CHECK(state IN ('open','resolved','cancelled')),
              answer TEXT,
              created_at TEXT NOT NULL,
              resolved_at TEXT
            );
            INSERT INTO decisions_new(
              id, task_id, question, context, options_json, state, answer, created_at, resolved_at
            ) SELECT id, task_id, question, context, options_json, state, answer, created_at,
              resolved_at FROM decisions;
            DROP TABLE decisions;
            ALTER TABLE decisions_new RENAME TO decisions;
            CREATE UNIQUE INDEX one_open_decision_per_task ON decisions(task_id) WHERE state='open';
            PRAGMA user_version = 4;
          `);
        });
      } finally {
        this.db.exec("PRAGMA foreign_keys=ON");
      }
      const violations = this.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error("schema migration left foreign key violations");
    }

    if (row.user_version <= 4) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workers (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            state TEXT NOT NULL CHECK(state IN ('starting','active','stopped')),
            tmux_window TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ended_at TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS one_live_worker_per_task
            ON workers(task_id) WHERE state IN ('starting','active');
          ALTER TABLE workspaces ADD COLUMN provisioner_pid INTEGER;
          ALTER TABLE workspaces ADD COLUMN provisioner_token TEXT;
          ALTER TABLE workers ADD COLUMN runtime_starting INTEGER NOT NULL DEFAULT 0
            CHECK(runtime_starting IN (0,1));
          ALTER TABLE workers ADD COLUMN runtime_starter_pid INTEGER;
          ALTER TABLE workers ADD COLUMN runtime_startup_token TEXT;
          ALTER TABLE reviews ADD COLUMN runtime_startup_token TEXT;
          PRAGMA user_version = 5;
        `);
      });
    }

    if (row.user_version <= 5) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE projects ADD COLUMN registration_state TEXT NOT NULL DEFAULT 'registered'
            CHECK(registration_state IN ('registered','unregistered'));
          ALTER TABLE projects ADD COLUMN git_identity TEXT;
          ALTER TABLE tasks ADD COLUMN source_label TEXT;
          ALTER TABLE tasks ADD COLUMN source_revision TEXT;
          ALTER TABLE tasks ADD COLUMN base_ref TEXT;
          ALTER TABLE tasks ADD COLUMN dirty_acknowledged INTEGER NOT NULL DEFAULT 0
            CHECK(dirty_acknowledged IN (0,1));
          CREATE TRIGGER tasks_review_policy_insert
            BEFORE INSERT ON tasks WHEN NEW.review_policy='loop' AND NEW.kind!='implement'
            BEGIN SELECT RAISE(ABORT, 'review loop is supported only for implement tasks'); END;
          CREATE TRIGGER tasks_review_policy_update
            BEFORE UPDATE OF kind, review_policy ON tasks
            WHEN NEW.review_policy='loop' AND NEW.kind!='implement'
            BEGIN SELECT RAISE(ABORT, 'review loop is supported only for implement tasks'); END;
          CREATE TRIGGER tasks_base_sha_immutable
            BEFORE UPDATE OF base_sha ON tasks
            WHEN OLD.base_sha IS NOT NULL AND NEW.base_sha IS NOT OLD.base_sha
            BEGIN SELECT RAISE(ABORT, 'task base SHA is immutable'); END;
          PRAGMA user_version = 6;
        `);
      });
    }

    if (row.user_version <= 6) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE tasks ADD COLUMN source_ref TEXT;
          PRAGMA user_version = 7;
        `);
      });
    }

    if (row.user_version <= 7) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TRIGGER tasks_base_ref_immutable
            BEFORE UPDATE OF base_ref ON tasks
            WHEN OLD.base_ref IS NOT NULL AND NEW.base_ref IS NOT OLD.base_ref
            BEGIN SELECT RAISE(ABORT, 'task base ref is immutable'); END;
          PRAGMA user_version = 8;
        `);
      });
    }

    if (row.user_version <= 8) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TRIGGER tasks_source_url_immutable
            BEFORE UPDATE OF source_url ON tasks
            WHEN OLD.source_url IS NOT NULL AND NEW.source_url IS NOT OLD.source_url
            BEGIN SELECT RAISE(ABORT, 'task source URL is immutable'); END;
          CREATE TRIGGER tasks_source_revision_immutable
            BEFORE UPDATE OF source_revision ON tasks
            WHEN OLD.source_revision IS NOT NULL AND NEW.source_revision IS NOT OLD.source_revision
            BEGIN SELECT RAISE(ABORT, 'task source revision is immutable'); END;
          CREATE TRIGGER tasks_source_ref_immutable
            BEFORE UPDATE OF source_ref ON tasks
            WHEN OLD.source_ref IS NOT NULL AND NEW.source_ref IS NOT OLD.source_ref
            BEGIN SELECT RAISE(ABORT, 'task source ref is immutable'); END;
          CREATE TRIGGER tasks_dirty_acknowledgement_immutable
            BEFORE UPDATE OF dirty_acknowledged ON tasks
            WHEN NEW.dirty_acknowledged IS NOT OLD.dirty_acknowledged
            BEGIN SELECT RAISE(ABORT, 'task dirty-checkout acknowledgement is immutable'); END;
          PRAGMA user_version = 9;
        `);
      });
    }

    if (row.user_version <= 9) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE projects ADD COLUMN relocation_token TEXT;
          ALTER TABLE projects ADD COLUMN relocation_destination TEXT;
          ALTER TABLE projects ADD COLUMN relocation_pid INTEGER;
          PRAGMA user_version = 10;
        `);
      });
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}
