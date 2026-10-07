import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/intent-router.mjs";

test("natural greeting, thanks, and goodbye bypass the question bank", () => {
  for (const text of ["السلام عليكم", "شكراً", "مع السلامة"]) {
    assert.deepEqual(classifyIntent(text), { behavior: "general_conversation", requiresBank: false });
  }
});

test("short follow-ups use conversation history and do not query the bank", () => {
  assert.deepEqual(classifyIntent("وضح أكثر", true), { behavior: "follow_up", requiresBank: false });
  assert.equal(classifyIntent("وضح أكثر", false).requiresBank, false);
});

test("Tahsili solving is distinct from explicitly bank-sourced questions", () => {
  assert.deepEqual(classifyIntent("حل مسألة فيزياء"), { behavior: "question_solving", requiresBank: false });
  assert.deepEqual(classifyIntent("أعطني سؤال معتمد من بنك الأسئلة"), { behavior: "quiz_interaction", requiresBank: true });
});

test("study requests and out-of-scope requests are routed without retrieval", () => {
  assert.equal(classifyIntent("ساعدني أذاكر").behavior, "study_assistance");
  assert.deepEqual(classifyIntent("تشخيص مرض"), { behavior: "graceful_refusal", requiresBank: false });
});
