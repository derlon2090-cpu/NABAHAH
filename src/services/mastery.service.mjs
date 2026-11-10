export function nextMastery({ currentScore, isCorrect, difficulty, assistanceLevel, timeSpentMs, attemptCount }) {
  const score = Number.isFinite(currentScore) ? currentScore : 0.5;
  const level = Math.min(Math.max(Number(difficulty) || 1, 1), 5);
  const assistanceFactor = assistanceLevel === "full_solution" ? 0.35 : assistanceLevel === "hint_used" ? 0.75 : 1;
  const paceFactor = timeSpentMs > 180_000 ? 0.8 : 1;
  const positiveDelta = (0.08 + (level - 1) * 0.0125) * assistanceFactor * paceFactor;
  const negativeDelta = 0.1 + (5 - level) * 0.0075;
  const masteryScore = Math.min(0.98, Math.max(0.02, score + (isCorrect ? positiveDelta : -negativeDelta)));
  const nextAttemptCount = Math.max(0, Number(attemptCount) || 0) + 1;
  const confidence = Math.min(0.99, 1 - Math.exp(-nextAttemptCount / 6));
  return { masteryScore, confidence, attemptCount: nextAttemptCount };
}
