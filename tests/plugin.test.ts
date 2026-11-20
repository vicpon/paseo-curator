/**
 * Task 5C — plugin lifecycle hook tests (RED slice).
 *
 * These tests pin the wished exports of `index.server.ts`:
 *
 * - the existing `isCuratorAgent(metadata)` (already shipped in Task 1);
 * - `registerCuratorHook(server, runtimeFactory)`: registers the production
 *   `agent.turn.after` hook against a real typed `PluginServerContext`, with
 *   the runtime constructed lazily through an injectable factory (so tests
 *   script start/handle/shutdown/close behavior without any real daemon or
 *   home-directory I/O);
 * - the runtime contract: `start()`, `handleCompletedTurn(agent, turnId)`,
 *   `shutdown()`, `close()`.
 *
 * The hook may initialize/start the runtime on any lifecycle event because
 * the hook context is the first available Paseo API; it must only call
 * `handleCompletedTurn` for eligible source turns.
 *
 * All Paseo-facing types come from the real `@getpaseo/plugin/server` and
 * `@getpaseo/client` declarations — the fakes are structural implementations
 * of those types, not parallel type hierarchies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import * as serverModule from "../index.server";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginHookPayload,
  PluginServerContext,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { SourceAgent } from "../server/paseo-adapter";

// ---------------------------------------------------------------------------
// The wished exports
// ---------------------------------------------------------------------------

/**
 * The runtime surface the hook owns: lazy construction through
 * `runtimeFactory`, at most one start, idempotent shutdown/close.
 */
interface CuratorRuntime {
  start(): Promise<void>;
  handleCompletedTurn(agent: SourceAgent, turnId: string): Promise<unknown>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The runtime factory the hook accepts: constructed with the Paseo API from
 * the first lifecycle event. Injectable so tests can script the runtime.
 */
type CuratorRuntimeFactory = (paseo: PaseoApi) => CuratorRuntime;

/**
 * The wished registration API of `index.server.ts`. Currently absent (RED):
 * the plugin entry only exposes a scaffold `contribute` default export and
 * the existing `isCuratorAgent`.
 */
type RegisterCuratorHook = (
  server: PluginServerContext,
  runtimeFactory: CuratorRuntimeFactory,
) => () => Promise<void>;

/** Access the wished named export; `undefined` until Task 5 implements it. */
function getRegisterCuratorHook(): RegisterCuratorHook | undefined {
  const mod = serverModule as unknown as {
    registerCuratorHook?: RegisterCuratorHook;
  };
  return mod.registerCuratorHook;
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function makeAgent(
  over: Partial<PluginHookAgent> = {},
): PluginHookAgent {
  return {
    id: "agent-1",
    workspaceId: "ws-1",
    parentAgentId: null,
    provider: "provider/example-model",
    cwd: "/workspace/app",
    title: "source",
    background: false,
    metadata: {},
    ...over,
  };
}

function completed(): PluginTurnOutcome {
  return { kind: "completed" };
}

function failed(): PluginTurnOutcome {
  return { kind: "failed", error: { message: "boom" } };
}

function canceled(): PluginTurnOutcome {
  return { kind: "canceled", reason: "user" };
}

function turnPayload(
  agent: PluginHookAgent,
  turnId: string | null,
  outcome: PluginTurnOutcome,
): PluginHookPayload<"agent.turn.after"> {
  return { agent, turnId, outcome, timeline: [] };
}

// ---------------------------------------------------------------------------
// Fake Paseo API (typed against the real client interface)
// ---------------------------------------------------------------------------

/**
 * Minimal structural fake of the real `PaseoApi`. The hook only needs it as
 * an opaque Paseo API reference (it is handed to `runtimeFactory`); the
 * adapter surface is typed against `src/paseo-adapter` in the orchestrator.
 */
function makeFakePaseoApi(): PaseoApi {
  const ref = (id: string) => ({
    id,
    timeline: {
      refetch: async (
        options?: {
          direction: "tail" | "before";
          cursor?: { epoch: string; seq: number };
        },
      ) => ({
        agentId: id,
        agent: null,
        entries: [],
        startCursor: null,
        hasOlder: false,
        error: null,
      }),
    },
  });
  const api = {
    dispose: async () => {},
    agents: {
      ref,
      create: async () => ({
        agentId: "created",
        waitForFinish: async () => ({
          state: "completed" as const,
          lastMessage: null,
        }),
      }),
    },
  };
  return api as unknown as PaseoApi;
}

// ---------------------------------------------------------------------------
// Fake PluginServerContext (typed against the real SDK interface)
// ---------------------------------------------------------------------------

interface CapturedAddHook {
  name: string;
  handler: (
    payload: PluginHookPayload<"agent.turn.after">,
    context: PluginHookContext,
  ) => Promise<unknown>;
}

interface FakeServer {
  server: PluginServerContext;
  hooks: CapturedAddHook[];
}

/**
 * Typed fake of `PluginServerContext`: records every `addHook` call and
 * returns a real removal closure so the contribution's returned `() => void`
 * can be exercised end to end.
 */
function makeFakeServer(): FakeServer {
  const hooks: CapturedAddHook[] = [];
  const server = {
    addHook: (
      name: string,
      handler: CapturedAddHook["handler"],
    ): (() => void) => {
      const entry: CapturedAddHook = { name, handler };
      hooks.push(entry);
      return () => {
        const i = hooks.lastIndexOf(entry);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
    on: () => () => {},
    before: () => () => {},
    registerSettings: () => ({
      read: async () => ({ status: "ready" as const, revision: "r1", values: {} }),
      subscribe: () => () => {},
    }),
    handle: () => {},
    registerProvider: () => {},
    registerUsageSource: () => {},
  } as unknown as PluginServerContext;
  return { server, hooks };
}

// ---------------------------------------------------------------------------
// Scripted fake runtime
// ---------------------------------------------------------------------------

interface CallRecord {
  kind: "start" | "handle" | "shutdown" | "close";
  agent?: SourceAgent;
  turnId?: string;
}

interface FakeRuntime {
  runtime: CuratorRuntime;
  calls: CallRecord[];
}

/**
 * Build a scripted fake runtime. `start` and `shutdown` return gated
 * promises the caller resolves via `releaseGates` — letting tests observe the
 * exact order of start → handle → shutdown → close without timers.
 */
function makeFakeRuntime(
  options: { gateShutdown?: boolean } = {},
): FakeRuntime & { releaseGates: () => void } {
  const calls: CallRecord[] = [];
  const gates: Array<{ kind: "start" | "shutdown"; resolve: () => void }> = [];

  const runtime: CuratorRuntime = {
    start: () => {
      const rec: CallRecord = { kind: "start" };
      calls.push(rec);
      return new Promise<void>((resolve) => {
        gates.push({ kind: "start", resolve: () => resolve() });
      });
    },
    handleCompletedTurn: async (agent, turnId) => {
      calls.push({ kind: "handle", agent, turnId });
      return { enqueued: true, toolIterations: 0 };
    },
    shutdown: () => {
      const rec: CallRecord = { kind: "shutdown" };
      calls.push(rec);
      if (!options.gateShutdown) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        gates.push({ kind: "shutdown", resolve: () => resolve() });
      });
    },
    close: async () => {
      calls.push({ kind: "close" });
    },
  };

  const releaseGates = () => {
    while (gates.length > 0) gates.shift()!.resolve();
  };

  return { runtime, calls, releaseGates };
}

/** The fake `context.paseo` the hook receives (identical reference). */
const PASEO_API = makeFakePaseoApi();

function makeHookContext(
  signal: AbortSignal = new AbortController().signal,
): PluginHookContext {
  return { paseo: PASEO_API, signal };
}

// ---------------------------------------------------------------------------
// Wished wiring helpers
// ---------------------------------------------------------------------------

type AfterPayload = PluginHookPayload<"agent.turn.after">

/** Invoke the captured `agent.turn.after` hook handler with the given event. */
async function fireAfter(
  fakeServer: FakeServer,
  payload: AfterPayload,
  context: PluginHookContext = makeHookContext(),
): Promise<unknown> {
  const hook = fakeServer.hooks.find((h) => h.name === "agent.turn.after");
  if (!hook) throw new Error("no agent.turn.after hook captured");
  return hook.handler(payload, context);
}

// ---------------------------------------------------------------------------
// Tests: the existing export
// ---------------------------------------------------------------------------

describe("isCuratorAgent (existing export)", () => {
  it("accepts the exact `paseo.curator` key with the boolean true", () => {
    const fn = serverModule.isCuratorAgent;
    expect(typeof fn).toBe("function");
    expect(fn({ "paseo.curator": true })).toBe(true);
  });

  it("returns false for everything else", () => {
    const fn = serverModule.isCuratorAgent;
    expect(fn({})).toBe(false);
    expect(fn({ "paseo.curator": false })).toBe(false);
    expect(fn({ "paseo.curator": 1 })).toBe(false);
    expect(fn({ "paseo.curator": "true" })).toBe(false);
    expect(fn({ curator: true })).toBe(false);
  });
});

it("does not register a permission policy for curator or ordinary source agents", async () => {
  const events: string[] = [];
  const cleanup = serverModule.default({
    registerSettings: () => ({}),
    on: (event: string) => { events.push(event); return () => {}; },
    addHook: () => () => {},
  } as unknown as PluginServerContext);
  expect(events).not.toContain("agent.permission_requested");
  await cleanup();
});

// ---------------------------------------------------------------------------
// Tests: registerCuratorHook (wished; RED until Task 5 implements it)
// ---------------------------------------------------------------------------

describe("registerCuratorHook", () => {
  /** Register through the wished export; throws a clear RED error if missing. */
  function registerWith(
    factory: CuratorRuntimeFactory,
  ): { fakeServer: FakeServer; cleanup: () => Promise<void> } {
    const fakeServer = makeFakeServer();
    const fn = getRegisterCuratorHook();
    if (typeof fn !== "function") {
      throw new Error(
        "MISSING WISHED EXPORT: index.server.ts must export `registerCuratorHook(server, runtimeFactory)`",
      );
    }
    const cleanup = fn(fakeServer.server, factory);
    if (typeof cleanup !== "function") {
      throw new Error("registerCuratorHook must return a cleanup function");
    }
    return { fakeServer, cleanup: () => cleanup() };
  }

  // 1. exactly one agent.turn.after hook registered
  it("registers exactly one `agent.turn.after` hook", () => {
    const fake = makeFakeRuntime();
    const { fakeServer } = registerWith(() => fake.runtime);
    const turnAfter = fakeServer.hooks.filter((h) => h.name === "agent.turn.after");
    expect(turnAfter).toHaveLength(1);
    expect(fakeServer.hooks).toHaveLength(1);
    expect(fakeServer.hooks[0]!.name).toBe("agent.turn.after");
  });

  // 2. lazy creation + start-once; later events reuse
  it("lazily creates and starts exactly one runtime from `context.paseo`, then reuses it", async () => {
    const factoryCalls: { paseo: PaseoApi }[] = [];
    const fake = makeFakeRuntime();
    const { fakeServer, cleanup } = registerWith((paseo) => {
      factoryCalls.push({ paseo });
      return fake.runtime;
    });
    try {
      // No lifecycle event yet — no runtime created.
      expect(factoryCalls).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);

      // First eligible event: lazily create from `context.paseo` and start.
      const ctx = makeHookContext();
      await fireAfter(
        fakeServer,
        turnPayload(makeAgent({ id: "agent-1" }), "turn-1", completed()),
        ctx,
      );
      expect(factoryCalls).toHaveLength(1);
      expect(factoryCalls[0]!.paseo).toBe(ctx.paseo);
      expect(fake.calls.filter((c) => c.kind === "start")).toHaveLength(1);
      // Release the gated start so the handler completes.
      fake.releaseGates();

      // Second event reuses the same runtime: no second construction, no second start.
      await fireAfter(
        fakeServer,
        turnPayload(makeAgent({ id: "agent-2" }), "turn-2", completed()),
        makeHookContext(),
      );
      expect(factoryCalls).toHaveLength(1);
      expect(fake.calls.filter((c) => c.kind === "start")).toHaveLength(1);

      // Cleanup: shutdown, then close, exactly once each. Handling calls are
      // asserted above and are irrelevant to resource-cleanup ordering.
      await cleanup();
      expect(
        fake.calls
          .map((c) => c.kind)
          .filter((kind) => kind !== "handle"),
      ).toEqual(["start", "shutdown", "close"]);
    } finally {
      fake.releaseGates();
    }
  });

  // 3. completed + non-null turnId → handleCompletedTurn with exact id/provider/cwd
  it("calls `handleCompletedTurn(agent, turnId)` only for completed events with a non-null turnId", async () => {
    const fake = makeFakeRuntime();
    const { fakeServer, cleanup } = registerWith(() => fake.runtime);
    try {
      const agent = makeAgent({
        id: "agent-7",
        provider: "provider/example-model",
        cwd: "/workspace/app",
      });

      // Eligible.
      await fireAfter(fakeServer, turnPayload(agent, "turn-9", completed()));
      fake.releaseGates();
      const handled = fake.calls.filter((c) => c.kind === "handle");
      expect(handled).toHaveLength(1);
      expect(handled[0]!.turnId).toBe("turn-9");
      expect(handled[0]!.agent!.id).toBe("agent-7");
      expect(handled[0]!.agent!.provider).toBe("provider/example-model");
      expect(handled[0]!.agent!.cwd).toBe("/workspace/app");

      // Failed outcome: never handled.
      await fireAfter(fakeServer, turnPayload(agent, "turn-10", failed()));
      fake.releaseGates();

      // Canceled outcome: never handled.
      await fireAfter(fakeServer, turnPayload(agent, "turn-11", canceled()));
      fake.releaseGates();

      // Completed with null turnId: never handled.
      await fireAfter(fakeServer, turnPayload(agent, null, completed()));
      fake.releaseGates();

      expect(fake.calls.filter((c) => c.kind === "handle")).toHaveLength(1);
    } finally {
      fake.releaseGates();
      await cleanup();
    }
  });

  // 4. failed/canceled/null-turn events never accumulate
  it("never accumulates for failed, canceled, or null-turn events", async () => {
    const fake = makeFakeRuntime();
    const { fakeServer, cleanup } = registerWith(() => fake.runtime);
    try {
      const agent = makeAgent({ id: "agent-8" });
      const events: Array<[string | null, PluginTurnOutcome]> = [
        ["turn-1", failed()],
        ["turn-2", canceled()],
        [null, failed()],
        [null, completed()],
        ["turn-3", completed()], // only this one is eligible
      ];
      for (const [turnId, outcome] of events) {
        await fireAfter(fakeServer, turnPayload(agent, turnId, outcome));
        fake.releaseGates();
      }
      const handled = fake.calls.filter((c) => c.kind === "handle");
      expect(handled).toHaveLength(1);
      expect(handled[0]!.turnId).toBe("turn-3");
    } finally {
      fake.releaseGates();
      await cleanup();
    }
  });

  // 5. metadata `paseo.curator: true` excludes; non-boolean lookalikes do not
  it("excludes agents with `paseo.curator` strictly boolean true; lookalikes are not excluded", async () => {
    const fake = makeFakeRuntime();
    const { fakeServer, cleanup } = registerWith(() => fake.runtime);
    try {
      const excluded = makeAgent({ id: "agent-9", metadata: { "paseo.curator": true } });
      const lookalike = makeAgent({ id: "agent-10", metadata: { "paseo.curator": "true" } });
      const otherKey = makeAgent({ id: "agent-11", metadata: { curator: true } });

      // Excluded: never handled.
      await fireAfter(fakeServer, turnPayload(excluded, "turn-ex", completed()));
      fake.releaseGates();

      // Lookalike: handled.
      await fireAfter(fakeServer, turnPayload(lookalike, "turn-look", completed()));
      fake.releaseGates();

      // Different key: handled.
      await fireAfter(fakeServer, turnPayload(otherKey, "turn-other", completed()));
      fake.releaseGates();

      const handled = fake.calls
        .filter((c) => c.kind === "handle")
        .map((c) => c.turnId!)
        .sort();
      expect(handled).toEqual(["turn-look", "turn-other"]);
      expect(handled).not.toContain("turn-ex");
    } finally {
      fake.releaseGates();
      await cleanup();
    }
  });

  // 6. concurrent first eligible events → one construction + one start
  it("creates and starts exactly one runtime when multiple first eligible events arrive concurrently", async () => {
    const factoryCalls: number[] = [];
    const fake = makeFakeRuntime();
    const { fakeServer, cleanup } = registerWith(() => {
      factoryCalls.push(1);
      return fake.runtime;
    });
    try {
      const agents = ["a", "b", "c"].map((s) => makeAgent({ id: `agent-${s}` }));
      // Fire three eligible events concurrently (no awaits between).
      const promises = agents.map((agent, i) =>
        fireAfter(fakeServer, turnPayload(agent, `turn-${i}`, completed())),
      );
      await Promise.all(promises);
      expect(factoryCalls).toHaveLength(1);
      expect(fake.calls.filter((c) => c.kind === "start")).toHaveLength(1);
    } finally {
      fake.releaseGates();
      await cleanup();
    }
  });

  // 7. hook errors from start/handle are contained (no reject; no transcript/model text leaks)
  it("contains errors from `start` and `handleCompletedTurn`: no rejection, no content leak", async () => {
    // A runtime whose `start` rejects with transcript-like text, and whose
    // `handleCompletedTurn` rejects with model-like text. The hook must
    // contain both: the daemon never sees the rejection, and no content
    // from either error leaks into the hook result or a later log.
    const startReject = new Error("SECRET-TRANSCRIPT-LEAK start failed");
    const handleReject = new Error("SECRET-MODEL-LEAK handle failed");
    const fake = makeFakeRuntime();
    const throwing: CuratorRuntime = {
      start: () => Promise.reject(startReject),
      handleCompletedTurn: async () => {
        throw handleReject;
      },
      shutdown: async () => {},
      close: async () => {},
    };
    const { fakeServer, cleanup } = registerWith(() => throwing);
    try {
      // The hook must not propagate the start rejection to the daemon.
      const first = await fireAfter(
        fakeServer,
        turnPayload(makeAgent({ id: "agent-leak" }), "turn-leak", completed()),
      );
      expect(first).toBeNull();
      const rendered = JSON.stringify(first ?? null);
      expect(rendered).not.toContain("SECRET-TRANSCRIPT-LEAK");
      expect(rendered).not.toContain("SECRET-MODEL-LEAK");
    } finally {
      fake.releaseGates();
      await cleanup();
    }
  });

  // 8. async cleanup: remove hook once, await active shutdown, close resources once, idempotent
  it("cleanup removes the hook once, awaits active shutdown, then closes resources once; cleanup is idempotent", async () => {
    const fake = makeFakeRuntime({ gateShutdown: true });
    const { fakeServer, cleanup } = registerWith(() => fake.runtime);
    try {
      // Drive a start to make it "active".
      await fireAfter(
        fakeServer,
        turnPayload(makeAgent({ id: "agent-clean" }), "turn-clean", completed()),
      );
      expect(fake.calls.filter((c) => c.kind === "start")).toHaveLength(1);
      // Do NOT release the start gate yet — cleanup must await it.

      const beforeHookCount = fakeServer.hooks.length;
      const cleanupP = cleanup();
      expect(cleanupP).toBeInstanceOf(Promise);

      // Hook must be removed (synchronously or in the next microtask).
      await Promise.resolve();
      const afterHookCount = fakeServer.hooks.length;
      expect(beforeHookCount - afterHookCount).toBe(1);

      // While the gate is unresolved, the cleanup must not have closed yet.
      await Promise.resolve();
      expect(fake.calls.some((c) => c.kind === "close")).toBe(false);

      // Release the gate; cleanup should complete with shutdown → close.
      fake.releaseGates();
      await cleanupP;

      // Idempotent: a second call is a no-op (no extra shutdown/close, no extra removal).
      await cleanup();
      expect(fake.calls.filter((c) => c.kind === "shutdown")).toHaveLength(1);
      expect(fake.calls.filter((c) => c.kind === "close")).toHaveLength(1);
      expect(fakeServer.hooks.length).toBe(afterHookCount);
    } finally {
      fake.releaseGates();
    }
  });

  it("cleanup waits for an in-flight hook handler before closing runtime resources", async () => {
    let releaseHandle!: () => void;
    const handleGate = new Promise<void>((resolve) => {
      releaseHandle = resolve;
    });
    const calls: string[] = [];
    const runtime: CuratorRuntime = {
      start: async () => {},
      handleCompletedTurn: async () => {
        calls.push("handle-start");
        await handleGate;
        calls.push("handle-end");
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
      close: async () => {
        calls.push("close");
      },
    };
    const { fakeServer, cleanup } = registerWith(() => runtime);
    const handling = fireAfter(
      fakeServer,
      turnPayload(makeAgent({ id: "agent-in-flight" }), "turn-in-flight", completed()),
    );
    await Promise.resolve();

    const cleaning = cleanup();
    await Promise.resolve();
    expect(calls).toContain("shutdown");
    expect(calls).not.toContain("close");

    releaseHandle();
    await Promise.all([handling, cleaning]);
    expect(calls).toEqual(["handle-start", "shutdown", "handle-end", "close"]);
  });

  // 9. default export contribution is wired through registerCuratorHook
  it("the default `contribute` export is wired through `registerCuratorHook` (no real home paths touched)", () => {
    const fn = getRegisterCuratorHook();
    if (typeof fn !== "function") {
      throw new Error(
        "MISSING WISHED EXPORT: index.server.ts must export `registerCuratorHook` for the default contribution to wire through it",
      );
    }
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.server.ts"),
      "utf8",
    );
    // The source must contain the registration entry point AND the default
    // `contribute` must reference it. We assert on the source, not on a
    // home path, so this holds regardless of where the plugin is installed.
    expect(source).toMatch(/registerCuratorHook/);
    expect(source).toMatch(/export\s+default\s+function\s+contribute\b|export\s+default\s+contribute\b/);
    // The default must be a function (it is in the current scaffold).
    expect(typeof (serverModule as { default?: unknown }).default).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: 5C hardening (RED slice)
// ---------------------------------------------------------------------------
//
// These pin three concrete gaps in the current `index.server.ts` and must be
// RED until Task 5C fixes the production code:
//
//  1. A `runtimeFactory` or `runtime.start()` that throws *synchronously*
//     must be contained: `agent.turn.after` resolves `null` and no
//     secret-bearing error text is returned. (Current: a synchronous factory
//     throw escapes the hook; a synchronous `start()` throw escapes the
//     hook's `catch(() => {})` and becomes an unhandled rejection.)
//
//  2. Two `cleanup()` calls made concurrently must share one cleanup
//     lifecycle: neither may resolve before the gated start+shutdown settle,
//     `close()` happens exactly once, and both resolve after the gates.
//     (Current: the second call returns early because the synchronous
//     `cleanupStarted` flag is set before the lifecycle is awaited.)
//
//  3. `readSkillSummaries(skillRoot)` must read the actual YAML
//     `description:` field (including quoted values), use the directory
//     name as `skillName`, sort deterministically, and skip dot directories,
//     symlinked skill dirs, and malformed/unreadable entries — never
//     throwing. (Current: it uses the frontmatter `name` as the
//     description.)

interface SkillSummary {
  skillName: string;
  description: string;
  sha256?: string;
}

/** Access the wished named export; `undefined` until Task 5C implements it. */
function getReadSkillSummaries(): ((skillRoot: string) => Promise<SkillSummary[]>) | undefined {
  const mod = serverModule as unknown as {
    readSkillSummaries?: (skillRoot: string) => Promise<SkillSummary[]>;
  };
  return mod.readSkillSummaries;
}

describe("registerCuratorHook (5C hardening)", () => {
  /** Register through the wished export; throws a clear RED error if missing. */
  function registerWith(
    factory: CuratorRuntimeFactory,
  ): { fakeServer: FakeServer; cleanup: () => Promise<void> } {
    const fakeServer = makeFakeServer();
    const fn = getRegisterCuratorHook();
    if (typeof fn !== "function") {
      throw new Error(
        "MISSING WISHED EXPORT: index.server.ts must export `registerCuratorHook(server, runtimeFactory)`",
      );
    }
    const cleanup = fn(fakeServer.server, factory);
    if (typeof cleanup !== "function") {
      throw new Error("registerCuratorHook must return a cleanup function");
    }
    return { fakeServer, cleanup: () => cleanup() };
  }

  it("contains a `runtimeFactory` that throws synchronously: `agent.turn.after` resolves null, no secret text returned", async () => {
    const factory: CuratorRuntimeFactory = () => {
      throw new Error("SECRET-FACTORY-LEAK factory failed");
    };
    const { fakeServer, cleanup } = registerWith(factory);
    try {
      const result = await fireAfter(
        fakeServer,
        turnPayload(makeAgent({ id: "agent-throwing-factory" }), "turn-t1", completed()),
      );
      expect(result).toBeNull();
      const rendered = JSON.stringify(result ?? null);
      expect(rendered).not.toContain("SECRET-FACTORY-LEAK");
    } finally {
      await cleanup();
    }
  });

  it("contains a `runtime.start()` that throws synchronously: `agent.turn.after` resolves null, no secret text returned", async () => {
    const calls: CallRecord[] = [];
    const throwing: CuratorRuntime = {
      start: () => {
        calls.push({ kind: "start" });
        throw new Error("SECRET-START-LEAK start failed");
      },
      handleCompletedTurn: async () => {
        calls.push({ kind: "handle" });
        return {};
      },
      shutdown: async () => {
        calls.push({ kind: "shutdown" });
      },
      close: async () => {
        calls.push({ kind: "close" });
      },
    };
    const { fakeServer, cleanup } = registerWith(() => throwing);
    try {
      const result = await fireAfter(
        fakeServer,
        turnPayload(makeAgent({ id: "agent-throwing-start" }), "turn-t2", completed()),
      );
      expect(result).toBeNull();
      const rendered = JSON.stringify(result ?? null);
      expect(rendered).not.toContain("SECRET-START-LEAK");
      expect(calls.some((c) => c.kind === "start")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("concurrent `cleanup()` calls share one lifecycle: gated until start+shutdown settle, close once, both resolve after", async () => {
    const calls: CallRecord[] = [];
    const gates: Array<{ kind: "start" | "shutdown"; resolve: () => void }> = [];
    const runtime: CuratorRuntime = {
      start: () => {
        calls.push({ kind: "start" });
        return new Promise<void>((resolve) => {
          gates.push({ kind: "start", resolve });
        });
      },
      handleCompletedTurn: async () => {},
      shutdown: () => {
        calls.push({ kind: "shutdown" });
        return new Promise<void>((resolve) => {
          gates.push({ kind: "shutdown", resolve });
        });
      },
      close: async () => {
        calls.push({ kind: "close" });
      },
    };
    const { fakeServer, cleanup } = registerWith(() => runtime);
    // Drive a lifecycle event so the runtime is constructed and start()
    // is in flight (its gate stays unresolved until release below).
    await fireAfter(
      fakeServer,
      turnPayload(makeAgent({ id: "agent-conc-cleanup" }), "turn-c1", completed()),
    );
    expect(calls.filter((c) => c.kind === "start")).toHaveLength(1);

    const beforeHookCount = fakeServer.hooks.length;
    // Two cleanup calls made concurrently.
    const p1 = cleanup();
    const p2 = cleanup();
    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);

    // Shutdown was invoked by the cleanup.
    expect(calls.some((c) => c.kind === "shutdown")).toBe(true);
    // The hook is removed.
    await Promise.resolve();
    expect(fakeServer.hooks.length).toBe(beforeHookCount - 1);

    // Neither cleanup may resolve while the start/shutdown gates are held.
    let settled = 0;
    const onSettled = () => settled++;
    void p1.then(onSettled);
    void p2.then(onSettled);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(0);
    // And `close` must not have run yet.
    expect(calls.some((c) => c.kind === "close")).toBe(false);

    // Release the gates; both cleanups must now resolve.
    while (gates.length > 0) gates.shift()!.resolve();
    await Promise.all([p1, p2]);

    // `close()` exactly once; both calls observed the full lifecycle.
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(1);
    expect(settled).toBe(2);
    // No second shutdown/close from the second call.
    expect(calls.filter((c) => c.kind === "shutdown")).toHaveLength(1);
  });
});

describe("readSkillSummaries (5C hardening)", () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `curator-5c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fn(): (skillRoot: string) => Promise<SkillSummary[]> {
    const f = getReadSkillSummaries();
    if (typeof f !== "function") {
      throw new Error(
        "MISSING WISHED EXPORT: index.server.ts must export `readSkillSummaries(skillRoot)`",
      );
    }
    return f;
  }

  function writeSkill(name: string, content: string): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  }

  it("reads the YAML `description:` (quoted and unquoted), uses the directory name as skillName, and sorts deterministically", async () => {
    writeSkill(
      "zeta",
      `---\nname: zeta\ndescription: "Zeta, in quotes"\n---\n\nZeta body\n`,
    );
    writeSkill(
      "alpha",
      `---\nname: totally-different-name\ndescription: Alpha plain description\n---\n\nAlpha body\n`,
    );
    // Out-of-order creation: results must be sorted by skillName, independent
    // of filesystem enumeration order.
    writeSkill(
      "mid",
      `---\nname: mid\ndescription: mid description\n---\n\nMid body\n`,
    );

    const summaries = await fn()(root);
    expect(summaries).toEqual([
      expect.objectContaining({ skillName: "alpha", description: "Alpha plain description", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ skillName: "mid", description: "mid description", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ skillName: "zeta", description: "Zeta, in quotes", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
  });

  it("skips dot dirs, symlinked skill dirs, non-directories, and malformed/unreadable SKILL.md entries; never throws", async () => {
    writeSkill(
      "good",
      `---\nname: good\ndescription: good skill\n---\n\nGood body\n`,
    );

    // Dot directory: skipped.
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, ".hidden", "SKILL.md"), "no frontmatter\n", "utf8");

    // Symlinked skill directory (points to a real dir inside root, valid
    // frontmatter): skipped.
    mkdirSync(join(root, "realtarget"), { recursive: true });
    writeFileSync(
      join(root, "realtarget", "SKILL.md"),
      `---\nname: realtarget\ndescription: target skill\n---\n\nTarget\n`,
      "utf8",
    );
    symlinkSync(join(root, "realtarget"), join(root, "linked"), "dir");

    // Plain file entry: skipped.
    writeFileSync(join(root, "stray-file"), "not a skill\n", "utf8");

    // Directory without a SKILL.md: skipped.
    mkdirSync(join(root, "no-md"), { recursive: true });

    // Unreadable SKILL.md: skipped without throwing. (Best effort: as root or
    // under a permission model that ignores mode bits the file stays
    // readable; the entry is skipped by whichever branch handles it.)
    const unreadableDir = join(root, "unreadable");
    mkdirSync(unreadableDir, { recursive: true });
    try {
      writeFileSync(join(unreadableDir, "SKILL.md"), "no frontmatter here\n", "utf8");
      chmodSync(join(unreadableDir, "SKILL.md"), 0o000);
    } catch {
      // ignore: entry remains readable and is skipped by its content instead
    }

    // Malformed SKILL.md (no frontmatter block): skipped.
    const malformedDir = join(root, "malformed");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, "SKILL.md"), "no frontmatter here\n", "utf8");

    const summaries = await fn()(root);
    expect(summaries).toEqual([
      expect.objectContaining({ skillName: "good", description: "good skill", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ skillName: "realtarget", description: "target skill", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
  });
});
