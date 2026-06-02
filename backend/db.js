const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './apex.db';
const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    rate        REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    client              TEXT NOT NULL DEFAULT '',
    contract_value      REAL NOT NULL DEFAULT 0,
    start_date          TEXT,
    phase               TEXT NOT NULL DEFAULT 'membrane',
    notes               TEXT DEFAULT '',
    retainage_held      REAL NOT NULL DEFAULT 0,
    retainage_released  REAL NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS materials (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase       TEXT NOT NULL,
    description TEXT NOT NULL,
    vendor      TEXT DEFAULT '',
    amount      REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS labor (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase       TEXT NOT NULL,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    hours       REAL NOT NULL DEFAULT 0,
    notes       TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS change_orders (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount      REAL NOT NULL DEFAULT 0,
    approved    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | paid | void
    issue_date  TEXT,
    due_date    TEXT,
    notes       TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoice_items (
    id          TEXT PRIMARY KEY,
    invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description TEXT NOT NULL DEFAULT '',
    quantity    REAL NOT NULL DEFAULT 1,
    unit_price  REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── ID HELPER ────────────────────────────────────────────────────────────────
function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── EMPLOYEES ────────────────────────────────────────────────────────────────
const employees = {
  all: () => db.prepare('SELECT * FROM employees ORDER BY name').all(),

  get: (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(id),

  create: ({ name, role = '', rate = 0 }) => {
    const id = uid('e');
    db.prepare('INSERT INTO employees (id, name, role, rate) VALUES (?, ?, ?, ?)').run(id, name, role, rate);
    return employees.get(id);
  },

  update: (id, fields) => {
    const allowed = ['name', 'role', 'rate'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`).join(', ');
    const vals = Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]);
    if (!sets) return employees.get(id);
    db.prepare(`UPDATE employees SET ${sets} WHERE id = ?`).run(...vals, id);
    return employees.get(id);
  },

  delete: (id) => db.prepare('DELETE FROM employees WHERE id = ?').run(id),
};

// ── PROJECTS ─────────────────────────────────────────────────────────────────
const projects = {
  all: () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return rows.map(projects._hydrate);
  },

  get: (id) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) return null;
    return projects._hydrate(row);
  },

  _hydrate: (row) => {
    const mats = db.prepare('SELECT * FROM materials WHERE project_id = ? ORDER BY created_at').all(row.id);
    const labs = db.prepare('SELECT * FROM labor WHERE project_id = ? ORDER BY created_at').all(row.id);
    const cos  = db.prepare('SELECT * FROM change_orders WHERE project_id = ? ORDER BY created_at').all(row.id);
    const PHASES = ['membrane','metal','qc','change','retainage','closed'];

    const phases = {};
    PHASES.forEach(ph => {
      phases[ph] = {
        materials: mats.filter(m => m.phase === ph).map(m => ({
          id: m.id, desc: m.description, vendor: m.vendor, amount: m.amount
        })),
        labor: labs.filter(l => l.phase === ph).map(l => ({
          id: l.id, employeeId: l.employee_id, hours: l.hours, notes: l.notes
        })),
      };
    });

    return {
      id: row.id,
      name: row.name,
      client: row.client,
      contractValue: row.contract_value,
      startDate: row.start_date,
      phase: row.phase,
      notes: row.notes,
      retainageHeld: row.retainage_held,
      retainageReleased: row.retainage_released,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      changeOrders: cos.map(c => ({
        id: c.id, description: c.description, amount: c.amount, approved: c.approved === 1
      })),
      phases,
    };
  },

  create: ({ name, client = '', contractValue = 0, startDate = null, phase = 'membrane', notes = '' }) => {
    const id = uid('p');
    db.prepare(`
      INSERT INTO projects (id, name, client, contract_value, start_date, phase, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, client, contractValue, startDate, phase, notes);
    return projects.get(id);
  },

  update: (id, fields) => {
    const map = {
      name: 'name', client: 'client', contractValue: 'contract_value',
      startDate: 'start_date', phase: 'phase', notes: 'notes',
      retainageHeld: 'retainage_held', retainageReleased: 'retainage_released',
    };
    const sets = Object.keys(fields)
      .filter(k => map[k])
      .map(k => `${map[k]} = ?`)
      .concat(["updated_at = datetime('now')"]);
    const vals = Object.keys(fields).filter(k => map[k]).map(k => fields[k]);
    if (sets.length === 1) return projects.get(id); // only updated_at
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return projects.get(id);
  },

  delete: (id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id),
};

// ── MATERIALS ────────────────────────────────────────────────────────────────
const materials = {
  create: ({ projectId, phase, desc, vendor = '', amount = 0 }) => {
    const id = uid('m');
    db.prepare('INSERT INTO materials (id, project_id, phase, description, vendor, amount) VALUES (?,?,?,?,?,?)')
      .run(id, projectId, phase, desc, vendor, amount);
    return { id, projectId, phase, desc, vendor, amount };
  },
  update: (id, fields) => {
    if (fields.desc !== undefined) db.prepare('UPDATE materials SET description = ? WHERE id = ?').run(fields.desc, id);
    if (fields.vendor !== undefined) db.prepare('UPDATE materials SET vendor = ? WHERE id = ?').run(fields.vendor, id);
    if (fields.amount !== undefined) db.prepare('UPDATE materials SET amount = ? WHERE id = ?').run(fields.amount, id);
  },
  delete: (id) => db.prepare('DELETE FROM materials WHERE id = ?').run(id),
};

// ── LABOR ────────────────────────────────────────────────────────────────────
const labor = {
  create: ({ projectId, phase, employeeId, hours = 0, notes = '' }) => {
    const id = uid('l');
    db.prepare('INSERT INTO labor (id, project_id, phase, employee_id, hours, notes) VALUES (?,?,?,?,?,?)')
      .run(id, projectId, phase, employeeId, hours, notes);
    return { id, projectId, phase, employeeId, hours, notes };
  },
  update: (id, fields) => {
    if (fields.hours !== undefined) db.prepare('UPDATE labor SET hours = ? WHERE id = ?').run(fields.hours, id);
    if (fields.notes !== undefined) db.prepare('UPDATE labor SET notes = ? WHERE id = ?').run(fields.notes, id);
    if (fields.employeeId !== undefined) db.prepare('UPDATE labor SET employee_id = ? WHERE id = ?').run(fields.employeeId, id);
  },
  delete: (id) => db.prepare('DELETE FROM labor WHERE id = ?').run(id),
};

// ── CHANGE ORDERS ────────────────────────────────────────────────────────────
const changeOrders = {
  create: ({ projectId, description, amount = 0, approved = false }) => {
    const id = uid('co');
    db.prepare('INSERT INTO change_orders (id, project_id, description, amount, approved) VALUES (?,?,?,?,?)')
      .run(id, projectId, description, amount, approved ? 1 : 0);
    return { id, projectId, description, amount, approved };
  },
  update: (id, fields) => {
    if (fields.approved !== undefined) {
      db.prepare('UPDATE change_orders SET approved = ? WHERE id = ?').run(fields.approved ? 1 : 0, id);
    }
    if (fields.amount !== undefined) {
      db.prepare('UPDATE change_orders SET amount = ? WHERE id = ?').run(fields.amount, id);
    }
    if (fields.description !== undefined) {
      db.prepare('UPDATE change_orders SET description = ? WHERE id = ?').run(fields.description, id);
    }
  },
  delete: (id) => db.prepare('DELETE FROM change_orders WHERE id = ?').run(id),
};

// ── INVOICES ─────────────────────────────────────────────────────────────────
const VALID_INVOICE_STATUS = ['draft', 'sent', 'paid', 'void'];

const invoices = {
  _hydrate: (row) => {
    if (!row) return null;
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY created_at').all(row.id)
      .map(it => ({
        id: it.id,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unit_price,
        amount: parseFloat((it.quantity * it.unit_price).toFixed(2)),
      }));
    const total = parseFloat(items.reduce((s, it) => s + it.amount, 0).toFixed(2));
    return {
      id: row.id,
      projectId: row.project_id,
      number: row.number,
      status: row.status,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items,
      total,
    };
  },

  all: (projectId = null) => {
    const rows = projectId
      ? db.prepare('SELECT * FROM invoices WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all();
    return rows.map(invoices._hydrate);
  },

  get: (id) => invoices._hydrate(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id)),

  // Auto-generate a sequential-ish invoice number when not supplied.
  _nextNumber: () => {
    const n = db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c + 1;
    return `INV-${String(n).padStart(4, '0')}`;
  },

  create: ({ projectId, number, status = 'draft', issueDate = null, dueDate = null, notes = '', items = [] }) => {
    if (!projectId) throw new Error('projectId is required');
    const safeStatus = VALID_INVOICE_STATUS.includes(status) ? status : 'draft';
    const id = uid('inv');
    const num = (number && String(number).trim()) ? String(number).trim() : invoices._nextNumber();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO invoices (id, project_id, number, status, issue_date, due_date, notes)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(id, projectId, num, safeStatus, issueDate, dueDate, notes);
      (items || []).forEach(it => invoices._insertItem(id, it));
    });
    tx();
    return invoices.get(id);
  },

  update: (id, fields) => {
    const map = {
      number: 'number', status: 'status', issueDate: 'issue_date',
      dueDate: 'due_date', notes: 'notes',
    };
    if (fields.status && !VALID_INVOICE_STATUS.includes(fields.status)) {
      throw new Error(`Invalid status "${fields.status}". Use one of: ${VALID_INVOICE_STATUS.join(', ')}`);
    }
    const sets = Object.keys(fields).filter(k => map[k]).map(k => `${map[k]} = ?`)
      .concat(["updated_at = datetime('now')"]);
    const vals = Object.keys(fields).filter(k => map[k]).map(k => fields[k]);
    if (sets.length > 1) {
      db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    // Full replace of line items when an `items` array is supplied
    if (Array.isArray(fields.items)) {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
        fields.items.forEach(it => invoices._insertItem(id, it));
        db.prepare("UPDATE invoices SET updated_at = datetime('now') WHERE id = ?").run(id);
      });
      tx();
    }
    return invoices.get(id);
  },

  delete: (id) => db.prepare('DELETE FROM invoices WHERE id = ?').run(id),

  // ── line item helpers ──
  _insertItem: (invoiceId, { description = '', quantity = 1, unitPrice = 0 }) => {
    const id = uid('ii');
    db.prepare('INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price) VALUES (?,?,?,?,?)')
      .run(id, invoiceId, description, quantity, unitPrice);
    return id;
  },
  addItem: (invoiceId, item) => {
    const id = invoices._insertItem(invoiceId, item);
    db.prepare("UPDATE invoices SET updated_at = datetime('now') WHERE id = ?").run(invoiceId);
    return invoices.get(invoiceId);
  },
  updateItem: (itemId, fields) => {
    if (fields.description !== undefined) db.prepare('UPDATE invoice_items SET description = ? WHERE id = ?').run(fields.description, itemId);
    if (fields.quantity !== undefined)    db.prepare('UPDATE invoice_items SET quantity = ? WHERE id = ?').run(fields.quantity, itemId);
    if (fields.unitPrice !== undefined)   db.prepare('UPDATE invoice_items SET unit_price = ? WHERE id = ?').run(fields.unitPrice, itemId);
  },
  deleteItem: (itemId) => db.prepare('DELETE FROM invoice_items WHERE id = ?').run(itemId),
};

// -- GRACEFUL SHUTDOWN
// SQLite WAL mode buffers writes in apex.db-wal. Without an explicit checkpoint
// on exit, a sudden container stop (SIGTERM) can leave the WAL inconsistent.
function shutdown() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (e) {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

module.exports = { db, employees, projects, materials, labor, changeOrders, invoices };
