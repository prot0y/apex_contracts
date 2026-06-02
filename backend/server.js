/**
 * server.js — Apex Contracts API
 *
 * Routes:
 *   GET    /api/health
 *   GET    /api/employees
 *   POST   /api/employees
 *   PUT    /api/employees/:id
 *   DELETE /api/employees/:id
 *   GET    /api/projects
 *   POST   /api/projects
 *   PUT    /api/projects/:id
 *   DELETE /api/projects/:id
 *   POST   /api/projects/:id/materials
 *   DELETE /api/projects/:id/materials/:matId
 *   POST   /api/projects/:id/labor
 *   DELETE /api/projects/:id/labor/:labId
 *   POST   /api/projects/:id/change-orders
 *   PUT    /api/projects/:id/change-orders/:coId
 *   DELETE /api/projects/:id/change-orders/:coId
 *   POST   /api/projects/:id/documents        ← PDF upload + ingest
 *   GET    /api/projects/:id/documents        ← list docs for project
 *   DELETE /api/projects/:id/documents/:docId ← remove doc + vectors
 *   POST   /api/chat                          ← RAG-aware AI chat
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

const db             = require('./db');
const { chat, checkEmbedModel, aiInfo } = require('./ai');
const { ingestPDF, deleteDocument, listDocuments } = require('./rag');

const app  = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_PATH = process.env.UPLOAD_PATH || '/data/uploads';
fs.mkdirSync(UPLOAD_PATH, { recursive: true });

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve frontend
const FRONTEND = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND));

// ── FILE UPLOAD CONFIG ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_PATH),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
const uid = (prefix = '') => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function calcProject(p, empMap) {
  const PHASES = ['membrane','metal','qc','change','retainage','closed'];
  let totalMaterials = 0, totalLabor = 0;
  PHASES.forEach(ph => {
    const phase = p.phases[ph] || { materials: [], labor: [] };
    phase.materials.forEach(m => { totalMaterials += m.amount; });
    phase.labor.forEach(l => {
      const emp = empMap[l.employeeId];
      if (emp) totalLabor += emp.rate * l.hours;
    });
  });
  const approvedCOs = (p.changeOrders || []).filter(co => co.approved).reduce((s, co) => s + co.amount, 0);
  const totalRevenue = p.contractValue + approvedCOs;
  const totalCost    = totalMaterials + totalLabor;
  const gross        = totalRevenue - totalCost;
  const margin       = totalRevenue > 0 ? (gross / totalRevenue) * 100 : 0;
  return { totalMaterials, totalLabor, totalRevenue, totalCost, gross, margin: parseFloat(margin.toFixed(1)) };
}

function getEnrichedProjects() {
  const emps = db.employees.all();
  const empMap = Object.fromEntries(emps.map(e => [e.id, e]));
  return db.projects.all().map(p => ({ ...p, ...calcProject(p, empMap) }));
}

// ── ACTION EXECUTOR ───────────────────────────────────────────────────────────
function executeAction(action, projects, employees) {
  const findProject = (name, id) => {
    if (id) return projects.find(p => p.id === id);
    if (!name) return null;
    const nl = name.toLowerCase();
    return projects.find(p => p.name.toLowerCase().includes(nl));
  };
  const findEmployee = (name, id) => {
    if (id) return employees.find(e => e.id === id);
    if (!name) return null;
    const nl = name.toLowerCase();
    return employees.find(e => e.name.toLowerCase().includes(nl));
  };
  // Locate an invoice by its number (preferred) or by the most recent on a project.
  const findInvoice = (a) => {
    const all = db.invoices.all();
    if (a.invoiceNumber) {
      const nl = String(a.invoiceNumber).toLowerCase();
      const hit = all.find(i => (i.number || '').toLowerCase() === nl)
               || all.find(i => (i.number || '').toLowerCase().includes(nl));
      if (hit) return hit;
    }
    if (a.projectName || a.projectId) {
      const p = findProject(a.projectName, a.projectId);
      if (p) return all.find(i => i.projectId === p.id) || null;
    }
    return null;
  };

  switch (action.type) {
    case 'create_project': {
      const p = db.projects.create({
        name: action.name, client: action.client || '',
        contractValue: action.contractValue || 0,
        startDate: action.startDate || null,
        phase: action.phase || 'membrane',
        notes: action.notes || '',
      });
      return { ok: true, message: `Created contract: ${p.name}`, data: p };
    }

    case 'update_project_phase': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const updated = db.projects.update(p.id, { phase: action.phase });
      return { ok: true, message: `Moved "${p.name}" to ${action.phase} phase`, data: updated };
    }

    case 'update_project': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const updated = db.projects.update(p.id, action.fields || {});
      return { ok: true, message: `Updated "${p.name}"`, data: updated };
    }

    case 'add_material': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const phase = action.phase || p.phase;
      const mat = db.materials.create({
        projectId: p.id, phase,
        desc: action.description, vendor: action.vendor || '',
        amount: action.amount || 0,
      });
      return { ok: true, message: `Added material "${action.description}" ($${action.amount?.toLocaleString()}) to ${p.name} — ${phase}` };
    }

    case 'add_labor': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const emp = findEmployee(action.employeeName, action.employeeId);
      if (!emp) return { ok: false, message: `Employee not found: ${action.employeeName}` };
      const phase = action.phase || p.phase;
      db.labor.create({
        projectId: p.id, phase,
        employeeId: emp.id, hours: action.hours || 0, notes: action.notes || '',
      });
      const cost = emp.rate * (action.hours || 0);
      return { ok: true, message: `Logged ${action.hours}h for ${emp.name} on ${p.name} — ${phase} ($${cost.toLocaleString()})` };
    }

    case 'add_change_order': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      db.changeOrders.create({
        projectId: p.id, description: action.description,
        amount: action.amount || 0, approved: action.approved || false,
      });
      return { ok: true, message: `Added change order "${action.description}" ($${action.amount?.toLocaleString()}) to ${p.name}` };
    }

    case 'approve_change_order': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const co = p.changeOrders.find(c =>
        c.description.toLowerCase().includes(action.changeOrderDescription?.toLowerCase())
      );
      if (!co) return { ok: false, message: `Change order not found: ${action.changeOrderDescription}` };
      db.changeOrders.update(co.id, { approved: true });
      return { ok: true, message: `Approved change order "${co.description}" on ${p.name}` };
    }

    case 'add_employee': {
      const emp = db.employees.create({ name: action.name, role: action.role || '', rate: action.rate || 0 });
      return { ok: true, message: `Added employee ${emp.name} at $${emp.rate}/hr`, data: emp };
    }

    case 'update_retainage': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const fields = {};
      if (action.retainageHeld     !== undefined) fields.retainageHeld     = action.retainageHeld;
      if (action.retainageReleased !== undefined) fields.retainageReleased = action.retainageReleased;
      db.projects.update(p.id, fields);
      return { ok: true, message: `Updated retainage for ${p.name}` };
    }

    case 'delete_project': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      db.projects.delete(p.id);
      return { ok: true, message: `Deleted contract "${p.name}" and all associated data` };
    }

    case 'close_project': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      db.projects.update(p.id, { phase: 'closed' });
      return { ok: true, message: `Marked "${p.name}" as closed` };
    }

    case 'delete_material': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      // Search across all phases for matching material
      let found = null;
      const PHASES = ['membrane','metal','qc','change','retainage','closed'];
      for (const ph of PHASES) {
        const match = (p.phases[ph]?.materials || []).find(m =>
          m.desc.toLowerCase().includes(action.description?.toLowerCase())
        );
        if (match) { found = match; break; }
      }
      if (!found) return { ok: false, message: `Material matching "${action.description}" not found on ${p.name}` };
      db.materials.delete(found.id);
      return { ok: true, message: `Deleted material "${found.desc}" ($${found.amount.toLocaleString()}) from ${p.name}` };
    }

    case 'update_material': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      // Find material across all phases
      let found = null;
      const PHASES = ['membrane','metal','qc','change','retainage','closed'];
      for (const ph of PHASES) {
        const match = (p.phases[ph]?.materials || []).find(m =>
          m.desc.toLowerCase().includes(action.description?.toLowerCase())
        );
        if (match) { found = match; break; }
      }
      if (!found) return { ok: false, message: `Material matching "${action.description}" not found on ${p.name}` };
      const oldAmount = found.amount;
      db.db.prepare('UPDATE materials SET amount = ?, description = ?, vendor = ? WHERE id = ?').run(
        action.amount !== undefined ? action.amount : found.amount,
        action.newDescription || found.desc,
        action.vendor || found.vendor,
        found.id
      );
      const newAmount = action.amount !== undefined ? action.amount : found.amount;
      return { ok: true, message: `Updated "${found.desc}" on ${p.name}: $${oldAmount.toLocaleString()} → $${newAmount.toLocaleString()}` };
    }

    case 'delete_labor': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const emp = action.employeeName ? findEmployee(action.employeeName) : null;
      // Find labor entry across all phases
      let found = null;
      const PHASES = ['membrane','metal','qc','change','retainage','closed'];
      for (const ph of PHASES) {
        const entries = p.phases[ph]?.labor || [];
        const match = entries.find(l => {
          const empMatch = emp ? l.employeeId === emp.id : true;
          const hoursMatch = action.hours ? l.hours === action.hours : true;
          const phaseMatch = action.phase ? ph === action.phase : true;
          return empMatch && hoursMatch && phaseMatch;
        });
        if (match) { found = { ...match, phase: ph }; break; }
      }
      if (!found) return { ok: false, message: `Labor entry not found on ${p.name}` };
      db.labor.delete(found.id);
      const empName = employees.find(e => e.id === found.employeeId)?.name || found.employeeId;
      return { ok: true, message: `Deleted labor entry: ${empName} ${found.hours}h on ${p.name} — ${found.phase}` };
    }

    case 'update_labor': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const emp = action.employeeName ? findEmployee(action.employeeName) : null;
      let found = null;
      const PHASES = ['membrane','metal','qc','change','retainage','closed'];
      for (const ph of PHASES) {
        const entries = p.phases[ph]?.labor || [];
        const match = entries.find(l => {
          const empMatch = emp ? l.employeeId === emp.id : true;
          const phaseMatch = action.phase ? ph === action.phase : true;
          return empMatch && phaseMatch;
        });
        if (match) { found = { ...match, phase: ph }; break; }
      }
      if (!found) return { ok: false, message: `Labor entry not found on ${p.name}` };
      const oldHours = found.hours;
      db.db.prepare('UPDATE labor SET hours = ?, notes = ? WHERE id = ?').run(
        action.hours !== undefined ? action.hours : found.hours,
        action.notes !== undefined ? action.notes : found.notes,
        found.id
      );
      const empName = employees.find(e => e.id === found.employeeId)?.name || found.employeeId;
      return { ok: true, message: `Updated ${empName} labor on ${p.name}: ${oldHours}h → ${action.hours}h` };
    }

    case 'update_change_order': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const co = p.changeOrders.find(c => c.description.toLowerCase().includes((action.changeOrderDescription || '').toLowerCase()));
      if (!co) return { ok: false, message: `Change order not found: ${action.changeOrderDescription}` };
      const fields = {};
      if (action.description !== undefined) fields.description = action.description;
      if (action.amount !== undefined) fields.amount = action.amount;
      if (action.approved !== undefined) fields.approved = action.approved;
      db.changeOrders.update(co.id, fields);
      return { ok: true, message: `Updated change order "${co.description}" on ${p.name}` };
    }

    case 'delete_change_order': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const co = p.changeOrders.find(c => c.description.toLowerCase().includes((action.changeOrderDescription || '').toLowerCase()));
      if (!co) return { ok: false, message: `Change order not found: ${action.changeOrderDescription}` };
      db.changeOrders.delete(co.id);
      return { ok: true, message: `Deleted change order "${co.description}" from ${p.name}` };
    }

    case 'update_employee': {
      const emp = findEmployee(action.employeeName, action.employeeId);
      if (!emp) return { ok: false, message: `Employee not found: ${action.employeeName}` };
      const fields = action.fields || {};
      if (action.name !== undefined) fields.name = action.name;
      if (action.role !== undefined) fields.role = action.role;
      if (action.rate !== undefined) fields.rate = action.rate;
      const updated = db.employees.update(emp.id, fields);
      return { ok: true, message: `Updated employee ${updated.name}`, data: updated };
    }

    case 'delete_employee': {
      const emp = findEmployee(action.employeeName, action.employeeId);
      if (!emp) return { ok: false, message: `Employee not found: ${action.employeeName}` };
      db.employees.delete(emp.id);
      return { ok: true, message: `Deleted employee ${emp.name}` };
    }

    case 'create_invoice': {
      const p = findProject(action.projectName, action.projectId);
      if (!p) return { ok: false, message: `Project not found: ${action.projectName}` };
      const inv = db.invoices.create({
        projectId: p.id,
        number: action.invoiceNumber,
        status: action.status || 'draft',
        issueDate: action.issueDate || null,
        dueDate: action.dueDate || null,
        notes: action.notes || '',
        items: action.items || [],
      });
      return { ok: true, message: `Created invoice ${inv.number} for ${p.name} ($${inv.total.toLocaleString()})`, data: inv };
    }

    case 'update_invoice': {
      const inv = findInvoice(action);
      if (!inv) return { ok: false, message: `Invoice not found: ${action.invoiceNumber || action.projectName}` };
      const fields = action.fields || {};
      if (action.invoiceNumber !== undefined && action.fields?.invoiceNumber === undefined && !action.number) {
        // invoiceNumber here is used to locate, not rename — skip
      }
      if (action.status !== undefined) fields.status = action.status;
      if (action.issueDate !== undefined) fields.issueDate = action.issueDate;
      if (action.dueDate !== undefined) fields.dueDate = action.dueDate;
      if (action.notes !== undefined) fields.notes = action.notes;
      if (Array.isArray(action.items)) fields.items = action.items;
      const updated = db.invoices.update(inv.id, fields);
      return { ok: true, message: `Updated invoice ${updated.number}`, data: updated };
    }

    case 'set_invoice_status': {
      const inv = findInvoice(action);
      if (!inv) return { ok: false, message: `Invoice not found: ${action.invoiceNumber}` };
      try {
        const updated = db.invoices.update(inv.id, { status: action.status });
        return { ok: true, message: `Invoice ${updated.number} marked ${updated.status}`, data: updated };
      } catch (e) { return { ok: false, message: e.message }; }
    }

    case 'delete_invoice': {
      const inv = findInvoice(action);
      if (!inv) return { ok: false, message: `Invoice not found: ${action.invoiceNumber}` };
      db.invoices.delete(inv.id);
      return { ok: true, message: `Deleted invoice ${inv.number}` };
    }

    default:
      return { ok: false, message: `Unknown action type: ${action.type}` };
  }
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), ...aiInfo() });
});

// ── EMPLOYEES ─────────────────────────────────────────────────────────────────
app.get('/api/employees', (req, res) => {
  res.json(db.employees.all());
});

app.post('/api/employees', (req, res) => {
  try {
    const emp = db.employees.create(req.body);
    res.status(201).json(emp);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/employees/:id', (req, res) => {
  const emp = db.employees.update(req.params.id, req.body);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  res.json(emp);
});

app.delete('/api/employees/:id', (req, res) => {
  db.employees.delete(req.params.id);
  res.json({ ok: true });
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  try { res.json(db.projects.all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', (req, res) => {
  try {
    const p = db.projects.create(req.body);
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/projects/:id', (req, res) => {
  const p = db.projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.put('/api/projects/:id', (req, res) => {
  const p = db.projects.update(req.params.id, req.body);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.delete('/api/projects/:id', (req, res) => {
  db.projects.delete(req.params.id);
  res.json({ ok: true });
});

// ── MATERIALS ─────────────────────────────────────────────────────────────────
app.post('/api/projects/:id/materials', (req, res) => {
  try {
    const mat = db.materials.create({ projectId: req.params.id, ...req.body });
    res.status(201).json(mat);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/projects/:id/materials/:matId', (req, res) => {
  try {
    db.materials.update(req.params.matId, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/projects/:id/materials/:matId', (req, res) => {
  db.materials.delete(req.params.matId);
  res.json({ ok: true });
});

// ── LABOR ─────────────────────────────────────────────────────────────────────
app.post('/api/projects/:id/labor', (req, res) => {
  try {
    const entry = db.labor.create({ projectId: req.params.id, ...req.body });
    res.status(201).json(entry);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/projects/:id/labor/:labId', (req, res) => {
  try {
    db.labor.update(req.params.labId, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/projects/:id/labor/:labId', (req, res) => {
  db.labor.delete(req.params.labId);
  res.json({ ok: true });
});

// ── CHANGE ORDERS ─────────────────────────────────────────────────────────────
app.post('/api/projects/:id/change-orders', (req, res) => {
  try {
    const co = db.changeOrders.create({ projectId: req.params.id, ...req.body });
    res.status(201).json(co);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/projects/:id/change-orders/:coId', (req, res) => {
  db.changeOrders.update(req.params.coId, req.body);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/change-orders/:coId', (req, res) => {
  db.changeOrders.delete(req.params.coId);
  res.json({ ok: true });
});

// ── INVOICES ──────────────────────────────────────────────────────────────────
// List all invoices (optionally scoped to a project via /api/projects/:id/invoices)
app.get('/api/invoices', (req, res) => {
  try { res.json(db.invoices.all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id/invoices', (req, res) => {
  try { res.json(db.invoices.all(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:invId', (req, res) => {
  const inv = db.invoices.get(req.params.invId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

app.post('/api/projects/:id/invoices', (req, res) => {
  try {
    const project = db.projects.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const inv = db.invoices.create({ projectId: req.params.id, ...req.body });
    res.status(201).json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/invoices/:invId', (req, res) => {
  try {
    const inv = db.invoices.update(req.params.invId, req.body);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    res.json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/invoices/:invId', (req, res) => {
  db.invoices.delete(req.params.invId);
  res.json({ ok: true });
});

// Line items
app.post('/api/invoices/:invId/items', (req, res) => {
  try { res.status(201).json(db.invoices.addItem(req.params.invId, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/invoices/:invId/items/:itemId', (req, res) => {
  try { db.invoices.updateItem(req.params.itemId, req.body); res.json(db.invoices.get(req.params.invId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/invoices/:invId/items/:itemId', (req, res) => {
  db.invoices.deleteItem(req.params.itemId);
  res.json(db.invoices.get(req.params.invId));
});

// ── DOCUMENTS (RAG) ───────────────────────────────────────────────────────────
app.get('/api/projects/:id/documents', async (req, res) => {
  try {
    const docs = await listDocuments(req.params.id);
    res.json(docs);
  } catch (e) {
    console.error('[DOC LIST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/documents', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const projectId = req.params.id;
  const project   = db.projects.get(projectId);
  if (!project) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Project not found' });
  }

  const docId    = uid('doc');
  const filePath = req.file.path;
  const filename = req.file.originalname;

  try {
    console.log(`[DOC] Ingesting "${filename}" for project ${projectId}...`);
    const result = await ingestPDF(filePath, projectId, filename, docId);
    console.log(`[DOC] Ingested ${result.chunks} chunks from ${result.pages} pages`);

    res.status(201).json({
      docId,
      filename,
      chunks: result.chunks,
      pages: result.pages,
      projectId,
    });
  } catch (e) {
    console.error('[DOC INGEST]', e.message);
    // Clean up uploaded file on failure
    try { fs.unlinkSync(filePath); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id/documents/:docId', async (req, res) => {
  try {
    await deleteDocument(req.params.docId);

    // Also remove the file from disk if it exists
    const files = fs.readdirSync(UPLOAD_PATH)
      .filter(f => f.includes(req.params.docId));
    files.forEach(f => {
      try { fs.unlinkSync(path.join(UPLOAD_PATH, f)); } catch {}
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CHAT ──────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [], projectId = null } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  try {
    const projects   = getEnrichedProjects();
    const employees  = db.employees.all();

    const { text, action, ragUsed } = await chat(
      message, history, projects, employees, projectId
    );

    let actionResult = null;
    if (action) {
      // Re-fetch fresh data before executing action
      const freshProjects  = db.projects.all();
      const freshEmployees = db.employees.all();
      actionResult = executeAction(action, freshProjects, freshEmployees);
    }

    res.json({
      text,
      action,
      actionResult,
      ragUsed,
    });
  } catch (e) {
    console.error('[CHAT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SPA FALLBACK ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND, 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🏗  Apex Contracts running on http://localhost:${PORT}`);
  console.log(`   DB:      ${process.env.DB_PATH}`);
  console.log(`   Ollama:  ${process.env.OLLAMA_HOST}`);
  console.log(`   Chroma:  ${process.env.CHROMA_HOST}`);
  console.log(`   Uploads: ${UPLOAD_PATH}\n`);
  await checkEmbedModel();
});
