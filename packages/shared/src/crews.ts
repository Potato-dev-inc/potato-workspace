// The crew data model as the app and the command line share it (Rust: `crews/model.rs`, `crews/view.rs`).
// 1.1.6 reads and checks crews only. The canvas of 1.1.7 draws these same fields.

/** What a role may do. `write`: none | worktree | scoped (then `write_scope` names the one folder). `run`: none | read-only | worktree | ask. */
export interface CrewPermissions {
  read: boolean;
  write: 'none' | 'worktree' | 'scoped';
  write_scope?: string | null;
  run: 'none' | 'read-only' | 'worktree' | 'ask';
  start_helpers: boolean;
  merge: boolean;
}

export interface CrewBudget {
  turns?: number | null;
  minutes?: number | null;
}

/** Where a role sits on the canvas (1.1.7). */
export interface CrewPosition {
  x: number;
  y: number;
}

export interface CrewRole {
  /** A short stable id (`worker-easy`). Empty or missing: the name is the id. */
  id?: string;
  name: string;
  agent_type: string;
  /** The job text; may use `{folder}`. */
  task: string;
  /** The role this one is under; null or missing for the lead (the orchestrator). */
  parent?: string | null;
  model?: string | null;
  permissions?: CrewPermissions | null;
  /** Helpers of this role to keep warm. */
  standbys?: number;
  /** Ids or names of the roles this one hands work to. */
  hands_to?: string[];
  /** A checker: its hand-back to the lead is the only loop a crew may have. */
  check?: boolean;
  position?: CrewPosition | null;
}

export interface Crew {
  name: string;
  roles: CrewRole[];
  budget?: CrewBudget | null;
  max_helpers?: number | null;
  fix_loops?: number | null;
  /** A plain file name such as `difficulty.md`. */
  routing_file?: string | null;
}

export interface CrewProblem {
  code: string;
  role: string | null;
  message: string;
}

/** One row of `GET /crews`. */
export interface CrewSummary {
  slug: string;
  name: string;
  roles: number;
  agents: string[];
  /** Why this crew cannot be used right now; null when it is fine. */
  problem: string | null;
}

/** `GET /crews`: saved crews and the read-only templates. */
export interface CrewList {
  crews: CrewSummary[];
  templates: CrewSummary[];
}

/** `GET /crews/{id}`. */
export interface CrewDetail {
  id: string;
  kind: 'saved' | 'template';
  crew: Crew;
  problems: CrewProblem[];
  /** The routing file text of a template. */
  routing_text: string | null;
}

/** `POST /crews/validate`. */
export interface CrewCheck {
  ok: boolean;
  kind: 'crew' | 'config';
  crews: Array<{ id: string; name: string; roles: number; problems: CrewProblem[] }>;
  problems: CrewProblem[];
}
