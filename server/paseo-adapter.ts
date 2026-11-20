import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { createHash } from "node:crypto";

import type { TimelineEntry } from "./review-prompt";
import { registerCuratorAgentId } from "./curator-agents";

// ---------------------------------------------------------------------------
// Paseo API surface
// ---------------------------------------------------------------------------

/**
 * The minimal Paseo API surface the adapter consumes: just enough to refetch
 * an agent's timeline. The constructor accepts any object structurally
 * compatible with this shape — including the full `PluginPaseoApi` the host
 * hands the plugin, and the fakes the tests script.
 */
export interface PaseoApiRef {
  readonly agents: {
    readonly list?: (options?: {
      readonly sort?: ReadonlyArray<{ readonly key: "updated_at"; readonly direction: "asc" }>;
      readonly page?: { readonly limit?: number; readonly cursor?: string };
    }) => Promise<{
      readonly entries: ReadonlyArray<{
        readonly agent: {
          readonly id: string;
          readonly provider: string;
          readonly model?: string | null;
          readonly cwd: string;
          readonly status: "idle" | "running" | "error" | "closed" | "initializing";
          readonly updatedAt: string;
        };
      }>;
      readonly pageInfo?: {
        readonly hasMore?: boolean;
        readonly nextCursor?: string | null;
      };
    }>;
    readonly ref: (id: string) => {
      readonly timeline: {
        readonly refetch: (options?: RefetchOptions) => Promise<RefetchResult>;
      };
      readonly commands?: () => Promise<{
        readonly commands: ReadonlyArray<{ readonly name: string; readonly kind?: "command" | "skill" }>;
        readonly error: string | null;
      }>;
    };
    readonly create: (options: CreateAgentOptions) => Promise<AgentHandle>;
  };
  readonly providers?: {
    readonly waitForReady: (options?: { timeoutMs?: number }) => Promise<{
      readonly providers: ReadonlyArray<{ readonly id: string; readonly available: boolean }>;
    }>;
    readonly listModes: (provider: string) => Promise<{
      readonly modes: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    }>;
    readonly listModels: (provider: string) => Promise<{
      readonly models: ReadonlyArray<{ readonly id: string; readonly label: string; readonly isDefault?: boolean }>;
    }>;
  };
}

interface CuratorRoute {
  providerSelection: string;
  modeId: string;
}

export interface RoutingSettings {
  read(): Promise<{
    status: "ready" | "invalid";
    values?: { fallbackProvider?: string };
  }>;
}

/** A single agent snapshot with the fields the adapter captures. */
export interface SourceAgent {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  /**
   * The source agent's model id (e.g. `ai3/qwen/qwen3.8-27b`), when known.
   * Optional: the lifecycle hook payload does not carry it. The daemon
   * snapshot (timeline refetch or agent listing) is authoritative and the
   * orchestrator always re-reads the turn before running the curator, so the
   * curator path normally has it.
   */
  readonly model?: string | null;
}

/**
 * Options for a timeline refetch. Matches the client's
 * `PaseoAgentTimelineRefetchOptions` for the fields this adapter uses; the
 * `direction` literal is narrowed to the two directions the adapter ever
 * passes.
 */
export interface RefetchOptions {
  readonly direction: "tail" | "before";
  readonly cursor?: {
    readonly epoch: string;
    readonly seq: number;
  };
}

/** The minimal timeline refetch result the adapter reads from each page. */
export interface RefetchResult {
  readonly agentId: string;
  /**
   * The authoritative agent snapshot carried by the daemon payload.
   * Optional: a daemon build may omit it, in which case the caller-supplied
   * `SourceAgent` fields stand. When present it is the source of truth for
   * the agent's provider and cwd.
   */
  readonly agent?: {
    readonly id: string;
    readonly provider: string;
    readonly model?: string | null;
    readonly cwd: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } | null;
  readonly entries: ReadonlyArray<TimelineEntryPayload>;
  readonly startCursor: { readonly epoch: string; readonly seq: number } | null;
  readonly hasOlder: boolean;
  readonly error: string | null;
  readonly epoch?: string;
  readonly reset?: boolean;
  readonly staleCursor?: boolean;
  readonly gap?: boolean;
}

/** One entry on an agent timeline page. */
export interface TimelineEntryPayload {
  readonly provider: string;
  readonly item: AgentTimelineItem;
  readonly turnId?: string;
}

export interface RecoveredCompletedTurn {
  readonly agent: SourceAgent;
  readonly turnId: string;
  readonly cursor: string;
}

/**
 * Options for creating a curator agent. Mirrors the real
 * `PaseoAgentCreateOptions` for the fields the adapter uses.
 */
export interface CreateAgentOptions {
  readonly agentId: string;
  readonly config: { readonly provider: string; readonly modeId?: string };
  readonly cwd: string;
  readonly parent: string;
  readonly prompt: string;
  readonly background: boolean;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly labels: Record<string, string>;
  readonly metadata: Record<string, unknown>;
}

/** A handle on a created agent: its id and the terminal-state waiter. */
export interface AgentHandle {
  readonly id: string;
  readonly waitForFinish: (timeoutMs?: number) => Promise<WaitForFinishResult>;
}

/** Terminal state of a `waitForFinish` call. */
export interface WaitForFinishResult {
  readonly status: "idle" | "error" | "permission" | "timeout";
  readonly final: unknown | null;
  readonly error: string | null;
  readonly lastMessage: string | null;
}

// ---------------------------------------------------------------------------
// Turn read
// ---------------------------------------------------------------------------

/** A bounded, completed source turn, ready for the review prompt builder. */
export interface WholeTurnRead {
  readonly sourceAgentId: string;
  readonly turnId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly cwd: string;
  readonly entries: TimelineEntry[];
  readonly toolIterations: number;
  readonly usedSkillNames: string[];
}

/**
 * Bounded error thrown when the timeline read cannot complete.
 *
 * The message carries at most `MAX_ERROR_MESSAGE_CHARS` characters, and is
 * built only from the agent's identity and the daemon payload error — never
 * from transcript content.
 */
export class TurnReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnReadError";
  }
}

/** Hard cap on a `TurnReadError` message, so no read can surface an unbounded daemon payload. */
const MAX_ERROR_MESSAGE_CHARS = 500;

function boundedError(
  sourceAgentId: string,
  turnId: string,
  cause: string,
): TurnReadError {
  const message = `readWholeTurn failed for agent "${sourceAgentId}" turn "${turnId}": ${cause}`.slice(
    0,
    MAX_ERROR_MESSAGE_CHARS,
  );
  return new TurnReadError(message);
}

// ---------------------------------------------------------------------------
// Item mapping
// ---------------------------------------------------------------------------

/**
 * Map one timeline item to a review entry. Returns `null` for kinds that carry
 * no review content (todo, compaction, plugin) and for any unrecognized
 * item.
 */
function mapItem(item: AgentTimelineItem, cwd: string): TimelineEntry | null {
  switch (item.type) {
    case "user_message":
      return { role: "user", content: item.text };
    case "assistant_message":
      return { role: "assistant", content: item.text };
    case "reasoning":
      return { role: "assistant", content: `Reasoning: ${item.text}` };
    case "error":
      return { role: "system", content: `Error: ${item.message}` };
    case "notification":
      return { role: "system", content: `Notification(${item.level}): ${item.message}` };
    case "tool_call":
      return { role: "tool", content: formatToolCall(item, cwd) };
    default:
      // todo, compaction, plugin, and any future kinds carry no review content.
      return null;
  }
}

/**
 * Format a tool call with the protocol display model: "<displayName>:
 * <summary>", with " — <errorText>" appended when the call reports an error.
 */
function formatToolCall(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  cwd: string,
): string {
  const model = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    metadata: item.metadata,
    detail: item.detail,
    agentMessage: item.agentMessage,
    cwd,
  });
  const base = model.summary ? `${model.displayName}: ${model.summary}` : model.displayName;
  return model.errorText ? `${base} — ${model.errorText}` : base;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Reads an agent's completed turns through the Paseo API.
 *
 * `readWholeTurn` pulls pages of the agent timeline backward from the newest
 * until the requested turn is fully covered, then returns the turn's entries
 * in chronological order. The read is bounded: it stops on the first
 * older-boundary, on a missing turn, on a payload error, or once the daemon
 * reports no older pages.
 */
export class PaseoAdapter {
  constructor(
    private readonly paseo: PaseoApiRef,
    private readonly settings?: RoutingSettings,
  ) {}

  private async restrictedMode(providerId: string): Promise<string | null> {
    // Codex read-only sets a native read-only sandbox; labels and approval hooks alone do not.
    if (providerId !== "codex" || !this.paseo.providers) return null;
    try {
      const { modes } = await this.paseo.providers.listModes(providerId);
      return modes.some(mode => mode.id === "read-only") ? "read-only" : null;
    } catch {
      return null;
    }
  }

  private async resolveFallbackProvider(): Promise<CuratorRoute | null> {
    const providerId = await this.readFallbackSetting();
    if (!providerId || !this.paseo.providers) return null;
    const modeId = await this.restrictedMode(providerId);
    if (!modeId) return null;
    try {
      const { models } = await this.paseo.providers.listModels(providerId);
      const model = models.find(model => model.isDefault)?.id ?? models[0]?.id;
      if (!model) return null;
      return { providerSelection: `${providerId}/${model}`, modeId };
    } catch {
      return null;
    }
  }

  private async readFallbackSetting(): Promise<string | undefined> {
    try {
      const state = await this.settings?.read();
      return state?.status === "ready" && state.values?.fallbackProvider === "codex"
        ? state.values.fallbackProvider : undefined;
    } catch {
      return undefined;
    }
  }

  async listLoadedSkillNames(agentId: string): Promise<string[]> {
    const commands = this.paseo.agents.ref(agentId).commands;
    if (commands === undefined) return [];
    const result = await commands();
    if (result.error !== null) return [];
    return [...new Set(
      result.commands.filter((command) => command.kind === "skill").map((command) => command.name),
    )].sort();
  }

  async discoverRecentCompletedTurns(
    after: string | null,
    limit = 50,
  ): Promise<{ cursor: string; turns: RecoveredCompletedTurn[] }> {
    const listAgents = this.paseo.agents.list;
    if (listAgents === undefined) throw new Error("agent listing unavailable");
    const entries: Array<{
      agent: {
        id: string;
        provider: string;
        model?: string | null;
        cwd: string;
        status: "idle" | "running" | "error" | "closed" | "initializing";
        updatedAt: string;
      };
    }> = [];
    let pageCursor: string | undefined;
    const seenPageCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const listed = await listAgents({
        sort: [{ key: "updated_at", direction: "asc" }],
        page: { limit, ...(pageCursor === undefined ? {} : { cursor: pageCursor }) },
      });
      entries.push(...listed.entries);
      if (!listed.pageInfo?.hasMore) break;
      const next = listed.pageInfo.nextCursor;
      if (next === null || next === undefined || seenPageCursors.has(next)) {
        throw new Error("agent listing cursor did not progress");
      }
      seenPageCursors.add(next);
      pageCursor = next;
      if (pageNumber === 99) throw new Error("agent listing exceeded page bound");
    }
    const candidates = entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.status === "idle")
      .map((agent) => ({ agent, cursor: `${agent.updatedAt}|${agent.id}` }))
      .filter(({ cursor }) => after === null || cursor > after)
      .sort((a, b) => a.cursor.localeCompare(b.cursor));
    const turns: RecoveredCompletedTurn[] = [];
    for (const candidate of candidates) {
      const page = await this.paseo.agents.ref(candidate.agent.id).timeline.refetch({ direction: "tail" });
      if (page.error !== null || page.reset || page.staleCursor || page.gap) {
        throw boundedError(candidate.agent.id, "reconciliation", "timeline structurally incomplete");
      }
      if (page.agent?.metadata?.["paseo.curator"] === true) continue;
      const source: SourceAgent = {
        id: candidate.agent.id,
        provider: page.agent?.provider ?? candidate.agent.provider,
        cwd: page.agent?.cwd ?? candidate.agent.cwd,
        model: page.agent?.model ?? candidate.agent.model ?? null,
      };
      const seen = new Set<string>();
      for (const entry of page.entries) {
        if (entry.turnId === undefined || seen.has(entry.turnId)) continue;
        seen.add(entry.turnId);
        turns.push({ agent: source, turnId: entry.turnId, cursor: candidate.cursor });
      }
    }
    return { cursor: candidates.at(-1)?.cursor ?? after ?? "0|", turns };
  }

  /**
   * Read the complete timeline of `turnId` from `sourceAgent`'s timeline.
   *
   * Throws a {@link TurnReadError} — bounded to the agent identity and the
   * daemon payload error — if the daemon reports a payload error, the turn is
   * never found, or the timeline is exhausted before the turn completes.
   */
  async readWholeTurn(sourceAgent: SourceAgent, turnId: string): Promise<WholeTurnRead> {
    const agent = this.paseo.agents.ref(sourceAgent.id);

    // SDK pages are chronological within a page; older pages precede newer
    // ones, so older pages are prepended to `collected` without reversing and
    // the turn's entries are chronological across page boundaries.
    const collected: TimelineEntryPayload[] = [];
    let sawTurnEntry = false;
    let sawOlderBoundary = false;
    let cursor: { epoch: string; seq: number } | null = null;
    const seenCursors = new Set<string>();
    let timelineEpoch: string | null = null;
    // The authoritative agent snapshot as shipped by the daemon. When the
    // payload carries one, its provider and cwd win over the caller-supplied
    // `SourceAgent` fields — the durable queue row stores only the source id
    // and turn, so those caller fields are often empty placeholders.
    let authoritativeProvider: string | null = null;
    let authoritativeCwd: string | null = null;
    let authoritativeModel: string | null = null;

    for (;;) {
      const options: RefetchOptions =
        cursor === null ? { direction: "tail" } : { direction: "before", cursor };

      let page: RefetchResult;
      try {
        page = await agent.timeline.refetch(options);
      } catch (err) {
        throw boundedError(
          sourceAgent.id,
          turnId,
          `daemon fetch failed: ${describeThrown(err)}`,
        );
      }

      // A payload error carries the daemon's own message; never include the
      // entries it shipped.
      if (page.error !== null) {
        throw boundedError(sourceAgent.id, turnId, `daemon error: ${page.error}`);
      }
      if (page.reset === true) {
        throw boundedError(sourceAgent.id, turnId, "timeline reset");
      }
      if (page.staleCursor === true) {
        throw boundedError(sourceAgent.id, turnId, "timeline staleCursor");
      }
      if (page.gap === true) {
        throw boundedError(sourceAgent.id, turnId, "timeline gap");
      }
      if (page.epoch !== undefined) {
        if (timelineEpoch !== null && page.epoch !== timelineEpoch) {
          throw boundedError(sourceAgent.id, turnId, "timeline epoch changed during pagination");
        }
        timelineEpoch = page.epoch;
      }

      // The payload's agent snapshot is authoritative for the identity and
      // the live provider/cwd. Never silently accept a snapshot for a
      // different agent: throw a bounded structural error instead.
      const pageAgent = page.agent ?? null;
      if (pageAgent !== null) {
        if (pageAgent.id !== sourceAgent.id) {
          throw boundedError(
            sourceAgent.id,
            turnId,
            `timeline payload agent "${pageAgent.id}" does not match requested agent "${sourceAgent.id}"`,
          );
        }
        authoritativeProvider = pageAgent.provider;
        authoritativeCwd = pageAgent.cwd;
        authoritativeModel = pageAgent.model ?? null;
      }

      const firstTargetIndex = page.entries.findIndex((entry) => entry.turnId === turnId);
      const pageHasTarget = firstTargetIndex !== -1;
      if (pageHasTarget) {
        // Pages are chronological. Only a different, identified turn before
        // the first target entry proves that the target's older edge is on
        // this page; different turns after it are newer neighbors.
        sawOlderBoundary ||= page.entries
          .slice(0, firstTargetIndex)
          .some((entry) => entry.turnId !== undefined && entry.turnId !== turnId);
        sawTurnEntry = true;
      } else if (sawTurnEntry && cursor !== null) {
        // We already saw the target on a newer page, and this whole older page
        // contains none of it, so the target is complete.
        sawOlderBoundary = true;
      }

      if (cursor === null) {
        // First (tail) page: it is the newest page; keep it as the newest
        // entries and continue to the older page when one is available.
        collected.push(...page.entries);
      } else {
        // Older page: prepend it in place so older entries precede newer ones.
        collected.unshift(...page.entries);
      }

      const turnComplete = sawTurnEntry && (sawOlderBoundary || !page.hasOlder);
      if (turnComplete) {
        const inTurn = collected.filter((entry) => entry.turnId === turnId);
        return this.finish(sourceAgent, turnId, inTurn, authoritativeProvider, authoritativeCwd, authoritativeModel);
      }

      if (page.startCursor === null) {
        if (sawTurnEntry) {
          const inTurn = collected.filter((entry) => entry.turnId === turnId);
          return this.finish(sourceAgent, turnId, inTurn, authoritativeProvider, authoritativeCwd, authoritativeModel);
        }
        throw boundedError(
          sourceAgent.id,
          turnId,
          "turn not found: the timeline was exhausted before a single entry for this turn appeared",
        );
      }
      if (page.epoch !== undefined && page.startCursor.epoch !== page.epoch) {
        throw boundedError(sourceAgent.id, turnId, "timeline cursor epoch mismatch");
      }
      if (
        cursor !== null &&
        (page.startCursor.epoch !== cursor.epoch || page.startCursor.seq >= cursor.seq)
      ) {
        throw boundedError(sourceAgent.id, turnId, "timeline cursor did not move backward");
      }
      const cursorKey = `${page.startCursor.epoch}:${page.startCursor.seq}`;
      if (seenCursors.has(cursorKey)) {
        throw boundedError(sourceAgent.id, turnId, "timeline cursor did not advance");
      }
      seenCursors.add(cursorKey);
      cursor = page.startCursor;
    }
  }

  /**
   * Create a curator agent for a completed turn, wait for it to finish, and
   * return the curator's id and final text.
   *
   * Success is exactly: the create resolves, a single `waitForFinish` call
   * returns a terminal result of `status: "idle"` with a non-empty
   * `lastMessage`. Every failure path — a create rejection, a wait
   * rejection, or an idle result whose `lastMessage` is null or empty —
   * throws a {@link CuratorRunError} bounded to the source agent id, turn
   * id, and a safe category. The source agent's prompt is never echoed, and
   * a thrown provider message is not included in the error text when it may
   * echo the prompt or model output; the safe category carries the failure.
   */
  async runCurator(
    sourceAgent: SourceAgent,
    turnId: string,
    prompt: string,
    reviewId?: string,
  ): Promise<CuratorRunResult> {
    const provider = sourceAgent.provider.trim();
    const providerId = provider.split("/")[0];
    const selection = provider.includes("/") ? provider
      : sourceAgent.model?.trim() ? `${provider}/${sourceAgent.model.trim()}` : null;
    const modeId = selection ? await this.restrictedMode(providerId) : null;
    let route: CuratorRoute | null = selection && modeId ? { providerSelection: selection, modeId } : null;
    let usedFallback = false;
    if (!route) {
      route = await this.resolveFallbackProvider();
      usedFallback = true;
    }
    if (!route) throw curatorError(sourceAgent.id, turnId, "source-model-unavailable");

    const create = async (selected: CuratorRoute, fallback: boolean) => {
      if (fallback && await this.readFallbackSetting() !== selected.providerSelection.split("/")[0]) {
        throw curatorError(sourceAgent.id, turnId, "fallback-unavailable");
      }
      const routeKey = `${selected.providerSelection}:${selected.modeId}`;
      const reviewKey = reviewId === undefined ? turnId : JSON.stringify([turnId, reviewId]);
      const agentId = deriveCuratorAgentId(sourceAgent.id, `${reviewKey}:${routeKey}`);
      const unregister = registerCuratorAgentId(agentId);
      try {
        const handle = await this.paseo.agents.create({
          agentId,
          config: { provider: selected.providerSelection, modeId: selected.modeId },
          cwd: sourceAgent.cwd,
          parent: sourceAgent.id,
          prompt,
          background: true,
          idempotencyKey: `paseo-curator:${sourceAgent.id}:${reviewKey}:${routeKey}`,
          title: `Curator: ${sourceAgent.id} / ${turnId}`,
          labels: { "paseo.sourceAgent": sourceAgent.id, "paseo.turnId": turnId },
          metadata: { "paseo.curator": true, "paseo.sourceAgent": sourceAgent.id, "paseo.turnId": turnId },
        });
        if (handle.id !== agentId) throw new Error("curator identity mismatch");
        return { handle, unregister };
      } catch {
        unregister();
        throw curatorError(sourceAgent.id, turnId, "create-failed");
      }
    };

    let created: Awaited<ReturnType<typeof create>>;
    try {
      created = await create(route, usedFallback);
    } catch {
      const fallback = usedFallback ? null : await this.resolveFallbackProvider();
      if (!fallback || fallback.providerSelection === route.providerSelection) {
        throw curatorError(sourceAgent.id, turnId, "create-failed");
      }
      created = await create(fallback, true);
    }
    const { handle, unregister: unregisterCurator } = created;

    let result: WaitForFinishResult;
    try {
      // A single wait; the fixed timeout bounds the wait if the provider
      // ever stalls before reporting a terminal state.
      result = await handle.waitForFinish(CURATOR_WAIT_TIMEOUT_MS);
    } catch {
      throw curatorError(sourceAgent.id, turnId, "wait-failed");
    }

    if (result.status === "idle" || result.status === "error") {
      unregisterCurator();
    }

    if (result.status !== "idle" || result.lastMessage === null || result.lastMessage === "") {
      throw curatorError(sourceAgent.id, turnId, `terminal-status:${result.status}`);
    }

    return { curatorAgentId: handle.id, finalText: result.lastMessage };
  }

  private finish(
    sourceAgent: SourceAgent,
    turnId: string,
    inTurn: TimelineEntryPayload[],
    authoritativeProvider: string | null,
    authoritativeCwd: string | null,
    authoritativeModel: string | null,
  ): WholeTurnRead {
    // The daemon payload's agent snapshot is authoritative for the provider
    // and cwd; it wins over the caller-supplied fields (which may be empty
    // placeholders on the queued-processing path). The id always comes from
    // the caller — a snapshot for a different agent already failed the read.
    const provider = authoritativeProvider ?? sourceAgent.provider;
    const cwd = authoritativeCwd ?? sourceAgent.cwd;
    const model = authoritativeModel ?? sourceAgent.model ?? null;

    const entries: TimelineEntry[] = [];
    const callIds = new Set<string>();
    const usedSkillNames = new Set<string>();

    // Entries arrive chronological; iterate them directly.
    for (const entry of inTurn) {
      const mapped = mapItem(entry.item, cwd);
      if (mapped !== null) {
        entries.push(mapped);
      }
      if (entry.item.type === "tool_call") {
        callIds.add(entry.item.callId);
        const serialized = JSON.stringify({ detail: entry.item.detail, metadata: entry.item.metadata });
        for (const match of serialized.matchAll(/[\\/]skills[\\/]([a-z0-9][a-z0-9_-]*)[\\/]SKILL\.md/gi)) {
          if (match[1] !== undefined) usedSkillNames.add(match[1]);
        }
      } else if (entry.item.type === "user_message") {
        const slashSkill = entry.item.text.match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s|$)/i)?.[1];
        if (slashSkill !== undefined) usedSkillNames.add(slashSkill);
      }
    }

    return {
      sourceAgentId: sourceAgent.id,
      turnId,
      provider,
      model,
      cwd,
      entries,
      toolIterations: callIds.size,
      usedSkillNames: [...usedSkillNames].sort(),
    };
  }
}

/**
 * Render an unknown thrown value as a short, transcript-free description:
 * the error's `message` if it is an `Error`, else its `String` form.
 */
function describeThrown(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 0 ? text : "<no message>";
}

// ---------------------------------------------------------------------------
// Curator run
// ---------------------------------------------------------------------------


/**
 * Fixed `waitForFinish` timeout for the curator run. Bounds the wait if the
 * provider ever stalls before reporting a terminal state; the terminal
 * result it produces is still validated before being accepted.
 */
const CURATOR_WAIT_TIMEOUT_MS = 300_000;

function deriveCuratorAgentId(sourceAgentId: string, turnId: string): string {
  const chars = createHash("sha256")
    .update(`paseo-curator\0${sourceAgentId}\0${turnId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A curator run, or its final text. */
export interface CuratorRunResult {
  readonly curatorAgentId: string;
  readonly finalText: string;
}

/**
 * Bounded error thrown when a curator run cannot complete.
 *
 * The message is built only from the source agent identity, the turn id, and
 * a safe category (`create-failed`, `wait-failed`, or the terminal status
 * name). A thrown provider message is never included, because it may echo
 * the review prompt or model output.
 */
export class CuratorRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CuratorRunError";
  }
}

function curatorError(
  sourceAgentId: string,
  turnId: string,
  category: string,
): CuratorRunError {
  return new CuratorRunError(
    `runCurator failed for agent "${sourceAgentId}" turn "${turnId}": ${category}`,
  );
}
