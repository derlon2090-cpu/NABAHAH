const patterns = {
  greeting: /^(السلام عليكم|هلا|مرحبا|أهلا|صباح الخير|مساء الخير|السلام)$/u,
  thanks: /^(شكرا|شكرًا|يعطيك العافية|مشكور|ممتاز|جزاك الله خيرًا?)$/u,
  farewell: /^(مع السلامة|إلى اللقاء|باي|أراك لاحقًا)$/u,
  followUp: /^(ليش|لماذا|ما فهمت|لم أفهم|وضح أكثر|أعد الشرح|اشرح مرة ثانية|عطني مثال|أعطني مثال|كمل|تابع|كيف؟?)$/u,
  quiz: /(اختبرني|سؤال سريع|اعطني سؤال|أعطني سؤال|كويز)/u,
  study: /(خطة مذاكرة|جدول مذاكرة|نظم وقتي|كيف أذاكر|ساعدني أذاكر)/u,
  bank: /(من بنك الأسئلة|من بنك الاسئلة|سؤال معتمد|أسئلة معتمدة|اسحب سؤال)/u,
  tahsili: /(تحصيلي|رياضيات|فيزياء|كيمياء|أحياء|احسب|حل المعادلة|ما ناتج|أوجد)/u,
  outOfScope: /(تداول العملات|تشخيص مرض|وصفة طبية|اخترق|سلاح)/u,
};

export function classifyIntent(input, hasPriorTurn = false) {
  const text = String(input ?? "").trim().replace(/[؟!?.,،؛]+$/u, "");
  if (!text) return { behavior: "graceful_refusal", requiresBank: false };
  if (patterns.greeting.test(text)) return { behavior: "general_conversation", requiresBank: false };
  if (patterns.thanks.test(text)) return { behavior: "general_conversation", requiresBank: false };
  if (patterns.farewell.test(text)) return { behavior: "general_conversation", requiresBank: false };
  if (patterns.outOfScope.test(text)) return { behavior: "graceful_refusal", requiresBank: false };
  if (patterns.followUp.test(text) && hasPriorTurn) return { behavior: "follow_up", requiresBank: false };
  if (patterns.bank.test(text)) return { behavior: "quiz_interaction", requiresBank: true };
  if (patterns.quiz.test(text)) return { behavior: "quiz_interaction", requiresBank: false };
  if (patterns.study.test(text)) return { behavior: "study_assistance", requiresBank: false };
  if (patterns.tahsili.test(text)) return { behavior: "question_solving", requiresBank: false };
  return { behavior: hasPriorTurn ? "follow_up" : "general_conversation", requiresBank: false };
}
