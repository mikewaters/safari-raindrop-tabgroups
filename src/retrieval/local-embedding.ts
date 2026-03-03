const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "is","it","as","be","was","are","been","from","has","had","have","not","this",
  "that","which","their","they","we","you","your","can","will","all","more",
  "about","up","out","so","what","its","into","than","them","then","these",
  "our","new","also","just","most","how","where","when","who","may","each",
]);

const TRANSFORMERS_MODEL_ALIASES: Record<string, string> = {
  "local-minilm-l6-v2": "Xenova/all-MiniLM-L6-v2",
  "local-bge-small-en-v1.5": "BAAI/bge-small-en-v1.5",
};

let transformerExtractorPromise: Promise<any> | null = null;
let transformerExtractorKey: string | null = null;

export interface LocalEmbeddingRuntimeConfig {
  embedding_model_version: string;
  vector_dimensions: number;
  transformers_model_id?: string;
  transformers_dtype?: string;
  cache_dir?: string;
  allow_remote_models?: boolean;
  local_model_path?: string | null;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function retrievalTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter(
    (token) => !STOP_WORDS.has(token)
  );
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

export function extractItemSignals(
  title: string,
  url: string,
  maxKeyphrases = 8,
  maxEntities = 8
): {
  normalizedUrl: string;
  signalPackText: string;
  keyphrases: string[];
  entities: string[];
} {
  const normalizedUrl = normalizeUrl(url);
  let hostname = "";
  let pathSegments: string[] = [];
  try {
    const parsed = new URL(normalizedUrl);
    hostname = parsed.hostname.replace(/^www\./, "");
    pathSegments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 1)
      .map((segment) => segment.replace(/[^A-Za-z0-9-]/g, " "))
      .map((segment) => segment.trim())
      .filter(Boolean);
  } catch {}

  const signalPackText = [title.trim(), hostname, ...pathSegments].filter(Boolean).join(" | ");
  const tokenCounts = new Map<string, number>();
  for (const token of retrievalTokens(signalPackText)) {
    tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }

  const keyphrases = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxKeyphrases)
    .map(([token]) => token);

  const titleEntities =
    title.match(/\b[A-Z][A-Za-z0-9.+-]{1,}\b/g)?.map((value) => value.trim()) || [];
  const hostEntities = hostname
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && !["com", "org", "net", "io"].includes(part));
  const entities = [...new Set([...titleEntities, ...hostEntities])].slice(0, maxEntities);

  return { normalizedUrl, signalPackText, keyphrases, entities };
}

export function embedText(
  text: string,
  dimensions = 64
): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = retrievalTokens(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    const sign = ((hash >>> 31) & 1) === 0 ? 1 : -1;
    const weight = 1 + (token.length % 5) * 0.1;
    vector[index] += sign * weight;
  }

  return normalizeVector(vector);
}

function resolveTransformerModelId(config: LocalEmbeddingRuntimeConfig): string | null {
  if (config.embedding_model_version === "local-hash-v1") return null;
  if (config.transformers_model_id) return config.transformers_model_id;
  return TRANSFORMERS_MODEL_ALIASES[config.embedding_model_version] || null;
}

async function getTransformerExtractor(config: LocalEmbeddingRuntimeConfig): Promise<any> {
  const modelId = resolveTransformerModelId(config);
  if (!modelId) {
    throw new Error(
      `Unsupported local embedding model "${config.embedding_model_version}".`
    );
  }

  const cacheKey = [
    modelId,
    config.transformers_dtype || "q8",
    config.cache_dir || "",
    config.allow_remote_models === false ? "local-only" : "remote-ok",
    config.local_model_path || "",
  ].join("|");

  if (transformerExtractorPromise && transformerExtractorKey === cacheKey) {
    return transformerExtractorPromise;
  }

  transformerExtractorKey = cacheKey;
  transformerExtractorPromise = (async () => {
    try {
      const transformers = await import("@huggingface/transformers");
      const { env, pipeline } = transformers as any;
      if (config.cache_dir) {
        env.cacheDir = config.cache_dir;
      }
      env.allowLocalModels = true;
      env.allowRemoteModels = config.allow_remote_models !== false;
      if (config.local_model_path) {
        env.localModelPath = config.local_model_path;
      }

      return pipeline("feature-extraction", modelId, {
        dtype: config.transformers_dtype || "q8",
      });
    } catch (error) {
      transformerExtractorPromise = null;
      transformerExtractorKey = null;
      throw new Error(
        `Failed to initialize local embedding model "${config.embedding_model_version}": ${error}`
      );
    }
  })();

  return transformerExtractorPromise;
}

function normalizeEmbeddingRows(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];
  if (raw.every((value) => typeof value === "number")) {
    return [normalizeVector(raw as number[])];
  }
  return raw
    .filter((value): value is unknown[] => Array.isArray(value))
    .map((row) =>
      normalizeVector(
        row.filter((value): value is number => typeof value === "number")
      )
    )
    .filter((row) => row.length > 0);
}

function extractEmbeddingRows(output: any): number[][] {
  if (!output) return [];
  if (typeof output.tolist === "function") {
    return normalizeEmbeddingRows(output.tolist());
  }
  if (Array.isArray(output)) {
    return normalizeEmbeddingRows(output);
  }
  if (ArrayBuffer.isView(output.data) && typeof output.dims?.[0] === "number") {
    const dims = output.dims as number[];
    const data = Array.from(output.data as ArrayLike<number>);
    if (dims.length === 1) {
      return [normalizeVector(data)];
    }
    if (dims.length >= 2) {
      const rowSize = dims[dims.length - 1];
      const rows: number[][] = [];
      for (let i = 0; i < data.length; i += rowSize) {
        rows.push(normalizeVector(data.slice(i, i + rowSize)));
      }
      return rows;
    }
  }
  return [];
}

export async function embedTextsWithConfig(
  texts: string[],
  config: LocalEmbeddingRuntimeConfig
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (config.embedding_model_version === "local-hash-v1") {
    return texts.map((text) => embedText(text, config.vector_dimensions));
  }

  const extractor = await getTransformerExtractor(config);
  const output = await extractor(texts, {
    pooling: "mean",
    normalize: true,
  });
  const rows = extractEmbeddingRows(output);

  if (rows.length !== texts.length) {
    throw new Error(
      `Embedding model "${config.embedding_model_version}" returned ${rows.length} vector(s) for ${texts.length} input(s).`
    );
  }

  return rows;
}

export async function embedTextWithConfig(
  text: string,
  config: LocalEmbeddingRuntimeConfig
): Promise<number[]> {
  const [embedding] = await embedTextsWithConfig([text], config);
  if (embedding) return embedding;
  return config.embedding_model_version === "local-hash-v1"
    ? embedText(text, config.vector_dimensions)
    : [];
}

export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return [...vector];
  return vector.map((value) => value / magnitude);
}

export function serializeVector(vector: number[]): string {
  return JSON.stringify(vector.map((value) => Number(value.toFixed(8))));
}

export function parseVector(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.filter((value): value is number => typeof value === "number");
    return vector.length === parsed.length ? vector : null;
  } catch {
    return null;
  }
}

export function dotProduct(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dimensions = vectors[0].length;
  const summed = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dimensions) continue;
    for (let i = 0; i < dimensions; i++) summed[i] += vector[i];
  }
  return normalizeVector(summed.map((value) => value / vectors.length));
}

export function selectExemplars(
  vectors: number[][],
  centroid: number[],
  maxExemplars = 5
): number[][] {
  return [...vectors]
    .filter((vector) => vector.length === centroid.length)
    .sort((a, b) => dotProduct(b, centroid) - dotProduct(a, centroid))
    .slice(0, Math.max(1, maxExemplars));
}

export function softmaxEntropy(scores: number[]): number {
  if (scores.length === 0) return 0;
  const maxScore = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - maxScore));
  const total = exps.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const expValue of exps) {
    const probability = expValue / total;
    if (probability > 0) {
      entropy -= probability * Math.log(probability);
    }
  }
  return entropy;
}
