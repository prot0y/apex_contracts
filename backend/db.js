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

module.exports = { db, employees, projects, materials, labor, changeOrders };
