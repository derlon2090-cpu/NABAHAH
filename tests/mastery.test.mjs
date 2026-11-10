import test from "node:test";
import assert from "node:assert/strict";
import { nextMastery } from "../src/services/mastery.service.mjs";

test("correct independent answers increase mastery", () => {
  const result = nextMastery({ currentScore: 0.5, isCorrect: true, difficulty: 3, assistanceLevel: "none", timeSpentMs: 40_000, attemptCount: 2 });
  assert.ok(result.masteryScore > 0.5);
  assert.equal(result.attemptCount, 3);
});

test("full-solution assistance gives less credit than an independent answer", () => {
  const independent = nextMastery({ currentScore: 0.5, isCorrect: true, difficulty: 3, assistanceLevel: "none", timeSpentMs: 40_000, attemptCount: 0 });
  const assisted = nextMastery({ currentScore: 0.5, isCorrect: true, difficulty: 3, assistanceLevel: "full_solution", timeSpentMs: 40_000, attemptCount: 0 });
  assert.ok(independent.masteryScore > assisted.masteryScore);
});

test("incorrect answers reduce mastery and scores stay bounded", () => {
  const result = nextMastery({ currentScore: 0.03, isCorrect: false, difficulty: 1, assistanceLevel: "none", timeSpentMs: 20_000, attemptCount: 12 });
  assert.equal(result.masteryScore, 0.02);
  assert.ok(result.confidence <= 0.99);
});
