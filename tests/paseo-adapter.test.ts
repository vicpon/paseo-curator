import { routingSnapshot, routingModels, routingControls } from "./routing-fixtures";
import { beforeEach, describe, expect, it } from "vitest";

import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";

import { PaseoAdapter } from "../server/paseo-adapter";
import type { TimelineEntry } from "../server/review-prompt";

// ===========================================================================
// Local fake typing (keeps the fakes concise; the real adapter is untyped)
// ===========================================================================

interface FakeRefetchOptions {
  direction?: string;
  cursor?: { epoch: string; seq: number };
  limit?: number;
}

interface FakeRefetchResult {
  agentId: string;
  agent: FakeAgentSnapshot;
  direction: "tail" | "before" | "after";
  projection: "projected" | "canonical";
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  startCursor: { epoch: string; seq: number } | null;
  endCursor: { epoch: string; seq: number } | null;
  hasOlder: boolean;
  hasNewer: boolean;
  entries: FakeTimelineEntry[];
  error: string | null;
}

interface FakeAgentSnapshot {
  id: string;
  provider: string;
  model?: string | null;
  cwd: string;
  status: "idle" | "running" | "closed";
  createdAt: string;
  updatedAt: string;
}

interface FakeCreateOptions {
  agentId: string;
  config: { provider: string; modeId?: string; options?: Record<string, unknown>; toolPolicy?: { preapproved: [] } };
  cwd: string;
  parent: string;
  prompt: string;
  background: boolean;
  idempotencyKey: string;
  title: string;
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
}

interface FakeAgentHandle {
  id: string;
  waitForFinish(timeoutMs?: number): Promise<FakeWaitForFinishResult>;
}

interface FakeWaitForFinishResult {
  status: "idle" | "error" | "permission" | "timeout";
  final: unknown | null;
  error: string | null;
  lastMessage: string | null;
}

/** Minimal PaseoApi surface the adapter is allowed to touch. */
type FakePaseoApiProviders = import("../shared/routing").RoutingProviders;

interface FakePaseoApi {
  agents: {
    ref(id: string): {
      timeline: {
        refetch(options?: FakeRefetchOptions): Promise<FakeRefetchResult>;
      };
    };
    create(options: FakeCreateOptions): Promise<FakeAgentHandle>;
  };
  providers?: FakePaseoApiProviders;
}

interface FakeTimelineEntry {
  provider: string;
  item: AgentTimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: Array<{ startSeq: number; endSeq: number }>;
  collapsed: string[];
}

// ===========================================================================
// Hand-derived expected values
// ===========================================================================

const AGENT_ID = "agent-001";
const AGENT_PROVIDER = "codex/example-model";
const AGENT_CWD = "/workspace/app";

/**
 * Hand-derived tool-call rendering. The adapter maps a tool_call timeline item
 * to `TimelineEntry { role: "tool", content }` where content is the protocol
 * tool-call display model formatted as
 * "<displayName>: <summary>" plus " — <errorText>" when the call failed.
 * These strings are derived from `buildToolCallDisplayModel` below, computed
 * independently of the adapter.
 */
const toolContent = (
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): string => {
  const model = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    metadata: item.metadata,
    detail: item.detail,
    agentMessage: item.agentMessage,
    cwd: AGENT_CWD,
  });
  const base = model.summary ? `${model.displayName}: ${model.summary}` : model.displayName;
  return model.errorText ? `${base} — ${model.errorText}` : base;
};

const userItem = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const assistantItem = (text: string): AgentTimelineItem => ({
  type: "assistant_message",
  text,
});
const reasoningItem = (text: string): AgentTimelineItem => ({ type: "reasoning", text });
const errorItem = (message: string): AgentTimelineItem => ({ type: "error", message });
const notificationItem = (
  level: "info" | "warning" | "error",
  message: string,
): AgentTimelineItem => ({ type: "notification", level, message });

let seqCounter = 0;
beforeEach(() => {
  seqCounter = 0;
});

const entry = (
  item: AgentTimelineItem,
  turnId?: string,
): FakeTimelineEntry => {
  seqCounter += 1;
  return {
    provider: AGENT_PROVIDER,
    item,
    turnId,
    timestamp: `2026-11-15T00:00:0${seqCounter}.000Z`,
    seqStart: seqCounter,
    seqEnd: seqCounter,
    sourceSeqRanges: [{ startSeq: seqCounter, endSeq: seqCounter }],
    collapsed: [],
  };
};

const snapshot = (
  provider = AGENT_PROVIDER,
  cwd = AGENT_CWD,
  model: string | null = null,
): FakeAgentSnapshot => ({
  id: AGENT_ID,
  provider,
  model,
  cwd,
  status: "idle",
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
});

/**
 * Minimal fake PaseoApi. Each refetch call receives the next scripted page in
 * order; every call is recorded in `calls`.
 */
function makeFakePaseo(pages: FakeRefetchResult[]): {
  paseo: FakePaseoApi;
  calls: FakeRefetchOptions[];
} {
  const calls: FakeRefetchOptions[] = [];
  let next = 0;
  const paseo: FakePaseoApi = {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async (options?: FakeRefetchOptions) => {
            expect(id).toBe(AGENT_ID);
            calls.push(options ?? {});
            const page = pages[next];
            next += 1;
            if (!page) {
              throw new Error(`unexpected extra refetch #${calls.length}`);
            }
            return page;
          },
        },
      }),
      // The read tests never create agents; satisfy the widened interface with a no-op.
      create: async (options: FakeCreateOptions) => {
        throw new Error(
          `readWholeTurn must not call agents.create (got ${JSON.stringify(options)}),`,
        );
      },
    },
  };
  return { paseo, calls };
}

const refetchResult = (
  entries: FakeTimelineEntry[],
  overrides: Partial<FakeRefetchResult> = {},
): FakeRefetchResult => {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  return {
    agentId: AGENT_ID,
    agent: snapshot(),
    direction: "tail",
    projection: "projected",
    epoch: "epoch-1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: first.seqStart, maxSeq: last.seqEnd, nextSeq: last.seqEnd + 1 },
    startCursor: { epoch: "epoch-1", seq: first.seqStart },
    endCursor: { epoch: "epoch-1", seq: last.seqEnd },
    hasOlder: false,
    hasNewer: false,
    entries,
    error: null,
    ...overrides,
  };
};

// ===========================================================================
// 1. Single-page read: filtering, identity preservation, deterministic mapping
// ===========================================================================

describe("readWholeTurn single page", () => {
  it("filters to the exact turnId and maps every item kind deterministically", async () => {
    const target = "turn-002";
    const { paseo } = makeFakePaseo([
      refetchResult([
        // Adjacent turn: must never appear in the result.
        entry(userItem("ADJACENT turn one request"), "turn-001"),
        // Requested turn, in chronological order.
        entry(userItem("Fix the flaky test in src/foo.test.ts"), target),
        entry(assistantItem("I will investigate the failure."), target),
        entry(reasoningItem("The fixture is stale; that is likely the cause."), target),
        entry(
          {
            type: "tool_call",
            callId: "call-a",
            name: "run_tests",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "npm test", cwd: AGENT_CWD, output: "PASS 3/3" },
          },
          target,
        ),
        entry(errorItem("boom: exit 2"), target),
        entry(notificationItem("warning", "Watch out: untracked files remain."), target),
        // Noise kinds that carry no review content must be dropped.
        entry({ type: "todo", items: [{ text: "write tests", completed: true }] }, target),
        entry(
          {
            type: "compaction",
            status: "completed",
            trigger: "auto",
            preTokens: 100,
          },
          target,
        ),
      ]),
    ]);

    const adapter = new PaseoAdapter(paseo);
    const result = await adapter.readWholeTurn(snapshot(), target);

    expect(result.sourceAgentId).toBe(AGENT_ID);
    expect(result.turnId).toBe(target);
    expect(result.provider).toBe(AGENT_PROVIDER);
    expect(result.cwd).toBe(AGENT_CWD);
    expect(result.entries).toEqual([
      { role: "user", content: "Fix the flaky test in src/foo.test.ts" },
      { role: "assistant", content: "I will investigate the failure." },
      { role: "assistant", content: "Reasoning: The fixture is stale; that is likely the cause." },
      {
        role: "tool",
        content: toolContent({
          type: "tool_call",
          callId: "call-a",
          name: "run_tests",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "npm test", cwd: AGENT_CWD, output: "PASS 3/3" },
        }),
      },
      { role: "system", content: "Error: boom: exit 2" },
      { role: "system", content: "Notification(warning): Watch out: untracked files remain." },
    ] as TimelineEntry[]);
    expect(result.toolIterations).toBe(1);
  });
});

// ===========================================================================
// 1b. Source metadata from the timeline payload
// ===========================================================================

describe("readWholeTurn source metadata", () => {
  it("returns provider/cwd from the timeline payload's agent snapshot when the caller passes a placeholder", async () => {
    const target = "turn-007";
    // The durable queue row stores only source id + turnId, so the caller
    // passes empty provider/cwd placeholders. The provider and cwd must come
    // from the daemon payload's agent snapshot — never the placeholder.
    const { paseo } = makeFakePaseo([
      refetchResult(
        [entry(userItem("placeholder read"), target)],
        { agent: snapshot("payload-provider", "/payload/actual-cwd") },
      ),
    ]);

    const adapter = new PaseoAdapter(paseo);
    const result = await adapter.readWholeTurn(
      { id: AGENT_ID, provider: "", cwd: "" },
      target,
    );

    expect(result.sourceAgentId).toBe(AGENT_ID);
    expect(result.turnId).toBe(target);
    expect(result.provider).toBe("payload-provider");
    expect(result.cwd).toBe("/payload/actual-cwd");
    // The tool-call mapping must also use the payload's cwd, not the empty placeholder.
    const { paseo: paseo2 } = makeFakePaseo([
      refetchResult(
        [
          entry(
            {
              type: "tool_call",
              callId: "call-p",
              name: "run_tests",
              status: "completed",
              error: null,
              detail: { type: "shell", command: "npm test", cwd: "/payload/actual-cwd", output: "ok" },
            },
            target,
          ),
        ],
        { agent: snapshot("payload-provider", "/payload/actual-cwd") },
      ),
    ]);
    const adapter2 = new PaseoAdapter(paseo2);
    const result2 = await adapter2.readWholeTurn(
      { id: AGENT_ID, provider: "", cwd: "" },
      target,
    );
    expect(result2.entries[0]).toEqual({
      role: "tool",
      content: toolContent({
        type: "tool_call",
        callId: "call-p",
        name: "run_tests",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", cwd: "/payload/actual-cwd", output: "ok" },
      }),
    });
  });

  it("detects explicit slash-skill and SKILL.md reads as actual use", async () => {
    const target = "turn-skills";
    const { paseo } = makeFakePaseo([refetchResult([
      entry(userItem("/tdd run this"), target),
      entry({
        type: "tool_call",
        callId: "call-skill",
        name: "read_file",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/home/user/.agents/skills/code-review/SKILL.md" },
      }, target),
    ])]);

    const result = await new PaseoAdapter(paseo).readWholeTurn(snapshot(), target);

    expect(result.usedSkillNames).toEqual(["code-review", "tdd"]);
  });
});

// ===========================================================================
// 2. Pagination
// ===========================================================================

describe("readWholeTurn pagination", () => {
  it("paginates backward, keeps chronological order, stops after the first older page, and never includes adjacent turns", async () => {
    const target = "turn-002";
    const { paseo, calls } = makeFakePaseo([
      // Newest page: only the tail of the target turn plus the whole next turn.
      refetchResult(
        [
          entry(assistantItem("A-3 tail"), target),
          entry(userItem("B-1"), "turn-003"),
          entry(assistantItem("B-2"), "turn-003"),
        ],
        { hasOlder: true, hasNewer: true, direction: "tail" },
      ),
      // Older page: completes the target turn.
      refetchResult(
        [
          entry(assistantItem("C-9 oldest neighbor"), "turn-001"),
          entry(userItem("A-1 request"), target),
          entry(assistantItem("A-2 middle"), target),
        ],
        { hasOlder: true, direction: "before" },
      ),
      // Older still: no requested turn → adapter must stop here.
      refetchResult(
        [
          entry(assistantItem("DEEP old entry"), "turn-000"),
        ],
        { hasOlder: true, direction: "before" },
      ),
    ]);

    const adapter = new PaseoAdapter(paseo);
    const result = await adapter.readWholeTurn(snapshot(), target);

    // Chronological order across the page boundary, adjacent turns excluded.
    expect(result.entries.map((e) => e.content)).toEqual([
      "A-1 request",
      "A-2 middle",
      "A-3 tail",
    ]);

    // Backward pagination: first page is the tail, then "before" the oldest
    // cursor seen so far; no fourth fetch after the turn is complete.
    expect(calls).toEqual([
      { direction: "tail" },
      { direction: "before", cursor: { epoch: "epoch-1", seq: 1 } },
    ]);
  });

  it("continues past a newer-turn neighbor on an older page until the target's older boundary", async () => {
    const target = "turn-002";
    const firstTool: Extract<AgentTimelineItem, { type: "tool_call" }> = {
      type: "tool_call",
      callId: "call-first",
      name: "read_file",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: `${AGENT_CWD}/first.ts` },
    };
    const secondTool: Extract<AgentTimelineItem, { type: "tool_call" }> = {
      ...firstTool,
      callId: "call-second",
      detail: { type: "read", filePath: `${AGENT_CWD}/second.ts` },
    };
    const { paseo, calls } = makeFakePaseo([
      refetchResult(
        [entry(assistantItem("newest turn"), "turn-003")],
        { hasOlder: true, startCursor: { epoch: "epoch-1", seq: 30 } },
      ),
      refetchResult(
        [entry(secondTool, target), entry(userItem("newer neighbor"), "turn-003")],
        { hasOlder: true, startCursor: { epoch: "epoch-1", seq: 20 }, direction: "before" },
      ),
      refetchResult(
        [entry(userItem("target begins"), target), entry(firstTool, target)],
        { hasOlder: true, startCursor: { epoch: "epoch-1", seq: 10 }, direction: "before" },
      ),
      refetchResult(
        [entry(assistantItem("older boundary"), "turn-001")],
        { hasOlder: false, startCursor: null, direction: "before" },
      ),
    ]);

    const result = await new PaseoAdapter(paseo).readWholeTurn(snapshot(), target);

    expect(result.entries.map((item) => item.content)).toEqual([
      "target begins",
      toolContent(firstTool),
      toolContent(secondTool),
    ]);
    expect(result.toolIterations).toBe(2);
    expect(calls).toHaveLength(4);
  });
});

// ===========================================================================
// 3. Tool-iteration counting
// ===========================================================================

describe("readWholeTurn tool iteration count", () => {
  it("counts each unique tool callId once across lifecycle updates", async () => {
    const target = "turn-001";
    const running: Extract<AgentTimelineItem, { type: "tool_call" }> = {
      type: "tool_call",
      callId: "call-x",
      name: "run_tests",
      status: "running",
      error: null,
      detail: { type: "shell", command: "npm test", cwd: AGENT_CWD },
    };
    const completed = { ...running, status: "completed" as const };
    const failed: Extract<AgentTimelineItem, { type: "tool_call" }> = {
      type: "tool_call",
      callId: "call-y",
      name: "run_tests",
      status: "failed",
      error: "boom: exit 2",
      detail: { type: "shell", command: "npm test", cwd: AGENT_CWD },
    };
    const read: Extract<AgentTimelineItem, { type: "tool_call" }> = {
      type: "tool_call",
      callId: "call-z",
      name: "read_file",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: `${AGENT_CWD}/src/foo.ts` },
    };

    const { paseo, calls } = makeFakePaseo([
      refetchResult([
        entry(running, target),
        entry(completed, target),
        entry(read, target),
        entry(failed, target),
        entry(assistantItem("Done."), target),
      ]),
    ]);

    const adapter = new PaseoAdapter(paseo);
    const result = await adapter.readWholeTurn(snapshot(), target);

    // Two lifecycle items for call-x count once; call-y and call-z each count once.
    expect(result.toolIterations).toBe(3);
    expect(result.entries).toEqual([
      { role: "tool", content: toolContent(running) },
      { role: "tool", content: toolContent(completed) },
      { role: "tool", content: toolContent(read) },
      { role: "tool", content: toolContent(failed) },
      { role: "assistant", content: "Done." },
    ] as TimelineEntry[]);
    void calls;
  });
});

// ===========================================================================
// 4. Payload errors
// ===========================================================================

describe("readWholeTurn errors", () => {
  it("rejects on a timeline payload error without leaking transcript content", async () => {
    const target = "turn-004";
    const secret = "SECRET-TRANSCRIPT-CONTENT-DO-NOT-LEAK";
    const { paseo } = makeFakePaseo([
      refetchResult(
        [
          entry(userItem(secret), target),
          entry(assistantItem(secret), target),
        ],
        { error: "boom: daemon epoch mismatch" },
      ),
    ]);

    const adapter = new PaseoAdapter(paseo);
    const error = await adapter.readWholeTurn(snapshot(), target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/boom: daemon epoch mismatch/);
    expect((error as Error).message).not.toContain(secret);
  });

  it.each(["reset", "staleCursor", "gap"] as const)(
    "rejects a timeline page reporting %s without leaking entries",
    async (signal) => {
      const target = "turn-structural";
      const secret = "SECRET-TIMELINE-ENTRY";
      const { paseo } = makeFakePaseo([
        refetchResult([entry(userItem(secret), target)], { [signal]: true }),
      ]);

      const error = await new PaseoAdapter(paseo)
        .readWholeTurn(snapshot(), target)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(signal);
      expect((error as Error).message).not.toContain(secret);
    },
  );

  it("rejects a unique cursor that moves forward instead of backward", async () => {
    const { paseo, calls } = makeFakePaseo([
      refetchResult(
        [entry(userItem("newer"), "turn-newer")],
        { hasOlder: true, startCursor: { epoch: "epoch-1", seq: 10 } },
      ),
      refetchResult(
        [entry(userItem("still newer"), "turn-newer")],
        { hasOlder: true, startCursor: { epoch: "epoch-1", seq: 11 }, direction: "before" },
      ),
    ]);

    await expect(
      new PaseoAdapter(paseo).readWholeTurn(snapshot(), "turn-missing"),
    ).rejects.toThrow(/cursor/i);
    expect(calls).toHaveLength(2);
  });

  it("rejects a repeated pagination cursor instead of refetching forever", async () => {
    const repeated = { epoch: "epoch-1", seq: 10 };
    const { paseo, calls } = makeFakePaseo([
      refetchResult(
        [entry(userItem("newer"), "turn-newer")],
        { hasOlder: true, startCursor: repeated },
      ),
      refetchResult(
        [entry(userItem("still newer"), "turn-newer")],
        { hasOlder: true, startCursor: repeated, direction: "before" },
      ),
    ]);

    await expect(
      new PaseoAdapter(paseo).readWholeTurn(snapshot(), "turn-missing"),
    ).rejects.toThrow(/cursor/i);
    expect(calls).toHaveLength(2);
  });
});

describe("discoverRecentCompletedTurns", () => {
  it("discovers unique turns from bounded idle-agent tails and advances a durable cursor", async () => {
    const page = refetchResult([
      entry(userItem("first"), "turn-1"),
      entry(assistantItem("done"), "turn-1"),
      entry(userItem("second"), "turn-2"),
    ]);
    const paseo = {
      agents: {
        list: async () => ({
          entries: [{ agent: {
            id: AGENT_ID, provider: AGENT_PROVIDER, cwd: AGENT_CWD, status: "idle",
            updatedAt: "2040-01-02T00:00:00.000Z", labels: {},
          }, project: null }],
          pageInfo: {}, requestId: "req-1",
        }),
        ref: () => ({ timeline: { refetch: async () => page } }),
        create: async () => { throw new Error("unused"); },
      },
    };

    const result = await new PaseoAdapter(paseo as never).discoverRecentCompletedTurns(null, 10);

    expect(result.turns.map((item) => item.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(result.turns[0]?.agent).toEqual({
      id: AGENT_ID,
      provider: AGENT_PROVIDER,
      cwd: AGENT_CWD,
      model: null,
    });
    expect(result.cursor).toBe("2040-01-02T00:00:00.000Z|agent-001");
  });

  it("uses the live nested agents.list shape and page limit", async () => {
    const page = refetchResult([entry(userItem("done"), "turn-live")]);
    const listCalls: unknown[] = [];
    const paseo = {
      agents: {
        list: async (options: unknown) => {
          listCalls.push(options);
          return {
            entries: [{
              agent: {
                id: AGENT_ID,
                provider: AGENT_PROVIDER,
                cwd: AGENT_CWD,
                status: "idle",
                updatedAt: "2040-01-02T00:00:00.000Z",
              },
              project: null,
            }],
            pageInfo: {},
            requestId: "req-live",
          };
        },
        ref: () => ({ timeline: { refetch: async () => page } }),
        create: async () => { throw new Error("unused"); },
      },
    };

    const result = await new PaseoAdapter(paseo as never).discoverRecentCompletedTurns(null, 10);

    expect(listCalls).toEqual([{
      sort: [{ key: "updated_at", direction: "asc" }],
      page: { limit: 10 },
    }]);
    expect(result.turns.map((item) => item.turnId)).toEqual(["turn-live"]);
  });

  it("paginates the complete sorted agent directory before advancing the cursor", async () => {
    const calls: unknown[] = [];
    const page = refetchResult([entry(userItem("done"), "turn-live")]);
    const makeEntry = (id: string, updatedAt: string) => ({
      agent: { id, provider: AGENT_PROVIDER, cwd: AGENT_CWD, status: "idle", updatedAt },
      project: null,
    });
    const paseo = {
      agents: {
        list: async (options: { page?: { cursor?: string } }) => {
          calls.push(options);
          return options.page?.cursor === undefined
            ? { entries: [makeEntry("agent-old", "2040-01-01T00:00:00.000Z")], pageInfo: { hasMore: true, nextCursor: "next", prevCursor: null }, requestId: "r1" }
            : { entries: [makeEntry("agent-new", "2040-01-02T00:00:00.000Z")], pageInfo: { hasMore: false, nextCursor: null, prevCursor: "prev" }, requestId: "r2" };
        },
        ref: () => ({ timeline: { refetch: async () => page } }),
        create: async () => { throw new Error("unused"); },
      },
    };

    const result = await new PaseoAdapter(paseo as never).discoverRecentCompletedTurns(null, 10);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      sort: [{ key: "updated_at", direction: "asc" }],
      page: { limit: 10, cursor: "next" },
    });
    expect(result.turns.map((turn) => turn.agent.id)).toEqual(["agent-old", "agent-new"]);
    expect(result.cursor).toBe("2040-01-02T00:00:00.000Z|agent-new");
  });
});

describe("listLoadedSkillNames", () => {
  it("returns only unique loaded skill commands", async () => {
    const paseo = {
      agents: {
        ref: () => ({
          timeline: { refetch: async () => { throw new Error("unused"); } },
          commands: async () => ({
            agentId: AGENT_ID,
            commands: [
              { name: "deploy", description: "Deploy", argumentHint: "", kind: "command" },
              { name: "tdd", description: "TDD", argumentHint: "", kind: "skill" },
              { name: "tdd", description: "TDD", argumentHint: "", kind: "skill" },
            ],
            error: null,
            requestId: "commands-1",
          }),
        }),
        create: async () => { throw new Error("unused"); },
      },
    };

    await expect(new PaseoAdapter(paseo as never).listLoadedSkillNames(AGENT_ID))
      .resolves.toEqual(["tdd"]);
  });
});

// ===========================================================================
// 5. Curator creation (runCurator)
// ===========================================================================

/**
 * Hand-derived expected create options. The curator inherits the source
 * provider route. The idempotency key is the stable key
 * for one review of one turn, derived only from the exact source agent and
 * turn — never from prompt content, so it cannot change between retries of
 * the same turn.
 */

const CURATOR_TITLE = "Curator: agent-001 / turn-002";

const expectedCreateOptions = (sourceId: string, turnId: string, prompt: string): FakeCreateOptions => ({
  agentId: "00000000-0000-5000-8000-000000000000",
  config: { provider: AGENT_PROVIDER, options: { sandbox_mode: "read-only", approval_policy: "never" }, toolPolicy: { preapproved: [] } },
  cwd: AGENT_CWD,
  parent: sourceId,
  prompt,
  background: true,
  idempotencyKey: `paseo-curator:${sourceId}:${turnId}`,
  title: `Curator: ${sourceId} / ${turnId}`,
  labels: { "paseo.sourceAgent": sourceId, "paseo.turnId": turnId },
  metadata: {
    "paseo.curator": true,
    "paseo.sourceAgent": sourceId,
    "paseo.turnId": turnId,
  },
});

/**
 * Fake whose only surface is `paseo.agents.create`: records the exact options
 * it receives and resolves `waitForFinish` with a scripted result (or rejects
 * the create itself). The `ref` half is inert here — the create fake is
 * intentionally separate from the read fake so the two suites never share
 * state.
 */
function makeFakeCreate(
  scripted:
    | { kind: "ok"; agentId: string; waitResult: FakeWaitForFinishResult }
    | { kind: "reject"; error: unknown },
): {
  paseo: FakePaseoApi;
  createCalls: FakeCreateOptions[];
  waitCalls: number[];
} {
  const createCalls: FakeCreateOptions[] = [];
  const waitCalls: number[] = [];
  const paseo: FakePaseoApi = {
    providers: {
      listControls: routingControls,
      waitForReady: async () => routingSnapshot([{ provider: "codex", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }]),
      listModels: async (provider) => routingModels(provider, []),
    },
    agents: {
      ref: (id: string) => {
        throw new Error(`runCurator must not ref agent "${id}"`);
      },
      create: async (options: FakeCreateOptions) => {
        createCalls.push(options);
        if (scripted.kind === "reject") {
          throw scripted.error;
        }
        return {
          id: options.agentId,
          waitForFinish: async (timeoutMs?: number) => {
            if (timeoutMs !== undefined) {
              waitCalls.push(timeoutMs);
            }
            return scripted.waitResult;
          },
        };
      },
    },
  };
  return { paseo, createCalls, waitCalls };
}

const idleWaitResult = (lastMessage: string | null): FakeWaitForFinishResult => ({
  status: "idle",
  final: null,
  error: null,
  lastMessage,
});

const PROMPT = "CURATOR-PROMPT-DO-NOT-LEAK";
const CURATOR_AGENT_ID = "curator-001";

describe("runCurator", () => {
  it("creates the curator agent with the exact hand-derived options", async () => {
    const source = snapshot();
    const turnId = "turn-002";
    const { paseo, createCalls, waitCalls } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult("final curator output"),
    });

    const adapter = new PaseoAdapter(paseo);
    const result = await adapter.runCurator(source, turnId, PROMPT);

    // Exactly one create.
    expect(createCalls).toHaveLength(1);
    const opts = createCalls[0];
    expect(opts).toBeDefined();
    // The curator inherits the source provider route instead of requiring a
    // provider or model tied to the plugin author's environment.
    expect(opts!.config.provider).toBe(AGENT_PROVIDER);
    expect(opts!.config).toEqual({ provider: AGENT_PROVIDER, options: { sandbox_mode: "read-only", approval_policy: "never" }, toolPolicy: { preapproved: [] } });
    expect(opts!.agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Source cwd and parent agent id.
    expect(opts!.cwd).toBe(AGENT_CWD);
    expect(opts!.parent).toBe(AGENT_ID);
    // The review prompt itself.
    expect(opts!.prompt).toBe(PROMPT);
    // Background curator.
    expect(opts!.background).toBe(true);
    // Deterministic idempotency key from the exact source agent + turn.
    expect(opts!.idempotencyKey).toContain(`paseo-curator:agent-001:turn-002:codex/example-model:`);
    // A curator title.
    expect(opts!.title).toBe(CURATOR_TITLE);
    // Labels linking source agent/turn.
    expect(opts!.labels).toEqual({
      "paseo.sourceAgent": AGENT_ID,
      "paseo.turnId": turnId,
    });
    // Curator marker (boolean) plus exact source ids.
    expect(opts!.metadata["paseo.curator"]).toBe(true);
    expect(opts!.metadata["paseo.sourceAgent"]).toBe(AGENT_ID);
    expect(opts!.metadata["paseo.turnId"]).toBe(turnId);
    // Waits for the curator to finish.
    expect(waitCalls).toHaveLength(1);
    // Returns the curator agent id and its final text.
    expect(result).toEqual({ curatorAgentId: opts!.agentId, finalText: "final curator output" });
  });

  it("derives the idempotency key deterministically from the exact source agent and turn", async () => {
    const { paseo, createCalls } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult("ok"),
    });
    const adapter = new PaseoAdapter(paseo);

    // The same source agent + turn always yields the same idempotency key…
    await adapter.runCurator(snapshot(), "turn-002", "prompt A");
    await adapter.runCurator(snapshot(), "turn-002", "a totally different prompt B");
    const [a, b] = createCalls;
    expect(a!.idempotencyKey).toBe(b!.idempotencyKey);
    // …but a different turn does not.
    await adapter.runCurator(snapshot(), "turn-003", "prompt A");
    expect(createCalls[2]!.idempotencyKey).not.toBe(a!.idempotencyKey);
    // …and a different source agent does not.
    await adapter.runCurator({ ...snapshot(), id: "agent-999" }, "turn-002", "prompt A");
    expect(createCalls[3]!.idempotencyKey).not.toBe(a!.idempotencyKey);
  });

  it("waits for finish and returns {curatorAgentId, finalText} from an idle result", async () => {
    const { paseo, waitCalls } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult("the curator finished"),
    });

    const adapter = new PaseoAdapter(paseo);
    const result = await adapter.runCurator(snapshot(), "turn-002", PROMPT);
    expect(result.curatorAgentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.finalText).toBe("the curator finished");
    expect(waitCalls).toHaveLength(1);
  });

  it.each([
    ["error", "a model error"],
    ["timeout", "turn took too long"],
    ["permission", "permission denied"],
  ] as const)(
    "rejects a %s wait result with a bounded structural error that does not echo the prompt",
    async (status, message) => {
      const { paseo } = makeFakeCreate({
        kind: "ok",
        agentId: CURATOR_AGENT_ID,
        waitResult: { status, final: null, error: message, lastMessage: null },
      });

      const adapter = new PaseoAdapter(paseo);
      const promise = adapter.runCurator(snapshot(), "turn-002", PROMPT);
      await expect(promise).rejects.toThrow(/agent "agent-001" turn "turn-002"/);
      await expect(promise).rejects.not.toThrow(PROMPT);
    },
  );

  it("rejects an idle wait result whose lastMessage is null, without echoing the prompt", async () => {
    const { paseo } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult(null),
    });

    const adapter = new PaseoAdapter(paseo);
    const promise = adapter.runCurator(snapshot(), "turn-002", PROMPT);
    await expect(promise).rejects.toThrow(/agent "agent-001" turn "turn-002"/);
    await expect(promise).rejects.not.toThrow(PROMPT);
  });

  it("propagates a create rejection through a bounded structural error without echoing the prompt", async () => {
    const { paseo } = makeFakeCreate({
      kind: "reject",
      error: new Error(`provider exploded while creating agent for prompt: ${PROMPT}`),
    });

    const adapter = new PaseoAdapter(paseo);
    const promise = adapter.runCurator(snapshot(), "turn-002", PROMPT);
    await expect(promise).rejects.toThrow(/agent "agent-001" turn "turn-002"/);
    await expect(promise).rejects.not.toThrow(PROMPT);
  });

  it("composes a bare snapshot provider and its model into the provider/model selection", async () => {
    const { paseo, createCalls } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult("ok"),
    });

    const adapter = new PaseoAdapter(paseo);
    // Daemon snapshots carry the bare provider id and the model separately;
    // the client SDK requires the combined `provider/model` form.
    await adapter.runCurator(
      { ...snapshot("codex", AGENT_CWD, "custom/nested-model") },
      "turn-002",
      PROMPT,
    );
    expect(createCalls[0]!.config.provider).toBe("codex/custom/nested-model");
  });

  it("passes a provider that already contains a slash through unchanged", async () => {
    const { paseo, createCalls } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult("ok"),
    });

    const adapter = new PaseoAdapter(paseo);
    await adapter.runCurator(snapshot(), "turn-002", PROMPT);
    expect(createCalls[0]!.config.provider).toBe(AGENT_PROVIDER);
  });

  it("rejects a bare provider with no model as source-model-unavailable when no fallback is available", async () => {
    const { paseo, createCalls } = makeFakeCreate({
      kind: "ok",
      agentId: CURATOR_AGENT_ID,
      waitResult: idleWaitResult("ok"),
    });
    // No providers API → no fallback → source-model-unavailable
    const adapter = new PaseoAdapter(paseo);
    const promise = adapter.runCurator(
      { ...snapshot("omp"), model: null },
      "turn-002",
      PROMPT,
    );
    await expect(promise).rejects.toThrow(/source-model-unavailable/);
    await expect(promise).rejects.not.toThrow(PROMPT);
    expect(createCalls).toHaveLength(0);
  });

  it("falls back to the user-configured provider when source provider create fails", async () => {
    let createCount = 0;
    const paseo: FakePaseoApi = {
      agents: {
        ref: () => { throw new Error("must not ref"); },
        create: async (options: FakeCreateOptions) => {
          createCount++;
          if (createCount === 1) throw new Error("provider rejected");
          return { id: options.agentId, waitForFinish: async () => idleWaitResult("saved outcome") };
        },
      },
      providers: {
        listControls: routingControls,
      waitForReady: async () => routingSnapshot([{ provider: "codex", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }]),
        listModels: async (provider) => routingModels(provider, [{ id: "codex-default", label: "Default", isDefault: true }]),
      },
    };
    const settings = {
      read: async () => ({ status: "ready" as const, values: { fallbackProvider: "codex" } }),
      subscribe: () => () => {},
    };

    const adapter = new PaseoAdapter(paseo, settings);
    const result = await adapter.runCurator(
      { id: "agent-source", provider: "codex/source-model", cwd: "/tmp" },
      "turn-fb",
      PROMPT,
    );
    expect(result.finalText).toBe("saved outcome");
    expect(createCount).toBe(2);
  });

  it("rejects an unsupported source without transmitting when no fallback is configured", async () => {
    const paseo: FakePaseoApi = {
      agents: {
        ref: () => { throw new Error("must not ref"); },
        create: async () => { throw new Error("provider rejected"); },
      },
    };
    const settings = {
      read: async () => ({ status: "ready" as const, values: { fallbackProvider: undefined } }),
      subscribe: () => () => {},
    };
    const adapter = new PaseoAdapter(paseo, settings);
    const promise = adapter.runCurator(
      { id: "agent-hermes", provider: "hermes/zai:glm-5.3", cwd: "/tmp" },
      "turn-fb",
      PROMPT,
    );
    await expect(promise).rejects.toThrow(/source-model-unavailable/);
  });

  it("reads routing settings fresh after switching, clearing, invalidation and recovery", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    paseo.providers = {
      listControls: routingControls,
      waitForReady: async () => routingSnapshot([{ provider: "codex", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }]),
      listModels: async (provider) => routingModels(provider, [{ id: "default", label: "Default", isDefault: true }]),
    };
    let state: { status: "ready" | "invalid"; values?: { fallbackProvider?: string } } = { status: "ready", values: { fallbackProvider: "codex" } };
    let reads = 0;
    const adapter = new PaseoAdapter(paseo, { read: async () => { reads++; return state; } });
    const source = { id: "source", provider: "missing", cwd: "/tmp" };
    await adapter.runCurator(source, "one", PROMPT);
    expect(createCalls.map(call => call.config)).toEqual([{ provider: "codex/default", options: { sandbox_mode: "read-only", approval_policy: "never" }, toolPolicy: { preapproved: [] } }]);
    for (const next of [
      { status: "ready" as const, values: { fallbackProvider: "unknown" } },
      { status: "ready" as const, values: {} },
      { status: "invalid" as const },
    ]) {
      state = next;
      await expect(adapter.runCurator(source, "next", PROMPT)).rejects.toThrow();
      expect(createCalls).toHaveLength(1);
    }
    state = { status: "ready", values: { fallbackProvider: "codex" } };
    await adapter.runCurator(source, "restored", PROMPT);
    expect(createCalls).toHaveLength(2);
    expect(reads).toBeGreaterThanOrEqual(5);
  });

  it("does not send if fallback is cleared while provider discovery is pending", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    let fallbackProvider: string | undefined = "codex";
    paseo.providers = {
      listControls: routingControls,
      waitForReady: async () => routingSnapshot([{ provider: "codex", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }]),
      listModels: async (provider) => {
        fallbackProvider = undefined;
        return routingModels(provider, [{ id: "default", label: "Default", isDefault: true }]);
      },
    };
    const adapter = new PaseoAdapter(paseo, { read: async () => ({ status: "ready", values: { fallbackProvider } }) });
    await expect(adapter.runCurator({ id: "source", provider: "missing", cwd: "/tmp" }, "turn", PROMPT)).rejects.toThrow();
    expect(createCalls).toHaveLength(0);
  });

  it("does not reuse an earlier model route's agent identity", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    const adapter = new PaseoAdapter(paseo);
    await adapter.runCurator({ id: "source", provider: "codex/model-one", cwd: "/tmp" }, "turn", PROMPT);
    await adapter.runCurator({ id: "source", provider: "codex/model-two", cwd: "/tmp" }, "turn", PROMPT);
    expect(createCalls[0].agentId).not.toBe(createCalls[1].agentId);
    expect(createCalls[0].idempotencyKey).not.toBe(createCalls[1].idempotencyKey);
  });

  it("fails closed when the host lacks native control resolution", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    paseo.providers = {
      listControls: routingControls,
      waitForReady: async () => routingSnapshot([{ provider: "codex", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }]),
      listModels: async (provider) => routingModels(provider, [{ id: "default", label: "Default" }]),
    };
    delete paseo.providers.listControls;
    const adapter = new PaseoAdapter(paseo, { read: async () => ({ status: "ready", values: { fallbackProvider: "codex" } }) });
    await expect(adapter.runCurator({ id: "source", provider: "missing", cwd: "/tmp" }, "turn", PROMPT)).rejects.toThrow();
    expect(createCalls).toHaveLength(0);
  });
});


describe("provider-agnostic curator routing", () => {
  it.each(["claude", "codex"])("preserves the exact %s source model with native controls", async provider => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    await new PaseoAdapter(paseo).runCurator({ id: "source", provider, model: "vendor/nested:model", cwd: "/repo" }, "turn", PROMPT);
    expect(createCalls[0].config.provider).toBe(`${provider}/vendor/nested:model`);
    expect(createCalls[0].config.options).toBeDefined();
    expect(createCalls[0].config.modeId).toBeUndefined();
  });
  it("uses only the explicitly chosen provider and model, without discovery-order preferences", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    paseo.providers!.listModels = async (provider) => routingModels(provider, [{ id: "default", label: "Default" }, { id: "chosen/model", label: "Chosen" }]);
    const settings = { read: async () => ({ status: "ready" as const, values: { fallbackProvider: "claude", fallbackModel: "chosen/model" } }) };
    await new PaseoAdapter(paseo, settings).runCurator({ id: "source", provider: "hermes/model", cwd: "/repo" }, "turn", PROMPT);
    expect(createCalls.map(c => c.config.provider)).toEqual(["claude/chosen/model"]);
  });
  it("does not send to disabled providers even if they advertise safe-sounding modes", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    paseo.providers!.waitForReady = async () => routingSnapshot([{ provider: "codex", status: "ready", enabled: false }]);
    await expect(new PaseoAdapter(paseo).runCurator({ id: "source", provider: "codex/model", cwd: "/repo" }, "turn", PROMPT)).rejects.toThrow();
    expect(createCalls).toHaveLength(0);
  });
  it("revokes a fallback model change while native control resolution is pending", async () => {
    const { paseo, createCalls } = makeFakeCreate({ kind: "ok", agentId: CURATOR_AGENT_ID, waitResult: idleWaitResult("ok") });
    let fallbackModel = "one";
    paseo.providers!.listModels = async (provider) => routingModels(provider, [{ id: "one", label: "One" }, { id: "two", label: "Two" }]);
    paseo.providers!.listControls = async draft => { fallbackModel = "two"; return routingControls(draft); };
    const settings = { read: async () => ({ status: "ready" as const, values: { fallbackProvider: "claude", fallbackModel } }) };
    await expect(new PaseoAdapter(paseo, settings).runCurator({ id: "source", provider: "hermes/model", cwd: "/repo" }, "turn", PROMPT)).rejects.toThrow();
    expect(createCalls).toHaveLength(0);
  });
});
