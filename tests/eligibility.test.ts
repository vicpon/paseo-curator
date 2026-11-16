import { describe, expect, it } from "vitest";

import { evaluateTurn, DEFAULT_REVIEW_THRESHOLD } from "../server/eligibility";
import type { PluginConfig } from "../server/contracts";

/**
 * `evaluateTurn` is the pure eligibility gate for a single source-agent turn.
 * It decides whether a completed turn qualifies for cadence accumulation and
 * how many tool iterations that turn contributes. It carries no state: the
 * running per-agent counter, threshold crossing, and reset live in the store.
 */
describe("evaluateTurn", () => {
  describe("completed-only eligibility", () => {
    it("qualifies a completed turn and counts its tool iterations", () => {
      const decision = evaluateTurn({ outcome: "completed", toolIterations: 7 });
      expect(decision.eligible).toBe(true);
      expect(decision.iterationsToCount).toBe(7);
    });

    it("qualifies a completed turn with zero tool iterations (contributes nothing)", () => {
      const decision = evaluateTurn({ outcome: "completed", toolIterations: 0 });
      expect(decision.eligible).toBe(true);
      expect(decision.iterationsToCount).toBe(0);
    });

    it("rejects a failed turn and counts no iterations", () => {
      const decision = evaluateTurn({ outcome: "failed", toolIterations: 12 });
      expect(decision.eligible).toBe(false);
      expect(decision.iterationsToCount).toBe(0);
    });

    it("rejects a cancelled turn and counts no iterations", () => {
      const decision = evaluateTurn({ outcome: "cancelled", toolIterations: 12 });
      expect(decision.eligible).toBe(false);
      expect(decision.iterationsToCount).toBe(0);
    });
  });

  describe("review threshold configuration", () => {
    it("defaults the review threshold to 10 when no config is supplied", () => {
      const decision = evaluateTurn({ outcome: "completed", toolIterations: 3 });
      expect(DEFAULT_REVIEW_THRESHOLD).toBe(10);
      expect(decision.reviewThreshold).toBe(10);
    });

    it("honours an explicit reviewThreshold override from a partial config", () => {
      const decision = evaluateTurn(
        { outcome: "completed", toolIterations: 3 },
        { reviewThreshold: 5 },
      );
      expect(decision.reviewThreshold).toBe(5);
    });

    it("honours the threshold from a full PluginConfig object", () => {
      const config: PluginConfig = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 4,
        curatorConcurrency: 1,
        maxOperations: 20,
        maintenanceEnabled: true,
        consolidationEnabled: false,
        staleDays: 14,
        archiveDays: 30,
        maxRetries: 3,
      };
      const decision = evaluateTurn({ outcome: "completed", toolIterations: 2 }, config);
      expect(decision.reviewThreshold).toBe(4);
    });

    it("falls back to the default when a partial config omits reviewThreshold", () => {
      const decision = evaluateTurn(
        { outcome: "completed", toolIterations: 1 },
        { curatorConcurrency: 2 },
      );
      expect(decision.reviewThreshold).toBe(DEFAULT_REVIEW_THRESHOLD);
    });

    it("reports the threshold even for ineligible turns (config is turn-independent)", () => {
      const decision = evaluateTurn(
        { outcome: "failed", toolIterations: 9 },
        { reviewThreshold: 6 },
      );
      expect(decision.eligible).toBe(false);
      expect(decision.reviewThreshold).toBe(6);
    });
  });
});
