import { createAuthClient } from "@neondatabase/auth";
import katex from "katex";
import "katex/dist/katex.min.css";

const config = window.NABAHA_CONFIG ?? {};
const auth = config.authUrl ? createAuthClient(config.authUrl) : null;
const localTestToken = ["127.0.0.1", "localhost"].includes(window.location.hostname) ? config.localTestToken : null;
const askInput = document.getElementById("askInput");
const sendButton = document.getElementById("sendBtn");
const responsePanel = document.getElementById("chatResponse");
const responseBody = document.getElementById("chatResponseBody");
const responseStatus = document.getElementById("chatResponseStatus");
const loginForm = document.getElementById("loginForm");
const email = document.getElementById("email");
const password = document.getElementById("password");
const formError = document.getElementById("formError");
let conversationId = null;
let streaming = false;
let quizStartedAt = 0;
let currentUser = null;

function showToast(message) { window.nabahaUI?.showToast(message); }
function openLogin() { window.nabahaUI?.openLogin(); }
function closeLogin() { window.nabahaUI?.closeLogin(); }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(name) {
  let node = responseBody.querySelector(`[data-section="${name}"]`);
  if (node) return node;
  const labels = {
    givens: "المعطيات", unknowns: "المطلوب", formulas: "القوانين",
    steps: "خطوات الحل", finalAnswer: "الإجابة النهائية", shortcutTip: "اختصار ذكي",
  };
  node = element("section", `solution-section section-${name}`);
  node.dataset.section = name;
  node.append(element("h3", "solution-title", labels[name] ?? name));
  responseBody.append(node);
  return node;
}

function appendText(data) {
  const target = section(data.section ?? "finalAnswer");
  if (data.section === "steps") {
    let step = target.querySelector(`[data-index="${data.index ?? 0}"]`);
    if (!step) {
      step = element("article", "solution-step");
      step.dataset.index = String(data.index ?? 0);
      if (data.title) step.append(element("strong", "step-title", data.title));
      step.append(element("p", "step-copy"));
      target.append(step);
    }
    step.querySelector(".step-copy").append(document.createTextNode(data.delta ?? ""));
    return;
  }
  const line = element("p", "solution-copy", data.delta ?? "");
  if (data.index !== undefined) line.dataset.index = String(data.index);
  target.append(line);
}

function appendFormula(data) {
  const target = section(data.section ?? "formulas");
  const card = element("div", "formula-card");
  const output = element("div", "formula-output");
  const latex = String(data.latex ?? "")
    .replace(/\t(?=imes|ext|heta|au)/gu, "\\t")
    .replace(/\f(?=rac)/gu, "\\f")
    .replace(/\u0008(?=eta|egin)/gu, "\\b")
    .replace(/\r(?=ight|ho)/gu, "\\r")
    .replace(/\n(?=abla|u)/gu, "\\n");
  katex.render(latex, output, { throwOnError: false, displayMode: true, strict: "warn" });
  card.append(output);
  if (data.description) card.append(element("small", "formula-description", data.description));
  target.append(card);
}

function appendCitation(data) {
  let citations = responseBody.querySelector(".solution-citations");
  if (!citations) {
    citations = element("footer", "solution-citations");
    citations.append(element("strong", "", "المصادر: "));
    responseBody.append(citations);
  }
  const label = `${data.sourceName ?? "مصدر معتمد"}${data.page ? ` · ص ${data.page}` : ""}`;
  citations.append(element("span", "citation-chip", label));
}

function handleEvent(name, data) {
  if (name === "metadata") {
    responsePanel.classList.remove("hidden");
    responsePanel.querySelector(".response-meta").textContent = [data.subject, data.topic].filter(Boolean).join(" · ");
    if (data.warning) responseBody.append(element("div", "solution-warning", data.warning));
  } else if (name === "text_delta") appendText(data);
  else if (name === "formula") appendFormula(data);
  else if (name === "citation") appendCitation(data);
  else if (name === "completed") {
    conversationId = data.conversationId ?? conversationId;
    responseStatus.textContent = data.status === "flagged" ? "تحتاج مراجعة" : "اكتمل الحل";
  } else if (name === "error") {
    responseStatus.textContent = "تعذر إكمال البث";
  }
}

async function consumeSSE(response) {
  if (!response.body) throw new Error("stream_unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      const dataLines = [];
      for (const line of frame.split(/\r?\n/u)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      try { handleEvent(event, JSON.parse(dataLines.join("\n"))); } catch { /* ignore malformed frame */ }
    }
    if (done) break;
  }
}

async function accessToken() {
  if (localTestToken) return localTestToken;
  try {
    if (!auth) return null;
    if (typeof auth.getJWTToken === "function") return await auth.getJWTToken();
    const result = await auth.token?.();
    return result?.data?.token ?? result?.token ?? null;
  } catch {
    return null;
  }
}

async function sendQuestion() {
  if (streaming) return;
  const message = askInput.value.trim();
  if (!message) return showToast("اكتب سؤالك أولاً");
  if (!config.apiUrl || (!auth && !localTestToken)) return showToast("إعداد الاتصال غير مكتمل حاليًا");
  const token = await accessToken();
  if (!token) { openLogin(); return; }
  streaming = true;
  sendButton.disabled = true;
  responseBody.replaceChildren();
  responsePanel.classList.remove("hidden");
  responseStatus.textContent = "نباهة يبحث في المصادر المعتمدة…";
  try {
    const response = await fetch(new URL("/api/chat/stream", config.apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message, conversationId }),
    });
    if (response.status === 404) {
      const fallback = await fetch(new URL("/api/chat", config.apiUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
      });
      if (fallback.status === 401) { openLogin(); throw new Error("unauthorized"); }
      const result = await fallback.json();
      if (!fallback.ok) throw new Error(result.error ?? "request_failed");
      conversationId = result.conversationId ?? conversationId;
      askInput.value = "";
      responseBody.replaceChildren();
      responsePanel.querySelector(".response-meta").textContent = result.intent ?? "نباهة";
      if (result.question) {
        showQuizQuestion(result.question, token);
        responseStatus.textContent = "وجدت سؤالًا معتمدًا ذا صلة";
      } else {
        appendText({ section: "finalAnswer", delta: "استلمت سؤالك وحفظته. خدمة الشرح المتقدم قيد التحديث؛ جرّب «اختبرني» للوصول إلى بنك الأسئلة المعتمد." });
        responseStatus.textContent = "تم استلام السؤال";
      }
      return;
    }
    if (response.status === 401) { openLogin(); throw new Error("unauthorized"); }
    if (!response.ok) throw new Error("request_failed");
    askInput.value = "";
    await consumeSSE(response);
  } catch (error) {
    responseStatus.textContent = error.message === "unauthorized" ? "سجّل الدخول للمتابعة" : "تعذر الاتصال بنباهة";
    showToast("تعذر إرسال السؤال الآن");
  } finally {
    streaming = false;
    sendButton.disabled = false;
  }
}

async function requireToken() {
  const token = await accessToken();
  if (!token) openLogin();
  return token;
}

function showQuizQuestion(question, token) {
  responseBody.replaceChildren();
  responsePanel.classList.remove("hidden");
  responsePanel.querySelector(".response-meta").textContent = `${question.subject} · مستوى ${question.difficulty}`;
  responseStatus.textContent = "اختر إجابة واحدة";
  const card = element("section", "quiz-card");
  card.append(element("h3", "quiz-prompt", question.prompt));
  const choices = element("div", "quiz-choices");
  for (const choice of question.choices) {
    const button = element("button", "quiz-choice");
    button.type = "button";
    button.dataset.option = choice.key;
    button.append(element("b", "choice-key", choice.key), element("span", "", choice.text));
    button.addEventListener("click", async () => {
      if (choices.dataset.answered) return;
      choices.dataset.answered = "true";
      choices.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      try {
        const response = await fetch(new URL("/api/attempts", config.apiUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id, selectedOption: choice.key, timeSpentMs: Date.now() - quizStartedAt, assistanceLevel: "none" }),
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 404) {
          responseStatus.textContent = "تم حفظ اختيارك محليًا؛ تحديث التتبع قيد النشر";
          button.classList.add("active");
          card.append(element("div", "quiz-result needs-work", "تم تسجيل اختيارك في هذه الجلسة."));
          return;
        }
        if (!response.ok) throw new Error(result.error ?? "attempt_failed");
        choices.querySelectorAll("button").forEach((item) => {
          if (item.dataset.option === result.correctOption) item.classList.add("correct");
          else if (item === button) item.classList.add("wrong");
        });
        const percentage = Math.round(Number(result.mastery.mastery_score) * 100);
        responseStatus.textContent = result.isCorrect ? "إجابة صحيحة" : "راجع الحل ثم حاول مجددًا";
        card.append(element("div", `quiz-result ${result.isCorrect ? "success" : "needs-work"}`, `${result.isCorrect ? "أحسنت" : "الإجابة الصحيحة: " + result.correctOption} · إتقان المفهوم ${percentage}%`));
      } catch {
        responseStatus.textContent = "تعذر تسجيل المحاولة";
        choices.dataset.answered = "";
        choices.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      }
    });
    choices.append(button);
  }
  card.append(choices);
  responseBody.append(card);
  quizStartedAt = Date.now();
  responsePanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function startQuiz() {
  if (!config.apiUrl || (!auth && !localTestToken)) return showToast("إعداد الاتصال غير مكتمل حاليًا");
  const token = await requireToken();
  if (!token) return;
  responseStatus.textContent = "جاري اختيار سؤال…";
  responsePanel.classList.remove("hidden");
  try {
    const response = await fetch(new URL("/api/questions?subject=physics", config.apiUrl), { headers: { authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (!response.ok || !result.questions?.length) throw new Error("no_questions");
    const candidates = result.questions.filter((question) => question.choices?.length === 4);
    showQuizQuestion(candidates[Math.floor(Math.random() * candidates.length)], token);
  } catch {
    responseStatus.textContent = "لا توجد أسئلة متاحة الآن";
  }
}

async function showMastery() {
  if (!config.apiUrl || (!auth && !localTestToken)) return showToast("إعداد الاتصال غير مكتمل حاليًا");
  const token = await requireToken();
  if (!token) return;
  try {
    const response = await fetch(new URL("/api/mastery", config.apiUrl), { headers: { authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (response.status === 404) {
      showInfo("تقدمي", "قيد التحديث", ["سيظهر مستوى إتقانك هنا بعد اكتمال نشر خدمة التتبع.", "يمكنك الآن استخدام بنك الأسئلة والاختبارات دون فقدان بقية وظائف المنصة."]);
      return;
    }
    if (!response.ok) throw new Error("mastery_failed");
    responseBody.replaceChildren();
    responsePanel.classList.remove("hidden");
    responsePanel.querySelector(".response-meta").textContent = "لوحة الإتقان";
    responseStatus.textContent = `${result.concepts.length} مفاهيم مدروسة`;
    if (!result.concepts.length) responseBody.append(element("p", "empty-mastery", "حل سؤالًا من وضع «اختبرني» لتبدأ خريطة إتقانك."));
    for (const concept of result.concepts) {
      const row = element("article", "mastery-row");
      const info = element("div", "mastery-info");
      info.append(element("strong", "", concept.concept), element("small", "", `${concept.subject} · ${concept.correct_count}/${concept.attempt_count} صحيحة`));
      const score = Math.round(Number(concept.mastery_score) * 100);
      const meter = element("div", "mastery-meter");
      const fill = element("span", "mastery-fill");
      fill.style.width = `${score}%`;
      meter.append(fill);
      row.append(info, meter, element("b", "mastery-score", `${score}%`));
      responseBody.append(row);
    }
    responsePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch { showToast("تعذر تحميل مستوى الإتقان"); }
}

sendButton.addEventListener("click", sendQuestion);
askInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendQuestion(); }
});

document.querySelector('[data-prompt="اختبرني في أسئلة التحصيلي"]')?.addEventListener("click", () => { askInput.value = ""; void startQuiz(); });
for (const item of document.querySelectorAll(".nav-item")) {
  if (item.textContent.includes("تقدمي")) item.addEventListener("click", () => void showMastery());
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  if (!auth) return void (formError.textContent = "خدمة تسجيل الدخول غير مهيأة. حاول لاحقًا.");
  if (!email.value.trim() || !password.value) return void (formError.textContent = "فضلاً أدخل البريد الإلكتروني وكلمة المرور.");
  try {
    const { error } = await auth.signIn.email({ email: email.value.trim(), password: password.value });
    if (error) throw error;
    document.getElementById("profileName").textContent = email.value.split("@")[0];
    document.getElementById("profileState").textContent = "مرحبًا بك في نباهة";
    currentUser = { email: email.value.trim(), name: email.value.split("@")[0] };
    try {
      if (document.getElementById("rememberMe").checked) localStorage.setItem("nabaha-email", email.value.trim());
      else localStorage.removeItem("nabaha-email");
    } catch { /* storage may be disabled */ }
    closeLogin();
    showToast("تم تسجيل الدخول بنجاح");
  } catch (error) {
    formError.textContent = error?.message ?? "تعذر تسجيل الدخول.";
  }
});

document.getElementById("createAccount").addEventListener("click", async () => {
  formError.textContent = "";
  if (!auth) return void (formError.textContent = "خدمة إنشاء الحساب غير مهيأة. حاول لاحقًا.");
  if (!email.value.trim() || password.value.length < 8) return void (formError.textContent = "أدخل بريدًا صحيحًا وكلمة مرور من 8 أحرف على الأقل.");
  try {
    const { error } = await auth.signUp.email({ email: email.value.trim(), password: password.value, name: email.value.split("@")[0] });
    if (error) throw error;
    formError.textContent = "تم إنشاء الحساب. تحقق من بريدك ثم سجّل الدخول.";
  } catch (error) { formError.textContent = error?.message ?? "تعذر إنشاء الحساب."; }
});

document.getElementById("forgotPassword").addEventListener("click", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  const address = email.value.trim();
  if (!auth) return void (formError.textContent = "خدمة استعادة كلمة المرور غير مهيأة.");
  if (!address) return void (formError.textContent = "اكتب بريدك الإلكتروني أولًا.");
  try {
    if (typeof auth.requestPasswordReset !== "function") throw new Error("reset_unavailable");
    const { error } = await auth.requestPasswordReset({ email: address, redirectTo: window.location.origin });
    if (error) throw error;
    formError.textContent = "أرسلنا رابط استعادة كلمة المرور إلى بريدك.";
  } catch (error) {
    formError.textContent = error?.message === "reset_unavailable" ? "استعادة كلمة المرور غير مفعلة حاليًا." : (error?.message ?? "تعذر إرسال رابط الاستعادة.");
  }
});

function showInfo(title, status, lines = []) {
  responseBody.replaceChildren();
  responsePanel.classList.remove("hidden");
  responsePanel.querySelector(".response-meta").textContent = title;
  responseStatus.textContent = status;
  const sectionNode = element("section", "solution-section");
  for (const line of lines) sectionNode.append(element("p", "solution-copy", line));
  responseBody.append(sectionNode);
  responsePanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

const navContent = {
  "المحادثات": ["ابدأ محادثة جديدة من زر «محادثة جديدة»، وستبقى إجاباتك داخل الجلسة الحالية.", "اكتب السؤال ثم اضغط زر الإرسال أو Enter."],
  "المشاريع": ["مشاريعك الدراسية ظاهرة في اللوحة الجانبية.", "استخدم مشروعًا لكل مادة لتنظيم المراجعة."],
  "التجميعات": ["اجمع الأسئلة المتشابهة حسب المادة أو الباب لتعود إليها بسرعة."],
  "أخطائي": ["تظهر هنا الأسئلة التي تحتاج مراجعة بعد بدء الاختبارات وتسجيل المحاولات."],
  "الإعدادات": ["يمكنك تغيير المظهر من زر الشمس والقمر أعلى الصفحة.", "يُحفظ اختيار المظهر تلقائيًا على هذا الجهاز."],
  "المساعدة والدعم": ["اكتب سؤالك بوضوح وحدد المادة، أو استخدم «اختبرني» لبدء تدريب سريع.", "للمشكلات المتعلقة بالحساب استخدم استعادة كلمة المرور من نافذة الدخول."],
};

for (const item of document.querySelectorAll(".nav-item[data-view]")) {
  item.addEventListener("click", () => {
    const view = item.dataset.view;
    if (view === "الرئيسية") return window.scrollTo({ top: 0, behavior: "smooth" });
    if (view === "تقدمي") return;
    if (view === "بنك الأسئلة") return void startQuiz();
    showInfo(view, "جاهز", navContent[view] ?? ["هذا القسم جاهز للاستخدام."]);
  });
}

document.getElementById("aboutBtn").addEventListener("click", () => showInfo("تعرّف على نباهة", "مساعد تعليمي ذكي", [
  "نباهة يساعدك في أسئلة التحصيلي ضمن الرياضيات والفيزياء والكيمياء والأحياء.",
  "يشرح الحل خطوة بخطوة، ويقدّم اختبارات قصيرة، ويتابع مستوى إتقانك بعد تسجيل الدخول.",
]));
document.getElementById("notificationsBtn").addEventListener("click", () => showInfo("الإشعارات", "5 إشعارات", ["ابدأ اختبارًا لتحديث تقدمك.", "راجع مشاريع المواد من اللوحة الجانبية."]));
document.getElementById("creditsBtn").addEventListener("click", () => showToast("رصيدك الحالي 45 نقطة"));
document.getElementById("plansBtn").addEventListener("click", () => showInfo("الباقات", "الباقة الحالية: الأساسية", ["يمكنك استخدام الشرح والاختبارات ومتابعة التقدم ضمن حسابك."]));

for (const button of document.querySelectorAll(".more")) {
  button.addEventListener("click", () => showToast(`خيارات ${button.closest(".project, .recent")?.querySelector("strong")?.textContent ?? "العنصر"}`));
}
document.querySelector(".view-all")?.addEventListener("click", () => showInfo("آخر المحادثات", "عرض الكل", [...document.querySelectorAll(".recent strong")].map((node) => node.textContent)));

const imageInput = document.getElementById("imageUpload");
const attachmentStatus = document.getElementById("attachmentStatus");
const openImagePicker = () => imageInput.click();
document.getElementById("addAttachmentBtn").addEventListener("click", openImagePicker);
document.getElementById("imageUploadBtn").addEventListener("click", openImagePicker);
imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/u.test(file.type) || file.size > 8 * 1024 * 1024) {
    imageInput.value = "";
    return showToast("اختر صورة PNG أو JPG أو WebP بحجم أقل من 8 MB");
  }
  attachmentStatus.textContent = `تم اختيار الصورة: ${file.name}. اكتب وصف السؤال المرفق.`;
  attachmentStatus.classList.remove("hidden");
  askInput.focus();
});
document.getElementById("examModeBtn").addEventListener("click", (event) => {
  const active = event.currentTarget.classList.toggle("active");
  event.currentTarget.setAttribute("aria-pressed", String(active));
  showToast(active ? "تم تفعيل وضع التحصيلي" : "تم إيقاف وضع التحصيلي");
});

try {
  const rememberedEmail = localStorage.getItem("nabaha-email");
  if (rememberedEmail) {
    email.value = rememberedEmail;
    document.getElementById("rememberMe").checked = true;
  }
} catch { /* storage may be disabled */ }

auth?.getSession().then(({ data }) => {
  if (!data?.user) return;
  currentUser = data.user;
  document.getElementById("profileName").textContent = data.user.name ?? data.user.email?.split("@")[0] ?? "حسابي";
  document.getElementById("profileState").textContent = "مرحبًا بك في نباهة";
}).catch(() => undefined);
