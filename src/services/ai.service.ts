import { solutionSchema, type StructuredSolution } from "../schemas/solution.schema.ts";
import type { RetrievalResult } from "./retrieval.service.ts";
import { embedTexts, embeddingsConfigured } from "./embedding-client.mjs";

const apiBase = process.env.AI_API_BASE_URL?.replace(/\/$/u, "");
const apiKey = process.env.AI_API_KEY;
const aiProvider = process.env.AI_PROVIDER === "ollama" ? "ollama" : "openai_compatible";
const chatModel = process.env.AI_MODEL ?? process.env.AI_MODEL_NAME ?? "gpt-4.1-mini";
const structuredOutputMode = process.env.AI_STRUCTURED_OUTPUT_MODE === "json_object" ? "json_object" : "json_schema";
const disableReasoning = process.env.AI_DISABLE_REASONING === "true";
const requestTimeoutMs = Math.min(Math.max(Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 180_000), 10_000), 300_000);
const maxOutputTokens = Math.min(Math.max(Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 900), 256), 4_000);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function repairLatexEscapes(value: unknown) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\t(?=imes|ext|heta|au)/gu, "\\t")
    .replace(/\f(?=rac)/gu, "\\f")
    .replace(/\u0008(?=eta|egin)/gu, "\\b")
    .replace(/\r(?=ight|ho)/gu, "\\r")
    .replace(/\n(?=abla|u)/gu, "\\n");
}

export function aiConfigured() {
  return Boolean(apiBase && apiKey);
}

async function aiFetch(path: string, body: Record<string, unknown>) {
  if (!apiBase || !apiKey) throw new Error("ai_not_configured");
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`ai_request_failed:${response.status}`);
  return response.json() as Promise<any>;
}

async function ollamaChat(body: Record<string, unknown>) {
  if (!apiBase) throw new Error("ai_not_configured");
  const ollamaBase = apiBase.replace(/\/v1$/u, "");
  const response = await fetch(`${ollamaBase}/api/chat`, {
    method: "POST",
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`ai_request_failed:${response.status}`);
  return response.json() as Promise<any>;
}

export async function embedText(input: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) return null;
  return (await embedTexts([input]))[0];
}

export async function generateStructuredSolution(
  question: string,
  contexts: RetrievalResult[],
  options: { allowGeneralKnowledge?: boolean; subject?: "mathematics" | "physics" | "chemistry" | "biology" | null } = {},
): Promise<{ solution: StructuredSolution; model: string; usage: { prompt: number; completion: number }; validationStatus: "passed" | "adjusted" }> {
  if (!contexts.length && !options.allowGeneralKnowledge) throw new Error("grounding_required");
  const sourceText = contexts.map((item, index) =>
    `[${index + 1}] sourceId=${item.chunkId}; source=${item.sourceName}; page=${item.pageNumber ?? "unknown"}\n${item.content}`,
  ).join("\n\n") || "لا يوجد سياق مسترجع.";
  const jsonSchema = {
      type: "json_schema",
      json_schema: {
        name: "nabaha_solution",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["grounding", "warning", "subject", "topic", "difficulty", "givens", "unknowns", "formulas", "steps", "finalAnswer", "shortcutTip", "citations", "followupQuestionId"],
          properties: {
            grounding: { type: "string", enum: ["retrieved", "general_knowledge"] },
            warning: { type: ["string", "null"] },
            subject: { type: "string", enum: ["mathematics", "physics", "chemistry", "biology"] },
            topic: { type: "string", minLength: 1 },
            difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            givens: { type: "array", items: { type: "string", minLength: 1 } },
            unknowns: { type: "array", items: { type: "string", minLength: 1 } },
            formulas: { type: "array", items: { type: "object", additionalProperties: false, required: ["latex", "description"], properties: { latex: { type: "string" }, description: { type: "string" } } } },
            steps: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["title", "explanation", "latex"], properties: { title: { type: "string" }, explanation: { type: "string" }, latex: { type: ["string", "null"] } } } },
            finalAnswer: { type: "string", minLength: 1 },
            shortcutTip: { type: ["string", "null"] },
            citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceId", "sourceName", "page"], properties: { sourceId: { type: "string" }, sourceName: { type: "string" }, page: { type: ["integer", "null"] } } } },
            followupQuestionId: { type: ["string", "null"], format: "uuid" },
          },
        },
      },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const general = !contexts.length;
      const schemaInstruction = structuredOutputMode === "json_object" || aiProvider === "ollama" ? `\nمخطط JSON المطلوب حرفياً:\n${JSON.stringify(jsonSchema.json_schema.schema)}` : "";
      const messages = [
          {
            role: "system",
            content: (general
              ? "أنت معلم نباهة للتحصيلي. لا يوجد سياق مسترجع. أجب فقط إن كنت واثقًا من قاعدة علمية مدرسية مستقرة، واضبط grounding=general_knowledge وwarning برسالة عربية واضحة وcitations=[]؛ وإلا اذكر تعذر التحقق في finalAnswer. اكتب جميع الحقول التعليمية بالعربية فقط، بما فيها العناوين والشروح والمعطيات، وقدم مسار حل تعليميًا ولا تكشف التفكير الداخلي. مثال الأسلوب: title=تطبيق القانون، explanation=نعوّض بالقيم المعطاة ثم نحسب الناتج. أخرج JSON فقط."
              : "أنت معلم نباهة للتحصيلي. أجب من السياق المعتمد فقط، واضبط grounding=retrieved وwarning=null. اكتب جميع الحقول التعليمية بالعربية فقط، بما فيها العناوين والشروح والمعطيات؛ لا تستخدم الإنجليزية إلا للرموز والوحدات العلمية. مثال الأسلوب: title=تطبيق قانون نيوتن الثاني، explanation=نعوّض بالكتلة والتسارع في القانون. قدم مسار حل تعليميًا ولا تكشف التفكير الداخلي. أدرج sourceId وsourceName والصفحة من السياق في citations. أخرج JSON فقط.") + schemaInstruction,
          },
          { role: "user", content: `${disableReasoning ? "/no_think\n" : ""}السؤال:\n${question}\n\nالسياق:\n${sourceText}` },
        ];
      const payload = aiProvider === "ollama"
        ? await ollamaChat({ model: chatModel, messages, stream: false, think: false, format: structuredOutputMode === "json_schema" ? jsonSchema.json_schema.schema : "json", options: { temperature: attempt === 0 ? 0.1 : 0, num_predict: maxOutputTokens } })
        : await aiFetch("/chat/completions", { model: chatModel, temperature: attempt === 0 ? 0.1 : 0, max_tokens: maxOutputTokens, messages, response_format: structuredOutputMode === "json_object" ? { type: "json_object" } : jsonSchema });
      const raw = aiProvider === "ollama" ? payload?.message?.content : payload?.choices?.[0]?.message?.content;
      if (typeof raw !== "string") throw new Error("invalid_ai_response");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const normalizedFollowupId = typeof parsed.followupQuestionId === "string" && uuidPattern.test(parsed.followupQuestionId)
        ? parsed.followupQuestionId
        : null;
      const provenance = contexts.length ? {} : {
        grounding: "general_knowledge",
        citations: [],
        warning: "تمت الإجابة من المعرفة العلمية العامة لعدم توفر مصدر مطابق في بنك نباهة حاليًا.",
      };
      const routedSubject = options.subject ? { subject: options.subject } : {};
      const repairedLatex = {
        formulas: Array.isArray(parsed.formulas) ? parsed.formulas.map((formula: any) => ({ ...formula, latex: repairLatexEscapes(formula?.latex) })) : parsed.formulas,
        steps: Array.isArray(parsed.steps) ? parsed.steps.map((step: any) => ({ ...step, latex: repairLatexEscapes(step?.latex) })) : parsed.steps,
      };
      const normalized = parsed.followupQuestionId !== normalizedFollowupId
        || (!contexts.length && (parsed.grounding !== "general_knowledge" || !Array.isArray(parsed.citations) || parsed.citations.length > 0))
        || Boolean(options.subject && parsed.subject !== options.subject);
      const solution = solutionSchema.parse({ ...parsed, ...repairedLatex, ...provenance, ...routedSubject, followupQuestionId: normalizedFollowupId });
      const allowedSources = new Set(contexts.map((item) => item.chunkId));
      if (contexts.length) {
        if (solution.grounding !== "retrieved" || !solution.citations.length || solution.citations.some((citation) => !allowedSources.has(citation.sourceId))) throw new Error("invalid_citations");
      } else if (solution.grounding !== "general_knowledge" || solution.citations.length || !solution.warning) {
        throw new Error("invalid_general_knowledge_marker");
      }
      return {
        solution,
        model: payload?.model ?? chatModel,
        usage: { prompt: payload?.usage?.prompt_tokens ?? payload?.prompt_eval_count ?? 0, completion: payload?.usage?.completion_tokens ?? payload?.eval_count ?? 0 },
        validationStatus: attempt === 0 && !normalized ? "passed" : "adjusted",
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
