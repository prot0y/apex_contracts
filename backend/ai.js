/**
 * ai.js — Provider-configurable AI agent with schema-enforced structured output.
 *
 * The agent ALWAYS returns a single JSON object:
 *   { "reply": "<natural language for the user>",
 *     "action": { "type": "none" | <action type>, ...fields } }
 *
 * Local (default) uses Ollama with `format` = JSON schema, which grammar-masks the
 * model's tokens so the output is guaranteed-valid JSON. This is what makes a small
 * local model reliable at emitting commands. Cloud providers use their own JSON modes.
 *
 * Switch providers with AI_PROVIDER = ollama | anthropic | openai.
 */

const { retrieve } = require('./rag');

const PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();

// Ollama
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://13.0.2.47:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
const NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX || '8192');

// Cloud
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

// ── ACTION SCHEMA ───────────────────────────────────────────────────────────
// Every action type the executor (server.js) understands. Keep in sync.
const ACTION_TYPES = [
  'none',
  'create_project', 'update_project', 'update_project_phase', 'close_project', 'delete_project',
  'add_material', 'update_material', 'delete_material',
  'add_labor', 'update_labor', 'delete_labor',
  'add_change_order', 'update_change_order', 'approve_change_order', 'delete_change_order',
  'add_employee', 'update_employee', 'delete_employee',
  'update_retainage',
  'create_invoice', 'update_invoice', 'set_invoice_status', 'delete_invoice',
];

// Flat schema: a single object with a type enum + every possible field as optional.
// Grammar-friendly (no discriminated unions) and forgiving for small models.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ACTION_TYPES },
        // project
        name: { type: 'string' },
        client: { type: 'string' },
        contractValue: { type: 'number' },
        startDate: { type: 'string' },
        phase: { type: 'string' },
        notes: { type: 'string' },
        projectName: { type: 'string' },
        fields: { type: 'object' },
        // material / expense
        description: { type: 'string' },
        newDescription: { type: 'string' },
        vendor: { type: 'string' },
        amount: { type: 'number' },
        // labor
        employeeName: { type: 'string' },
        hours: { type: 'number' },
        // change order
        changeOrderDescription: { type: 'string' },
        approved: { type: 'boolean' },
        // employee
        role: { type: 'string' },
        rate: { type: 'number' },
        // retainage
        retainageHeld: { type: 'number' },
        retainageReleased: { type: 'number' },
        // invoice
        invoiceNumber: { type: 'string' },
        status: { type: 'string' },
        issueDate: { type: 'string' },
        dueDate: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
            },
          },
        },
      },
      required: ['type'],
    },
  },
  required: ['reply', 'action'],
};

// ── SYSTEM PROMPT ───────────────────────────────────────────────────────────
function buildSystemPrompt(projectData, employeeData, ragContext) {
  const hasRag = ragContext && ragContext.trim().length > 0;
  return `You are the AI operator for Apex Roofing's contract management system. You manage contracts (projects), expenses (materials & labor), change orders, retainage, employees, and invoices, and you answer questions about profitability and uploaded documents.

You MUST respond with a single JSON object of this exact shape:
{
  "reply": "<concise natural-language message shown to the user>",
  "action": { "type": "<one action type or 'none'>", ...fields }
}

Set action.type to "none" when the user is only asking a question or chatting. Perform at most ONE action per response. Always write a "reply" confirming what you did or answering the question.

## Current Contracts (with computed financials)
${JSON.stringify(projectData, null, 2)}

## Employees
${JSON.stringify(employeeData, null, 2)}
${hasRag ? `\n## Relevant Document Context (from uploaded PDFs)\n${ragContext}\n\nWhen you use this, cite the document filename in your reply.\n` : ''}
## Action types and their fields ( * = required )
- create_project: name*, client, contractValue, startDate (YYYY-MM-DD), phase (membrane|metal|qc|change|retainage|closed), notes
- update_project: projectName*, fields { name, client, contractValue, startDate, notes, phase }
- update_project_phase: projectName*, phase*
- close_project: projectName*
- delete_project: projectName*
- add_material: projectName*, phase, description*, vendor, amount*
- update_material: projectName*, description* (current text to match), amount, newDescription, vendor
- delete_material: projectName*, description*
- add_labor: projectName*, employeeName*, hours*, phase, notes
- update_labor: projectName*, employeeName*, phase, hours, notes
- delete_labor: projectName*, employeeName*, phase, hours
- add_change_order: projectName*, description*, amount*, approved (bool)
- update_change_order: projectName*, changeOrderDescription* (to match), description (new), amount, approved
- approve_change_order: projectName*, changeOrderDescription*
- delete_change_order: projectName*, changeOrderDescription*
- add_employee: name*, role, rate*
- update_employee: employeeName*, fields via name/role/rate
- delete_employee: employeeName*
- update_retainage: projectName*, retainageHeld, retainageReleased
- create_invoice: projectName*, invoiceNumber, status (draft|sent|paid|void), issueDate, dueDate, notes, items:[{description, quantity, unitPrice}]
- update_invoice: projectName* or invoiceNumber*, fields via invoiceNumber/status/issueDate/dueDate/notes/items
- set_invoice_status: invoiceNumber*, status*
- delete_invoice: invoiceNumber*

## Rules
- Phases run in order: membrane -> metal -> qc -> change -> retainage -> closed.
- Match projects/employees by name case-insensitively. If you cannot find one, set action.type="none" and say so in the reply.
- For profit/margin questions, compute from the data above and show a short breakdown in the reply.
- Never invent document content; only reference retrieved context.
- Numbers must be plain numbers (no "$" or commas) in the action.`;
}

// ── JSON EXTRACTION (robust) ────────────────────────────────────────────────
function extractJSON(raw) {
  if (!raw) return null;
  // Direct parse first
  try { return JSON.parse(raw); } catch {}
  // Strip code fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  // Grab the outermost balanced {...}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizeResult(parsed, rawFallback) {
  if (!parsed || typeof parsed !== 'object') {
    return { reply: (rawFallback || '').trim() || 'Sorry — I could not produce a valid response.', action: null };
  }
  let reply = typeof parsed.reply === 'string' ? parsed.reply : (rawFallback || '');
  let action = parsed.action || null;
  // Some models put type at top level or use "action" as a string
  if (action && typeof action === 'object') {
    if (!action.type && action.action) action.type = action.action;
    if (!action.type || action.type === 'none') action = null;
  } else {
    action = null;
  }
  return { reply: (reply || '').trim(), action };
}

// ── PROVIDER CALLS ──────────────────────────────────────────────────────────
async function callOllama(messages) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: RESPONSE_SCHEMA,          // <-- schema-enforced structured output
      options: { temperature: 0.2, top_p: 0.9, num_ctx: NUM_CTX },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content || '';
}

async function callAnthropic(messages) {
  if (!ANTHROPIC_API_KEY) throw new Error('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
  const system = messages.find(m => m.role === 'system')?.content || '';
  const convo = messages.filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  // Prefill an opening brace to force a JSON object response
  convo.push({ role: 'assistant', content: '{' });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 1024, temperature: 0.2,
      system: system + '\n\nRespond with ONLY the JSON object, no prose or code fences.',
      messages: convo,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return '{' + text; // re-attach the prefill
}

async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error('AI_PROVIDER=openai but OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL, temperature: 0.2,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callProvider(messages) {
  switch (PROVIDER) {
    case 'anthropic': return callAnthropic(messages);
    case 'openai':    return callOpenAI(messages);
    case 'ollama':
    default:          return callOllama(messages);
  }
}

// ── MAIN CHAT ───────────────────────────────────────────────────────────────
async function chat(userMessage, history = [], projectData, employeeData, projectId = null) {
  // 1. RAG (non-fatal)
  let ragContext = '';
  let ragUsed = false;
  try {
    ragContext = await retrieve(userMessage, projectId);
    ragUsed = ragContext.length > 0;
  } catch (err) {
    console.warn('[RAG] retrieval failed, continuing:', err.message);
  }

  // 2. Build messages
  const systemPrompt = buildSystemPrompt(projectData, employeeData, ragContext);
  const recentHistory = (history || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
    { role: 'user', content: userMessage },
  ];

  // 3. Call provider (one retry on parse failure for local models)
  let raw = await callProvider(messages);
  let parsed = extractJSON(raw);
  if (!parsed && PROVIDER === 'ollama') {
    console.warn('[AI] First response not parseable, retrying once...');
    raw = await callProvider(messages);
    parsed = extractJSON(raw);
  }

  const { reply, action } = normalizeResult(parsed, raw);
  if (action) console.log('[AI] action:', JSON.stringify(action));

  return { text: reply, action, ragUsed };
}

// ── STARTUP CHECK ─────────────────────────────────────────────────────────────
async function checkEmbedModel() {
  const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
  console.log(`[AI] provider: ${PROVIDER}` +
    (PROVIDER === 'ollama' ? ` (model: ${OLLAMA_MODEL})`
      : PROVIDER === 'anthropic' ? ` (model: ${ANTHROPIC_MODEL})`
      : ` (model: ${OPENAI_MODEL})`));
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return;
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    const hasEmbed = models.some(m => m.includes('nomic-embed-text'));
    if (!hasEmbed) {
      console.warn(`[AI] WARNING: ${EMBED_MODEL} not found on Ollama — RAG/document search will not work.`);
      console.warn(`[AI] Run: ollama pull ${EMBED_MODEL}`);
    } else {
      console.log(`[AI] ✓ Embed model ready: ${EMBED_MODEL}`);
    }
    if (PROVIDER === 'ollama') {
      const base = OLLAMA_MODEL.split(':')[0];
      if (!models.some(m => m.includes(base))) {
        console.warn(`[AI] WARNING: chat model ${OLLAMA_MODEL} not found on Ollama. Run: ollama pull ${OLLAMA_MODEL}`);
      } else {
        console.log(`[AI] ✓ Chat model ready: ${OLLAMA_MODEL}`);
      }
    }
  } catch (err) {
    console.warn('[AI] Could not reach Ollama at startup:', err.message);
  }
}

module.exports = { chat, checkEmbedModel };
