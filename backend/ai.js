/**
 * ai.js — Ollama chat integration with RAG-aware prompting
 *
 * Each chat message:
 *   1. Retrieves relevant document chunks from ChromaDB (always on)
 *   2. Builds a system prompt with project data + retrieved context
 *   3. Streams the response from qwen2.5:7b
 *   4. Parses any <action> blocks and returns them for the server to execute
 */

const { retrieve } = require('./rag');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://13.0.2.47:11434';
const MODEL       = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function buildSystemPrompt(projectData, employeeData, ragContext) {
  const hasRag = ragContext && ragContext.trim().length > 0;

  return `You are an AI assistant for Apex Roofing's contract management system. You help manage roofing contracts, track expenses, log labor, and answer questions about project profitability and documents.

## Current Project Data
${JSON.stringify(projectData, null, 2)}

## Employees
${JSON.stringify(employeeData, null, 2)}

${hasRag ? `## Relevant Document Context (from uploaded PDFs)
The following content was retrieved from project documents and is relevant to the current question:

${ragContext}

Use this document context to answer questions about contract terms, scope of work, inspection findings, material specs, or any other document content. Always cite the document name when referencing it.

` : ''}## Actions
You can perform data actions by including a single JSON block wrapped in <action></action> tags. Only include one action per response.

Available actions:
- create_project: { type, name*, client, contractValue, startDate (YYYY-MM-DD), phase (membrane/metal/qc/change/retainage/closed), notes }
- update_project_phase: { type, projectName*, phase* }
- update_project: { type, projectName*, fields: { contractValue, client, notes, startDate } }
- close_project: { type, projectName* }
- delete_project: { type, projectName* }
- add_material: { type, projectName*, phase, description*, vendor, amount* }
- update_material: { type, projectName*, description*, amount, newDescription, vendor }
- delete_material: { type, projectName*, description* }
- add_labor: { type, projectName*, phase, employeeName*, hours*, notes }
- update_labor: { type, projectName*, employeeName*, phase, hours, notes }
- delete_labor: { type, projectName*, employeeName*, phase, hours }
- add_change_order: { type, projectName*, description*, amount*, approved (boolean) }
- approve_change_order: { type, projectName*, changeOrderDescription* }
- add_employee: { type, name*, role, rate* }
- update_retainage: { type, projectName*, retainageHeld, retainageReleased }

(* = required)

## Rules
- Be concise and direct. Confirm actions briefly.
- When answering questions from document context, cite the document filename.
- If asked about profitability, calculate from the project data and show a clear breakdown.
- Phases run in order: membrane → metal → qc → change → retainage → closed
- If you cannot find a project or employee by name, say so clearly rather than guessing.
- Do not include <action> tags if the user is just asking a question.
- Never make up document content — only reference what is in the retrieved context above.`;
}

// ── MAIN CHAT FUNCTION ────────────────────────────────────────────────────────
/**
 * Send a message to Ollama with full RAG context.
 *
 * @param {string}   userMessage
 * @param {Array}    history        Array of { role, content } prior messages
 * @param {Object}   projectData    All projects with computed financials
 * @param {Array}    employeeData   All employees
 * @param {string}   projectId      Active project scope for RAG (null = global)
 * @returns {{ text: string, action: Object|null, ragUsed: boolean }}
 */
async function chat(userMessage, history = [], projectData, employeeData, projectId = null) {
  // 1. Retrieve relevant chunks (always on — returns '' if nothing relevant)
  let ragContext = '';
  let ragUsed = false;
  try {
    ragContext = await retrieve(userMessage, projectId);
    ragUsed = ragContext.length > 0;
  } catch (err) {
    // RAG failure is non-fatal — continue without context
    console.warn('[RAG] Retrieval failed, continuing without context:', err.message);
  }

  // 2. Build system prompt
  const systemPrompt = buildSystemPrompt(projectData, employeeData, ragContext);

  // 3. Assemble messages (keep last 10 turns for context window management)
  const recentHistory = history.slice(-10);
  const messages = [
    { role: 'system',    content: systemPrompt },
    ...recentHistory,
    { role: 'user',      content: userMessage },
  ];

  // 4. Call Ollama
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: {
        temperature: 0.3,   // Lower = more precise for structured tasks
        top_p: 0.9,
        num_ctx: 4096,
      },
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const raw = data.message?.content || '';

  // 5. Parse action block if present
  let action = null;
  const actionMatch = raw.match(/<action>([\s\S]*?)<\/action>/);
  if (actionMatch) {
    try {
      action = JSON.parse(actionMatch[1].trim());
    } catch (e) {
      console.warn('[AI] Failed to parse action JSON:', actionMatch[1]);
    }
  }

  // 6. Clean text (remove action block from display)
  const text = raw.replace(/<action>[\s\S]*?<\/action>/g, '').trim();

  return { text, action, ragUsed };
}

// ── EMBEDDING CHECK ───────────────────────────────────────────────────────────
/**
 * Verify nomic-embed-text is available on Ollama.
 * Called at server startup — logs a warning if not found.
 */
async function checkEmbedModel() {
  const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return;
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    const hasEmbed = models.some(m => m.includes('nomic-embed-text'));
    const hasChat  = models.some(m => m.includes(MODEL.split(':')[0]));

    if (!hasEmbed) {
      console.warn(`[AI] WARNING: ${EMBED_MODEL} not found on Ollama. RAG will not work.`);
      console.warn(`[AI] Run: ollama pull ${EMBED_MODEL}`);
    } else {
      console.log(`[AI] ✓ Embed model ready: ${EMBED_MODEL}`);
    }

    if (!hasChat) {
      console.warn(`[AI] WARNING: ${MODEL} not found on Ollama.`);
      console.warn(`[AI] Run: ollama pull ${MODEL}`);
    } else {
      console.log(`[AI] ✓ Chat model ready: ${MODEL}`);
    }
  } catch (err) {
    console.warn('[AI] Could not reach Ollama at startup:', err.message);
  }
}

module.exports = { chat, checkEmbedModel };
