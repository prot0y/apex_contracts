/**
 * rag.js — PDF ingestion, chunking, embedding, and retrieval
 *
 * Flow:
 *   ingestPDF(filePath, projectId, filename)
 *     → extract text from PDF
 *     → split into overlapping chunks
 *     → embed each chunk via nomic-embed-text (Ollama)
 *     → upsert into ChromaDB with project metadata
 *
 *   retrieve(query, projectId, topK)
 *     → embed query
 *     → query ChromaDB for nearest chunks
 *     → return formatted context string for prompt injection
 */

const fs   = require('fs');
const path = require('path');
const { ChromaClient } = require('chromadb');

const OLLAMA_HOST   = process.env.OLLAMA_HOST  || 'http://13.0.2.47:11434';
const EMBED_MODEL   = process.env.EMBED_MODEL  || 'nomic-embed-text';
const CHROMA_HOST   = process.env.CHROMA_HOST  || 'http://localhost:8000';
const COLLECTION    = process.env.CHROMA_COLLECTION || 'apex_docs';
const CHUNK_SIZE    = parseInt(process.env.RAG_CHUNK_SIZE   || '512');
const CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || '64');
const TOP_K         = parseInt(process.env.RAG_TOP_K         || '5');

// ── CHROMA CLIENT ─────────────────────────────────────────────────────────────
const chroma = new ChromaClient({ path: CHROMA_HOST });
let _collection = null;

async function getCollection() {
  if (_collection) return _collection;
  _collection = await chroma.getOrCreateCollection({
    name: COLLECTION,
    metadata: { 'hnsw:space': 'cosine' },
  });
  return _collection;
}

// ── EMBEDDING VIA OLLAMA ──────────────────────────────────────────────────────
async function embed(texts) {
  // Ollama /api/embed accepts an array — batch for efficiency
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama embed error ${res.status}: ${err}`);
  }
  const data = await res.json();
  // Returns { embeddings: [[...], [...], ...] }
  return data.embeddings;
}

// ── TEXT CHUNKING ─────────────────────────────────────────────────────────────
/**
 * Split text into overlapping word-based chunks.
 * Returns array of { text, chunkIndex, charStart }.
 */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + chunkSize);
    chunks.push({
      text: slice.join(' '),
      chunkIndex: chunks.length,
    });
    if (slice.length < chunkSize) break;
    i += chunkSize - overlap;
  }
  return chunks;
}

// ── PDF TEXT EXTRACTION ───────────────────────────────────────────────────────
async function extractPDFText(filePath) {
  // Lazy-require so server starts even if pdf-parse has minor issues
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text || '';
}

// ── INGEST ────────────────────────────────────────────────────────────────────
/**
 * Ingest a PDF file into ChromaDB.
 * @param {string} filePath   Absolute path to the PDF on disk
 * @param {string} projectId  Project this document belongs to
 * @param {string} filename   Original filename shown in UI
 * @param {string} docId      Unique doc identifier (used to allow re-ingest / replace)
 * @returns {{ chunks: number, pages: number }}
 */
async function ingestPDF(filePath, projectId, filename, docId) {
  // 1. Extract text
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const parsed = await pdfParse(buffer);
  const rawText = parsed.text || '';
  const pageCount = parsed.numpages || 0;

  if (!rawText.trim()) {
    throw new Error('PDF appears to be scanned/image-only. Text extraction returned empty — OCR support coming soon.');
  }

  // 2. Chunk
  const chunks = chunkText(rawText);
  if (chunks.length === 0) throw new Error('No text content found in PDF.');

  // 3. Embed (batch in groups of 32 to avoid timeouts on large docs)
  const BATCH = 32;
  const allEmbeddings = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map(c => c.text);
    const embeddings = await embed(batch);
    allEmbeddings.push(...embeddings);
  }

  // 4. Upsert into ChromaDB
  //    IDs are deterministic: docId_chunkIndex — re-ingesting replaces old vectors
  const collection = await getCollection();
  await collection.upsert({
    ids:        chunks.map((c, i) => `${docId}_chunk_${i}`),
    embeddings: allEmbeddings,
    documents:  chunks.map(c => c.text),
    metadatas:  chunks.map((c, i) => ({
      projectId,
      filename,
      docId,
      chunkIndex: i,
      totalChunks: chunks.length,
      pageCount,
    })),
  });

  return { chunks: chunks.length, pages: pageCount };
}

// ── DELETE ────────────────────────────────────────────────────────────────────
/**
 * Remove all vectors for a given docId from ChromaDB.
 */
async function deleteDocument(docId) {
  const collection = await getCollection();
  await collection.delete({ where: { docId } });
}

// ── RETRIEVE ──────────────────────────────────────────────────────────────────
/**
 * Retrieve the most relevant chunks for a query.
 * @param {string}   query      User's question / message
 * @param {string}   projectId  Scope retrieval to this project (pass null for global)
 * @param {number}   topK       Number of chunks to return
 * @returns {string} Formatted context block ready for prompt injection
 */
async function retrieve(query, projectId = null, topK = TOP_K) {
  const collection = await getCollection();

  // Check if collection has any documents
  const count = await collection.count();
  if (count === 0) return '';

  // Embed query
  const [queryEmbedding] = await embed([query]);

  // Build where filter
  const where = projectId ? { projectId } : undefined;

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: Math.min(topK, count),
    where,
    include: ['documents', 'metadatas', 'distances'],
  });

  if (!results.documents?.[0]?.length) return '';

  // Format into a context block
  const docs = results.documents[0];
  const metas = results.metadatas[0];
  const distances = results.distances[0];

  // Filter out low-relevance chunks (cosine distance > 0.5 is usually noise)
  const DISTANCE_THRESHOLD = 0.5;
  const relevant = docs
    .map((text, i) => ({ text, meta: metas[i], dist: distances[i] }))
    .filter(r => r.dist <= DISTANCE_THRESHOLD);

  if (relevant.length === 0) return '';

  // Group by filename for readable output
  const byFile = {};
  relevant.forEach(r => {
    const key = r.meta.filename || 'Unknown document';
    if (!byFile[key]) byFile[key] = [];
    byFile[key].push(r.text);
  });

  const sections = Object.entries(byFile).map(([filename, texts]) =>
    `[Document: ${filename}]\n${texts.join('\n\n')}`
  );

  return sections.join('\n\n---\n\n');
}

// ── LIST DOCS FOR PROJECT ─────────────────────────────────────────────────────
/**
 * Return unique documents stored for a project.
 */
async function listDocuments(projectId) {
  const collection = await getCollection();
  const count = await collection.count();
  if (count === 0) return [];

  // Get all metadatas for project — ChromaDB doesn't have a distinct query,
  // so we fetch a large batch and deduplicate by docId
  const results = await collection.get({
    where: { projectId },
    include: ['metadatas'],
    limit: 10000,
  });

  const seen = new Map();
  (results.metadatas || []).forEach(m => {
    if (!seen.has(m.docId)) {
      seen.set(m.docId, {
        docId: m.docId,
        filename: m.filename,
        chunks: m.totalChunks,
        pages: m.pageCount,
      });
    }
  });

  return Array.from(seen.values());
}

module.exports = { ingestPDF, deleteDocument, retrieve, listDocuments };
