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
  prompt?: string;
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
// 5. Structured reviewer startup and source-first routing.
import { afterEach } from "vitest";
import { reviewHost } from "./review-host";
import type { CreateAgentOptions } from "../server/paseo-adapter";
const hosts: ReturnType<typeof reviewHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });
const noSubmission = async () => ({ text: "scripted tool result" });
function runFixture(settings?: import("../server/paseo-adapter").RoutingSettings) {
  const host = reviewHost(); hosts.push(host);
  const creates: CreateAgentOptions[] = [];
  const prompts: string[] = [];
  const families = ["claude", "codex", "opencode", "omp", "hermes", "glm-acp-agent", "arbitrary-provider", "local.llm", "Acme"];
  const state = {
    enabled: [...families], failCreate: new Set<string>(), capabilities: true, attach: true, wrongIdentity: false,
    status: "idle" as "idle" | "error" | "permission" | "timeout", lastMessage: null as string | null,
    hook: async () => {}, onCreate: async () => {},
  };
  const paseo = {
    providers: {
      waitForReady: async () => { await state.hook(); return routingSnapshot(state.enabled.map(provider => ({ provider, enabled: true, status: "ready" as const }))); },
      listModels: async (provider: string) => routingModels(provider, [{ id: "vendor/default", label: "Default", isDefault: true }, { id: "chosen", label: "Chosen" }]),
    },
    agents: {
      ref: () => { throw new Error("unused"); },
      create: async (options: CreateAgentOptions) => {
        creates.push(options);
        if (state.failCreate.has(options.config.provider.split("/")[0])) throw new Error("private-create-failure");
        if (state.attach) await host.open(options);
        await state.onCreate();
        return { id: state.wrongIdentity ? "untrusted-returned-agent" : options.agentId, capabilities: { supportsMcpServers: state.capabilities, supportsToolInvocations: state.capabilities },
          waitForFinish: async () => { throw new Error("must not start source prompt before discovery"); },
          run: async (prompt: string) => { prompts.push(prompt); return { status: state.status, final: null, error: "private-provider-error", lastMessage: state.lastMessage }; },
          archive: async () => {},
        };
      },
    },
  };
  const adapter = new PaseoAdapter(paseo, settings, host.reviews);
  const run = (source = { id: "source", provider: "codex/model", cwd: "/repo" }, turn = "turn", attempt = "queue:1") =>
    adapter.runCurator(source, turn, "private-prompt", attempt, [{ skillName: "snapshot", path: "SKILL.md", content: "snapshot body" }], noSubmission);
  return { run, adapter, paseo, state, creates, prompts };
}

describe("structured runCurator", () => {
  it.each(["claude", "codex", "opencode", "omp", "hermes", "glm-acp-agent", "arbitrary-provider", "local.llm", "Acme"])("preserves exact %s source model and normal permissions", async family => {
    const f = runFixture();
    const result = await f.run({ id: "source", provider: `${family}/vendor/model`, cwd: "/repo" });
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0]).toMatchObject({ config: { provider: `${family}/vendor/model` }, parent: "source", cwd: "/repo", background: true,
      labels: { "paseo.sourceAgent": "source", "paseo.turnId": "turn" }, metadata: { "paseo.curator": true } });
    expect(f.creates[0].config).toEqual({ provider: `${family}/vendor/model` });
    expect(f.creates[0].prompt).toBeUndefined();
    expect(f.prompts[0]).toContain("private-prompt");
    expect(f.prompts[0]).toContain("snapshot body");
    expect(result).toEqual({ curatorAgentId: f.creates[0].agentId, finalText: "" });
  });

  it("composes bare provider plus model and keeps attempt/model-bound identities", async () => {
    const f = runFixture();
    await f.adapter.runCurator({ id: "source", provider: "codex", model: "model", cwd: "/repo" }, "turn", "prompt", "queue:1", [], noSubmission);
    await f.run();
    await f.run(undefined, "turn", "queue:2");
    await f.run({ id: "source", provider: "codex/other", cwd: "/repo" });
    expect(f.creates[0].config.provider).toBe("codex/model");
    expect(f.creates[0].agentId).toBe(f.creates[1].agentId);
    expect(new Set(f.creates.map(o => o.agentId)).size).toBe(3);
    expect(f.creates[0].agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([null, "malformed { final", "{\"outcome\":\"saved\"}"])("ignores final assistant prose %j", async lastMessage => {
    const f = runFixture(); f.state.lastMessage = lastMessage;
    expect((await f.run()).finalText).toBe("");
  });

  it.each(["error", "permission", "timeout"] as const)("reports %s without provider or prompt content", async status => {
    const f = runFixture(); f.state.status = status;
    await expect(f.run()).rejects.toThrow(`terminal-status:${status}`);
    await expect(f.run()).rejects.not.toThrow(/private-/);
  });

  it.each(["capabilities", "attach"] as const)("fails clearly before source transmission if %s is unavailable", async field => {
    const f = runFixture(); f.state[field] = false;
    await expect(f.run()).rejects.toThrow("structured-tool-injection-unavailable");
    expect(f.prompts).toHaveLength(0);
  });

  it("fails explicitly when the plugin has no injection registration", async () => {
    const f = runFixture();
    await expect(new PaseoAdapter(f.paseo).runCurator({ id: "source", provider: "codex/model", cwd: "/repo" }, "turn", "prompt", "queue:1", [], noSubmission))
      .rejects.toThrow("structured-tool-injection-unavailable");
    expect(f.creates).toHaveLength(0);
  });

  it("uses only explicit alternative consent after source creation fails", async () => {
    let values: { fallbackProvider?: string; fallbackModel?: string } = { fallbackProvider: "claude", fallbackModel: "chosen" };
    const f = runFixture({ read: async () => ({ status: "ready", values }) });
    f.state.failCreate.add("codex");
    await f.run();
    expect(f.creates.map(o => o.config.provider)).toEqual(["codex/model", "claude/chosen"]);
    values = {};
    await expect(f.run(undefined, "next")).rejects.toThrow("create-failed");
    values = { fallbackProvider: "omp" };
    await f.run(undefined, "restored");
    expect(f.creates.at(-1)?.config).toEqual({ provider: "omp/vendor/default" });
  });

  it("does not retry provider execution through an alternative after source launch succeeds", async () => {
    const f = runFixture({ read: async () => ({ status: "ready", values: { fallbackProvider: "claude" } }) });
    f.state.status = "error";
    await expect(f.run()).rejects.toThrow("terminal-status:error");
    expect(f.creates).toHaveLength(1);
  });

  it("does not transmit source data when consent is revoked while the reviewer session opens", async () => {
    let values: { fallbackProvider?: string } = { fallbackProvider: "claude" };
    const f = runFixture({ read: async () => ({ status: "ready", values }) });
    f.state.onCreate = async () => { values = {}; };
    await expect(f.run({ id: "source", provider: "unknown", cwd: "/repo" })).rejects.toThrow(/fallback-unavailable/);
    expect(f.prompts).toHaveLength(0);
  });

  it("fails an identity mismatch without transmitting or creating an alternative agent", async () => {
    const f = runFixture({ read: async () => ({ status: "ready", values: { fallbackProvider: "claude" } }) });
    f.state.wrongIdentity = true;
    await expect(f.run()).rejects.toThrow("curator-identity-mismatch");
    expect(f.creates).toHaveLength(1);
    expect(f.prompts).toHaveLength(0);
  });

  it("never sends when fallback consent is cleared during discovery", async () => {
    let consent = { fallbackProvider: "claude" } as { fallbackProvider?: string };
    const f = runFixture({ read: async () => ({ status: "ready", values: consent }) });
    let calls = 0;
    f.state.hook = async () => { if (++calls >= 2) consent = {}; };
    await expect(f.run({ id: "source", provider: "unknown", cwd: "/repo" })).rejects.toThrow();
    expect(f.creates).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
  });

  it("never transmits when source is disabled during the final readiness check", async () => {
    const f = runFixture({ read: async () => ({ status: "ready", values: { fallbackProvider: "claude" } }) });
    let calls = 0;
    f.state.hook = async () => { if (++calls >= 2) f.state.enabled = ["claude"]; };
    await expect(f.run()).rejects.toThrow("provider-unavailable");
    expect(f.creates).toHaveLength(0);
  });
});
