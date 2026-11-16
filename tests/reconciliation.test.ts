import { describe, expect, it } from "vitest";
import { ReconciliationRunner, type RecoveredTurn } from "../server/reconciliation";

const turn = (agentId: string, turnId: string, cursor: string): RecoveredTurn => ({
  agent: { id: agentId, provider: "provider/example-model", cwd: "/work" },
  turnId,
  cursor,
});

class Gate {
  private releaseFn!: () => void;
  promise = new Promise<void>((resolve) => { this.releaseFn = resolve; });
  release(): void { this.releaseFn(); }
}

describe("ReconciliationRunner", () => {
  it("recovers missed completed turns, skips known rows, and persists the cursor after handling", async () => {
    let cursor: string | null = "cursor-1";
    const known = new Set(["agent-1:turn-known"]);
    const handled: string[] = [];
    const runner = new ReconciliationRunner({
      getCursor: () => cursor,
      setCursor: (next) => { cursor = next; },
      hasTurn: (agentId, turnId) => known.has(`${agentId}:${turnId}`),
      discover: async (after) => {
        expect(after).toBe("cursor-1");
        return {
          cursor: "cursor-2",
          turns: [turn("agent-1", "turn-known", "a"), turn("agent-2", "turn-missed", "b")],
        };
      },
      handleTurn: async (agent, turnId) => { handled.push(`${agent.id}:${turnId}`); },
    });

    expect(await runner.runOnce()).toBe("ran");
    expect(handled).toEqual(["agent-2:turn-missed"]);
    expect(cursor).toBe("cursor-2");
  });

  it("does not advance the cursor when recovered-turn handling fails", async () => {
    let cursor: string | null = null;
    const runner = new ReconciliationRunner({
      getCursor: () => cursor,
      setCursor: (next) => { cursor = next; },
      hasTurn: () => false,
      discover: async () => ({ cursor: "cursor-new", turns: [turn("agent-1", "turn-1", "a")] }),
      handleTurn: async () => { throw new Error("bounded failure"); },
    });

    await expect(runner.runOnce()).rejects.toThrow("bounded failure");
    expect(cursor).toBeNull();
  });

  it("retries a failed page without reprocessing earlier durable turns", async () => {
    let cursor: string | null = null;
    const observed = new Set<string>();
    const handled: string[] = [];
    const runner = new ReconciliationRunner({
      getCursor: () => cursor,
      setCursor: (next) => { cursor = next; },
      hasTurn: (agentId, turnId) => observed.has(`${agentId}:${turnId}`),
      discover: async () => ({
        cursor: "page-end",
        turns: [turn("agent-1", "turn-1", "cursor-1"), turn("agent-2", "turn-2", "cursor-2")],
      }),
      handleTurn: async (agent, turnId) => {
        const key = `${agent.id}:${turnId}`;
        handled.push(key);
        if (turnId === "turn-2") throw new Error("bounded failure");
        observed.add(key);
      },
    });

    await expect(runner.runOnce()).rejects.toThrow("bounded failure");
    await expect(runner.runOnce()).rejects.toThrow("bounded failure");
    expect(cursor).toBeNull();
    expect(handled).toEqual(["agent-1:turn-1", "agent-2:turn-2", "agent-2:turn-2"]);
  });

  it("excludes overlapping timer runs", async () => {
    const gate = new Gate();
    let discoveries = 0;
    const runner = new ReconciliationRunner({
      getCursor: () => null,
      setCursor: () => {},
      hasTurn: () => false,
      discover: async () => {
        discoveries += 1;
        await gate.promise;
        return { cursor: "done", turns: [] };
      },
      handleTurn: async () => {},
    });

    const first = runner.runOnce();
    expect(await runner.runOnce()).toBe("overlap");
    gate.release();
    expect(await first).toBe("ran");
    expect(discoveries).toBe(1);
  });
});
