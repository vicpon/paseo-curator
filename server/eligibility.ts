import type { PluginConfig } from "./contracts";

/**
 * The default cadence: a curator review after this many accumulated tool
 * iterations. Matches Hermes' default and the design spec.
 */
export const DEFAULT_REVIEW_THRESHOLD = 10;

/**
 * The outcome of a source-agent turn, as reported by the `agent.turn.after`
 * hook. The design states only *completed* turns qualify for the curator:
 * a failed or cancelled turn does not produce a review even if it burned
 * through many tool iterations.
 */
export type TurnOutcome = "completed" | "failed" | "cancelled";

/** The raw, untrusted input `evaluateTurn` consumes for one source-agent turn. */
export interface TurnInput {
  /** The lifecycle outcome of the turn. */
  outcome: TurnOutcome;
  /** Number of tool iterations the turn performed. Must be a non-negative integer. */
  toolIterations: number;
}

/**
 * The decision produced for a single turn. `eligible` is true only for
 * completed turns; `iterationsToCount` is the number of tool iterations this
 * turn contributes toward the review threshold (0 when ineligible).
 * `reviewThreshold` is the effective threshold, resolved from configuration.
 */
export interface EvaluationDecision {
  /** True only when the turn was completed. */
  eligible: boolean;
  /**
   * Tool iterations contributed toward the review threshold. Zero for
   * ineligible turns; a completed turn contributes all of its iterations.
   */
  iterationsToCount: number;
  /**
   * The effective review threshold, resolved from the supplied configuration
   * (falling back to {@link DEFAULT_REVIEW_THRESHOLD}). This is turn-independent
   * metadata the caller (store) uses for cadence bookkeeping.
   */
  reviewThreshold: number;
}

/**
 * A partial or full plugin configuration. Only `reviewThreshold` is relevant
 * here; callers may pass any subset of `PluginConfig`. Anything omitted falls
 * back to the contract default.
 */
export type EvaluateTurnConfig = Partial<PluginConfig>;

/**
 * Decide whether a source-agent turn qualifies for cadence accumulation and
 * how many tool iterations it contributes.
 *
 * This function is pure and stateless: it does not persist anything, does not
 * consult the running counter, and does not reset anything. The durable
 * running counter, threshold crossing, and the single reset rule (reset only
 * when enqueue succeeds or the duplicate is already durably present) all live
 * in the store.
 *
 * Only *completed* turns qualify. A failed or cancelled turn is not eligible
 * and contributes zero iterations, regardless of how many tool iterations it
 * burned through.
 */
export function evaluateTurn(input: TurnInput, config?: EvaluateTurnConfig): EvaluationDecision {
  const reviewThreshold = config?.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const eligible = input.outcome === "completed";
  const iterationsToCount = eligible && Number.isFinite(input.toolIterations) && input.toolIterations >= 0
    ? Math.trunc(input.toolIterations)
    : 0;
  return { eligible, iterationsToCount, reviewThreshold };
}
