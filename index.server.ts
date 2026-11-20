/**
 * Entry point for the Curator plugin (server-only; no client/UI in v1).
 *
 * Production wiring (Task 5C):
 *
 * - `registerCuratorHook` installs exactly one `agent.turn.after` hook. The
 *   first lifecycle event lazily constructs one runtime synchronously from
 *   `context.paseo`; `start()` is invoked exactly once and detached. Eligible
 *   events (completed, non-null turn id, not a curator agent) call
 *   `handleCompletedTurn(agent, turnId)` with the event's exact identity.
 *   Every rejection is contained and never leaks into the hook result.
 * - The returned cleanup function is idempotent: it removes the hook
 *   immediately, invokes `shutdown()` immediately, awaits both the in-flight
 *   `start()` and `shutdown()`, then closes the runtime exactly once.
 * - The default `contribute` delegates to `registerCuratorHook` with the
 *   production factory: `~/.agents/skills` skill root, a single
 *   `~/.paseo/plugins/curator/curator.sqlite` store, one Paseo adapter, one
 *   guarded skill manager, one orchestrator, a detached microtask scheduler,
 *   and a safe deterministic skill-summary reader.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  PluginHookContext,
  PluginHookPayload,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { curatorSettings } from "./shared/settings";


import { CuratorOrchestrator, type SkillSummary } from "./server/orchestrator";
import { PaseoAdapter, type PaseoApiRef, type SourceAgent, type RoutingSettings } from "./server/paseo-adapter";
import { CuratorStore } from "./server/store";
import { SkillManager } from "./server/skill-manager";
import { parseFrontmatter } from "./server/skill-files";
import type { PluginConfig } from "./server/contracts";
import { ReconciliationRunner } from "./server/reconciliation";
import { MaintenanceRunner } from "./server/maintenance";
import { appendCuratorActivity } from "./server/activity";
type PaseoApi = PluginHookContext["paseo"];

/** Metadata key marking a curator-created agent so it is excluded from its own trigger. */
export const CURATOR_AGENT_METADATA_KEY = "paseo.curator";

/**
 * True when the agent carries the curator marker. Such agents must never
 * re-enter the review trigger (recursion control).
 *
 * Strict boolean equality only: `"true"`, `1`, or any other lookalike does
 * not mark an agent as a curator.
 */
export function isCuratorAgent(metadata: Record<string, unknown>): boolean {
  return metadata[CURATOR_AGENT_METADATA_KEY] === true;
}

// ---------------------------------------------------------------------------
// Runtime surface
// ---------------------------------------------------------------------------

/**
 * The lifecycle surface owned by the plugin hook: construct lazily from the
 * first Paseo API reference, start once, handle eligible completed turns, and
 * shut down then close idempotently.
 */
export interface CuratorRuntime {
  /** Boots the runtime (stale-row recovery + initial drain). */
  start(): Promise<void>;
  /** Handle one eligible completed source turn (fast path). */
  handleCompletedTurn(agent: SourceAgent, turnId: string): Promise<unknown>;
  /** Stop scheduling and wait for the active drain. */
  shutdown(): Promise<void>;
  /** Release all resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Constructs the curator runtime from the Paseo API handed by the first
 * lifecycle event. Injectable so tests can script the runtime.
 */
export type CuratorRuntimeFactory = (paseo: PaseoApi) => CuratorRuntime;

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

/**
 * Registers the production `agent.turn.after` hook against the plugin server.
 *
 * Semantics (pinned by tests):
 *
 * - Exactly one hook is registered; no other server registrations occur.
 * - On the first lifecycle event, the runtime is constructed synchronously
 *   from `context.paseo` through `runtimeFactory`, and `start()` is invoked
 *   exactly once, detached (never awaited inside the hook, rejection
 *   contained). Later events reuse the same runtime.
 * - An event is eligible iff `outcome.kind === "completed"`, `turnId` is
 *   non-null, and the agent is not a curator agent. Eligible events call
 *   `handleCompletedTurn(agent, turnId)` with the event's exact identity; the
 *   call is awaited and its rejection is contained. The hook always resolves
 *   to `null` and never leaks an error message.
 * - The returned cleanup is idempotent: it removes the hook immediately
 *   (synchronously), invokes `shutdown()` immediately, awaits both the
 *   in-flight `start()` promise and `shutdown()`, then closes the runtime
 *   exactly once. Concurrent calls share one in-flight cleanup promise, so
 *   each side effect runs exactly once and both resolve after the lifecycle
 *   settles. No logging of errors.
 * - A synchronous `runtimeFactory` or `start()` failure is contained: the
 *   hook resolves `null` without leaking error content, and the runtime stays
 *   unset so a later lifecycle event may retry.
 */
export function registerCuratorHook(
  server: PluginServerContext,
  runtimeFactory: CuratorRuntimeFactory,
): () => Promise<void> {
  let runtime: CuratorRuntime | null = null;
  let startPromise: Promise<void> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let removeHook: (() => void) | null = null;
  const activeHandlers = new Set<Promise<void>>();

  const handleEvent = async (
    payload: PluginHookPayload<"agent.turn.after">,
    context: PluginHookContext,
  ): Promise<void> => {
    // The first lifecycle event is the first available Paseo API. Build the
    // runtime so concurrent events share it (no race window: construction
    // cannot interleave with another handler). Any synchronous failure in
    // construction or in `start()` is contained, and the runtime is left
    // unset so a later lifecycle event may safely retry.
    if (runtime === null) {
      let built: CuratorRuntime;
      try {
        built = runtimeFactory(context.paseo);
      } catch {
        // Contained: no logs, no raw error, nothing surfaced. The runtime
        // stays unset so a later event retries the construction.
        return null as unknown as void;
      }
      let started: Promise<void>;
      try {
        started = built.start();
      } catch {
        // Synchronous start failure: contained; the runtime is never
        // installed, so a later lifecycle event may retry.
        return null as unknown as void;
      }
      // Start exactly once, detached. The rejection (if any) is contained so
      // the daemon never observes a plugin failure; the result never carries
      // error content.
      startPromise = started.catch(() => {
        /* contained: no logs, no raw error, nothing surfaced */
      });
      runtime = built;
    }

    // Eligibility: completed + non-null turn id + not a curator agent.
    // (Eligibility is checked before any work; failed/canceled/null-turn
    // events accumulate nothing.)
    if (outcomeIsCompleted(payload.outcome)) {
      const { agent, turnId } = payload;
      if (turnId !== null && !isCuratorAgent(agent.metadata)) {
        const sourceAgent: SourceAgent = {
          id: agent.id,
          provider: agent.provider,
          cwd: agent.cwd,
        };
        try {
          await runtime.handleCompletedTurn(sourceAgent, turnId);
        } catch {
          // Contained: an error here must not reject the hook or surface
          // transcript/model content into the daemon.
        }
      }
    }

    // The hook resolves to `null`: an omitted hook result stays as it was,
    // and the resolved value carries no error content.
    return null as unknown as void;
  };

  const handler = (
    payload: PluginHookPayload<"agent.turn.after">,
    context: PluginHookContext,
  ): Promise<void> => {
    const handling = handleEvent(payload, context);
    activeHandlers.add(handling);
    void handling.then(
      () => activeHandlers.delete(handling),
      () => activeHandlers.delete(handling),
    );
    return handling;
  };

  removeHook = server.addHook("agent.turn.after", handler);

  return () => {
    // Concurrent cleanup calls share one in-flight cleanup promise: the hook
    // is removed once, `shutdown()` invoked once, both the in-flight
    // `start()` and `shutdown()` awaited, and `close()` exactly once.
    if (cleanupPromise === null) {
      cleanupPromise = (async () => {
        // Remove the hook immediately so no further events arrive.
        if (removeHook !== null) {
          removeHook();
          removeHook = null;
        }

        if (runtime === null) {
          return;
        }

        // Invoke shutdown immediately (without awaiting) so that, even if
        // start() is still in flight, shutdown observes the in-flight state.
        let shutdownPromise: Promise<void>;
        try {
          shutdownPromise = runtime.shutdown();
        } catch {
          shutdownPromise = Promise.resolve();
        }

        // Await both the (possibly in-flight) start and the shutdown; then
        // close exactly once. All rejections are contained.
        await Promise.allSettled([
          startPromise ?? Promise.resolve(),
          shutdownPromise,
          ...activeHandlers,
        ]);
        await runtime.close().catch(() => {
          /* contained */
        });
      })();
    }
    return cleanupPromise;
  };
}

function outcomeIsCompleted(outcome: PluginHookPayload<"agent.turn.after">["outcome"]): boolean {
  return outcome.kind === "completed";
}

// ---------------------------------------------------------------------------
// Default contribution (production factory)
// ---------------------------------------------------------------------------

/** Default skill root: `~/.agents/skills` (the PluginConfig default). */
const DEFAULT_SKILL_ROOT = "~/.agents/skills";

/** Plugin state directory: `~/.paseo/plugins/curator`. */
const STATE_DIR = "~/.paseo/plugins/curator";

/** Default PluginConfig values (the schema's `.default(...)` values). */
const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  skillRoot: DEFAULT_SKILL_ROOT,
  reviewThreshold: 10,
  curatorConcurrency: 1,
  maxOperations: 20,
  maintenanceEnabled: true,
  consolidationEnabled: false,
  staleDays: 14,
  archiveDays: 30,
  maxRetries: 3,
};

/**
 * Expand a leading `~` (or `~user`) against the home directory.
 * Relative or absolute paths pass through unchanged.
 */
function expandHome(path: string): string {
  const home = homedir();
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }
  if (path === home) {
    return path;
  }
  return path;
}

/**
 * Extract the top-level `description` value from raw frontmatter text.
 *
 * Scans the raw block for a top-level `description:` key (same shape rules as
 * the frontmatter parser) and applies the same quote-stripping. Returns
 * `null` when the key is absent or its value is empty.
 */
function frontmatterDescription(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const m = line.match(/^description\s*:\s*(.*)$/);
    if (m === null) {
      continue;
    }
    let value = m[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Safe, deterministic skill-summary reader.
 *
 * Lists real directories under the skill root that contain a SKILL.md with
 * well-formed frontmatter carrying a `description`. Skips (without throwing):
 * dot directories, symlinks (of any kind), directories without a readable
 * SKILL.md, and unreadable or malformed frontmatter. `description` is the
 * actual top-level YAML `description:` field (quoted values supported,
 * consistent with the frontmatter parser); `skillName` is the directory name.
 * Results are sorted by skill name so the index is deterministic independent
 * of readdir order. Never throws.
 */
export function readSkillSummaries(skillRoot: string): Promise<SkillSummary[]> {
  const summaries: SkillSummary[] = [];
  try {
    const root = resolve(skillRoot);
    const rootStat = safeLstat(root);
    if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return Promise.resolve([]);
    }

    const entries = readdirSync(root, { withFileTypes: true });
    const names = entries
      .filter((entry) => {
        if (entry.name.startsWith(".")) {
          return false;
        }
        if (entry.isSymbolicLink()) {
          return false;
        }
        if (!entry.isDirectory()) {
          return false;
        }
        return true;
      })
      .map((entry) => entry.name)
      .sort();

    for (const name of names) {
      try {
        const content = readFileSync(join(root, name, "SKILL.md"), "utf8");
        const parsed = parseFrontmatter(content);
        if (parsed === null) {
          continue;
        }
        const description = frontmatterDescription(parsed.frontmatter.raw);
        if (description === null) {
          continue;
        }
        summaries.push({
          skillName: name,
          description,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } catch {
        // Unreadable skill.md (or frontmatter failure): skip the entry.
      }
    }
  } catch {
    // The root is missing or unreadable: no skills. Never throws.
  }
  return Promise.resolve(summaries);
}

function safeLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}


/**
 * The production curator runtime: one store connection, one adapter, one
 * skill manager, one orchestrator, a detached microtask scheduler.
 */
export function createProductionRuntime(
  paseo: PaseoApi,
  config: PluginConfig = DEFAULT_PLUGIN_CONFIG,
  options: { stateDir?: string; settings?: RoutingSettings } = {},
): CuratorRuntime {
  const skillRoot = expandHome(config.skillRoot);
  // `PaseoApiRef` mirrors the real `PaseoApi` for exactly the surface the
  // adapter consumes; cast through `unknown` (type-only SDK import, no `any`).
  const adapter = new PaseoAdapter(paseo as unknown as PaseoApiRef, options.settings);

  const stateDir = options.stateDir ?? expandHome(STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const store = new CuratorStore(join(stateDir, "curator.sqlite"), {
    reviewThreshold: config.reviewThreshold,
    maxRetries: config.maxRetries,
  });

  const skillManager = new SkillManager(skillRoot);

  const orchestrator = new CuratorOrchestrator({
    store,
    adapter,
    skillManager,
    listSkills: async () => {
      const skills = await readSkillSummaries(skillRoot);
      const viewed = [...skills].sort((a, b) =>
        a.skillName.toLowerCase() === b.skillName.toLowerCase()
          ? a.skillName.localeCompare(b.skillName)
          : a.skillName.toLowerCase().localeCompare(b.skillName.toLowerCase()),
      ).slice(0, 50);
      for (const skill of viewed) {
        store.recordSkillActivity(skill.skillName, "unknown", "view");
      }
      return skills;
    },
    schedule: (task) => {
      queueMicrotask(() => {
        task().catch(() => {
          /* detached drains are fully content-bounded; contain any
             unexpected rejection so it never becomes an unhandled one. */
        });
      });
    },
    notify: (notification) => appendCuratorActivity(paseo, notification),
  });

  const reconciliation = new ReconciliationRunner({
    getCursor: () => store.getReconciliationCursor(),
    setCursor: (cursor) => store.setReconciliationCursor(cursor),
    hasTurn: (agentId, turnId) => store.hasObservedTurn(agentId, turnId),
    discover: (cursor) => adapter.discoverRecentCompletedTurns(cursor),
    handleTurn: (agent, turnId) => orchestrator.handleCompletedTurn(agent, turnId),
  });

  let maintenanceSequence = 0;
  const maintenance = new MaintenanceRunner({
    staleAfterMs: config.staleDays * 24 * 60 * 60 * 1_000,
    archiveAfterMs: config.archiveDays * 24 * 60 * 60 * 1_000,
    listTelemetry: () => store.listSkillTelemetry(),
    setState: (skillName, state) => store.setSkillState(skillName, state),
    archiveSkill: async (skillName) => {
      const queueId = `maintenance-${Date.now()}-${maintenanceSequence++}`;
      const result = await skillManager.applyBatch(
        [{ type: "archive", skillName }],
        [],
        {
          queueId,
          reviewSnapshot: skillManager.captureReviewSnapshot(),
          sourceAgentId: "paseo-curator-maintenance",
          turnId: skillName,
        },
      );
      const applied = result.outcome === "applied";
      store.recordAudit({
        queueId,
        sourceAgentId: "paseo-curator-maintenance",
        turnId: skillName,
        outcome: applied ? "applied" : "rejected",
        summary: applied ? "maintenance archive applied" : "maintenance archive rejected",
        operationCount: 1,
        operationsHash: createHash("sha256")
          .update(JSON.stringify([{ type: "archive", skillName }]))
          .digest("hex"),
        skillNames: [skillName],
        ...(applied ? {} : { rejectionReason: `apply outcome: ${result.outcome}` }),
      });
      return result.outcome === "applied" ? "applied" : "rejected";
    },
  });

  let storeClosed = false;
  let closed = false;
  let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  const stopTimers = (): void => {
    if (reconciliationTimer !== null) clearInterval(reconciliationTimer);
    if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
    reconciliationTimer = null;
    maintenanceTimer = null;
  };

  const unrefTimer = (timer: unknown): void => {
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  };

  const start = async (): Promise<void> => {
    await orchestrator.start();
    await reconciliation.runOnce().catch(() => "ran" as const);
    if (config.maintenanceEnabled) {
      await maintenance.runOnce().catch(() => "ran" as const);
    }
    reconciliationTimer = setInterval(() => {
      void reconciliation.runOnce().catch(() => { /* contained */ });
    }, 5 * 60 * 1_000);
    unrefTimer(reconciliationTimer);
    if (config.maintenanceEnabled) {
      maintenanceTimer = setInterval(() => {
        void maintenance.runOnce().catch(() => { /* contained */ });
      }, 24 * 60 * 60 * 1_000);
      unrefTimer(maintenanceTimer);
    }
  };

  const shutdown = async (): Promise<void> => {
    stopTimers();
    await Promise.all([
      reconciliation.shutdown(),
      maintenance.shutdown(),
      orchestrator.shutdown(),
    ]);
  };

  return {
    start,
    handleCompletedTurn: async (agent, turnId) => {
      try {
        const loadedSkills = await adapter.listLoadedSkillNames(agent.id);
        for (const skillName of loadedSkills) {
          store.recordSkillActivity(skillName, "unknown", "use");
        }
      } catch {
        // Skill-usage telemetry is best effort and must never block learning.
      }
      return orchestrator.handleCompletedTurn(agent, turnId);
    },
    shutdown,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      // The store closes only after the orchestrator has shut down, so no
      // drain can be writing to the database while it is being closed.
      try {
        await shutdown();
      } catch {
        /* contained */
      }
      if (!storeClosed) {
        storeClosed = true;
        store.close();
      }
    },
  };
}

export default function contribute(server: PluginServerContext): () => Promise<void> {
  const settings = server.registerSettings(curatorSettings);
  return registerCuratorHook(server, (paseo) => createProductionRuntime(paseo, DEFAULT_PLUGIN_CONFIG, { settings }));
}
