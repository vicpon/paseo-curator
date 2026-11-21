import { defineAgentTool, type PluginServerContext, type PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { REVIEW_TIMEOUT_MS, SUBMISSION_TOOL_NAME, SubmissionArgumentContract, SubmissionToolInput, submissionError, type SubmissionHandler } from "./review-submission";

interface ReviewBinding {
  agentId: string;
  provider: string;
  cwd: string;
  sourceAgentId: string;
  turnId: string;
  reviewId: string;
  authorized: () => Promise<boolean>;
  submit: SubmissionHandler;
}

/** Launch-only tools, bound from plugin state, never agent metadata or model arguments. */
export class ReviewTools {
  private readonly bindings = new Map<string, {
    input: ReviewBinding;
    active: boolean;
    attached: boolean;
    deadline: number;
    calls: Set<Promise<unknown>>;
  }>();
  private readonly remove: () => void;

  constructor(server: Pick<PluginServerContext, "addHook">) {
    this.remove = server.addHook("agent.open.before", async ({ request }) => this.open(request));
  }

  bind(input: ReviewBinding): { readonly attached: boolean; close(): Promise<void> } {
    if (input.agentId === input.sourceAgentId || !input.reviewId || this.bindings.has(input.agentId)) throw new Error("invalid curator binding");
    const entry = { input, active: true, attached: false, deadline: Date.now() + REVIEW_TIMEOUT_MS, calls: new Set<Promise<unknown>>() };
    this.bindings.set(input.agentId, entry);
    return {
      get attached() { return entry.attached; },
      close: async () => {
        entry.active = false;
        this.bindings.delete(input.agentId);
        await Promise.allSettled([...entry.calls]);
      },
    };
  }

  private open(request: PluginSessionOpenRequest): PluginSessionOpenRequest | undefined {
    const entry = this.bindings.get(request.agentId);
    if (!entry?.active || request.purpose !== "interactive" || request.cwd !== entry.input.cwd
      || request.provider.split("/")[0] !== entry.input.provider.split("/")[0]) return;
    const tool = defineAgentTool({
      name: SUBMISSION_TOOL_NAME,
      title: "Submit Curator review",
      description: "Submit the complete review for validation and guarded apply. Correct isError feedback in this same run. Only a successful accepted result records a review; final prose is ignored. Submit nothing_to_save with operations [] when appropriate. Never supply agent IDs, claim authority, readSet or hashes. At most four submissions and five minutes per review. Strict argument contract: " + SubmissionArgumentContract,
      input: SubmissionToolInput,
      execute: (input, context) => {
        const checkRoute = async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              entry.input.authorized().catch(() => false),
              new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, Math.min(10_000, entry.deadline - Date.now()))); }),
            ]);
          } finally { clearTimeout(timer); }
        };
        const authorized = async () => entry.active && Date.now() < entry.deadline && !context.signal.aborted
          && context.agent.id === entry.input.agentId && context.agent.id !== entry.input.sourceAgentId
          && context.agent.parentAgentId === entry.input.sourceAgentId && context.agent.cwd === entry.input.cwd
          && context.agent.provider.split("/")[0] === entry.input.provider.split("/")[0]
          && await checkRoute() && entry.active && !context.signal.aborted && Date.now() < entry.deadline;
        const call = (async () => {
          try {
            if (!await authorized()) return submissionError("unauthorized, revoked or expired review submission");
            return await entry.input.submit(input, authorized);
          } catch { return submissionError("review submission failed; durable state requires reconciliation"); }
        })();
        entry.calls.add(call);
        void call.then(() => entry.calls.delete(call), () => entry.calls.delete(call));
        return call;
      },
    });
    entry.attached = true;
    return { ...request, tools: [...request.tools, tool] };
  }

  async close(): Promise<void> {
    this.remove();
    const entries = [...this.bindings.values()];
    for (const entry of entries) entry.active = false;
    this.bindings.clear();
    await Promise.allSettled(entries.flatMap(entry => [...entry.calls]));
  }
}
