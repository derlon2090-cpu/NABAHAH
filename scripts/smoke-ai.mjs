import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
const { aiConfigured, generateStructuredSolution } = await import("../src/services/ai.service.ts");
if (!aiConfigured()) throw new Error("AI chat provider is not configured");

const result = await generateStructuredSolution(
  "في التفاعل الطارد للحرارة، ماذا يحدث لدرجة حرارة الوسط المحيط؟",
  [],
  { allowGeneralKnowledge: true, subject: "chemistry" },
);

if (result.solution.grounding !== "general_knowledge" || result.solution.citations.length !== 0 || !result.solution.warning || result.solution.subject !== "chemistry") {
  throw new Error("Graceful-degradation markers are invalid");
}
console.log(JSON.stringify({
  model: result.model,
  validationStatus: result.validationStatus,
  grounding: result.solution.grounding,
  warning: result.solution.warning,
  subject: result.solution.subject,
  finalAnswer: result.solution.finalAnswer,
}, null, 2));
