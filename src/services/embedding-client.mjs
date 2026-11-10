const apiBase = (process.env.EMBEDDING_API_BASE_URL ?? process.env.AI_API_BASE_URL)?.replace(/\/$/u, "");
const apiKey = process.env.EMBEDDING_API_KEY ?? process.env.AI_API_KEY;

export const embeddingModel = process.env.AI_EMBEDDING_MODEL;
export const embeddingDimensions = Number(process.env.AI_EMBEDDING_DIMENSIONS ?? 1536);

export function embeddingsConfigured() {
  return Boolean(apiBase && apiKey && embeddingModel);
}

export async function embedTexts(inputs) {
  if (!embeddingsConfigured()) throw new Error("embedding_not_configured");
  if (!Array.isArray(inputs) || !inputs.length) return [];
  const response = await fetch(`${apiBase}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: embeddingModel, input: inputs.map((value) => String(value).slice(0, 8_000)) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`embedding_request_failed:${response.status}`);
  const payload = await response.json();
  const vectors = [...(payload?.data ?? [])].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (vectors.length !== inputs.length) throw new Error("embedding_count_mismatch");
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== embeddingDimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`embedding_dimension_mismatch:expected_${embeddingDimensions}:received_${Array.isArray(vector) ? vector.length : 0}`);
    }
  }
  return vectors;
}
