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
// Hard ceiling on any single AI request so a stalled model can never hang the
// chat endpoint (and the UI spinner) forever. Returns a clear error instead.
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '90000');

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
  'add_task', 'update_task', 'complete_task', 'delete_task',
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
        // calendar task
        taskType: { type: 'string', enum: ['itb', 'rfq', 'submittal', 'inspection', 'deadline', 'followup', 'other'] },
        title: { type: 'string' },
        newTitle: { type: 'string' },
        taskStatus: { type: 'string', enum: ['open', 'done', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['type'],
    },
  },
  required: ['reply', 'action'],
};

// ── SYSTEM PROMPT ───────────────────────────────────────────────────────────
// Compact, date-aware summary of open tasks injected into the chat prompt so the
// assistant is always aware of upcoming and overdue deadlines.
function formatTaskSummary(tasks = []) {
  if (!Array.isArray(tasks)) return '';
  const open = tasks.filter(t => t && t.status === 'open');
  if (open.length === 0) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const TYPE_LABEL = { itb: 'ITB', rfq: 'RFQ', submittal: 'Submittal', inspection: 'Inspection', deadline: 'Deadline', followup: 'Follow-up', other: 'Task' };
  const fmtRel = (ymd) => {
    const d = new Date(ymd + 'T00:00:00'); d.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    if (days < 0) return `${-days}d OVERDUE`;
    if (days === 0) return 'due TODAY';
    if (days === 1) return 'due tomorrow';
    return `in ${days}d`;
  };
  const line = (t) => {
    const due = t.dueDate ? `${t.dueDate.slice(0, 10)} (${fmtRel(t.dueDate.slice(0, 10))})` : 'no due date';
    const who = t.client ? ` [${t.client}]` : '';
    return `- ${TYPE_LABEL[t.type] || 'Task'}: ${t.title} — ${due}${t.priority === 'high' ? ' [HIGH]' : ''}${who}`;
  };
  const withDate = open.filter(t => t.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const noDate = open.filter(t => !t.dueDate);
  const lines = [...withDate, ...noDate].slice(0, 25).map(line);
  return `\n## Open Tasks / Calendar (today is ${today.toISOString().slice(0, 10)})\nUse these when the user asks what is due, upcoming, overdue, or this week. Each is a calendar to-do (bid invite, RFQ, inspection, deadline, etc.).\n${lines.join('\n')}\n`;
}

function buildSystemPrompt(projectData, employeeData, ragContext, taskData = []) {
  const hasRag = ragContext && ragContext.trim().length > 0;
  const taskSummary = formatTaskSummary(taskData);
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
${taskSummary}${hasRag ? `\n## Relevant Document Context (from uploaded PDFs)\n${ragContext}\n\nWhen you use this, cite the document filename in your reply.\n` : ''}
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
- add_task: title*, taskType (itb|rfq|submittal|inspection|deadline|followup|other), dueDate (YYYY-MM-DD), projectName, client, priority (low|normal|high), notes
- update_task: title* (current title to match), newTitle, taskType, dueDate, projectName, client, priority, taskStatus, notes
- complete_task: title*
- delete_task: title*

## Task / calendar guidance
- "Invitation to bid" / "ITB" -> taskType "itb". "Request for quote/pricing" / "RFQ" / "RFP" -> taskType "rfq".
  Submittals -> "submittal", inspections -> "inspection", a generic deadline -> "deadline", a reminder to follow up -> "followup".
- A task does NOT need a project. Bid invites and RFQs usually arrive before a contract exists -- leave projectName empty and put the requesting company in "client".
- Today is ${new Date().toISOString().slice(0, 10)}. Resolve relative dates ("Friday", "next week", "in 3 days") to an absolute YYYY-MM-DD using this.

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
async function callOllama(messages, format = RESPONSE_SCHEMA) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,                     // qwen3.5 is a reasoning model; its <think>
                                        // phase loops/stalls under a grammar-constrained
                                        // (format) response, so disable it. We don't need
                                        // chain-of-thought to parse CRUD commands.
      format,                           // schema-enforced structured output
      options: { temperature: 0.2, top_p: 0.9, num_ctx: NUM_CTX, num_predict: 1024 },
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

async function callProvider(messages, format = RESPONSE_SCHEMA) {
  switch (PROVIDER) {
    case 'anthropic': return callAnthropic(messages);   // cloud providers rely on the prompt to shape JSON
    case 'openai':    return callOpenAI(messages);
    case 'ollama':
    default:          return callOllama(messages, format);
  }
}

// ── MAIN CHAT ───────────────────────────────────────────────────────────────
async function chat(userMessage, history = [], projectData, employeeData, projectId = null, taskData = []) {
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
  const systemPrompt = buildSystemPrompt(projectData, employeeData, ragContext, taskData);
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

// ── EMAIL CLASSIFIER (inbound auto-capture) ──────────────────────────────────
// Decides whether an inbound email should become a calendar task, and extracts
// the fields. Used by POST /api/inbound-email.
const EMAIL_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    isActionable: { type: 'boolean' },
    type:     { type: 'string', enum: ['itb', 'rfq', 'submittal', 'inspection', 'deadline', 'followup', 'other'] },
    title:    { type: 'string' },
    client:   { type: 'string' },
    dueDate:  { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    notes:    { type: 'string' },
  },
  required: ['isActionable'],
};

async function classifyEmail({ from = '', subject = '', body = '' }) {
  const today = new Date().toISOString().slice(0, 10);
  const system = `You triage inbound email for a commercial roofing contractor (Apex Roofing) and decide whether it should become a calendar task.

Return ONLY a JSON object: { "isActionable": bool, "type": ..., "title": ..., "client": ..., "dueDate": ..., "priority": ..., "notes": ... }

Set isActionable=true ONLY for mail that implies an action, usually with a date or deadline:
- invitation to bid -> type "itb"
- request for quote / pricing / RFP -> type "rfq"
- submittal request -> "submittal", inspection notice -> "inspection", a stated deadline -> "deadline", a needed follow-up -> "followup"
Newsletters, receipts, marketing, automated notifications, and FYI-only mail are NOT actionable -> isActionable=false (leave other fields empty).

Fields when actionable:
- title: short imperative summary, e.g. "Bid -- Westfield HS gym re-roof".
- client: the sending company / general contractor if identifiable, else "".
- dueDate: bid/response due date as YYYY-MM-DD if stated or clearly inferable, else "". Today is ${today}.
- priority: "high" if due within 5 days or marked urgent, otherwise "normal".
- notes: one or two lines of key detail (location, scope, contact).`;
  const user = `FROM: ${from}\nSUBJECT: ${subject}\n\n${String(body || '').slice(0, 6000)}`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

  let raw = await callProvider(messages, EMAIL_CLASSIFY_SCHEMA);
  let parsed = extractJSON(raw);
  if (!parsed && PROVIDER === 'ollama') {
    raw = await callProvider(messages, EMAIL_CLASSIFY_SCHEMA);
    parsed = extractJSON(raw);
  }
  if (!parsed || typeof parsed.isActionable !== 'boolean') return { isActionable: false };
  return parsed;
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

// Active provider + model, surfaced via /api/health for the UI status line.
function aiInfo() {
  const model = PROVIDER === 'anthropic' ? ANTHROPIC_MODEL
              : PROVIDER === 'openai'    ? OPENAI_MODEL
              :                            OLLAMA_MODEL;
  return { provider: PROVIDER, model };
}

module.exports = { chat, checkEmbedModel, aiInfo, classifyEmail };
