const NO_UPDATED_DATE = new Set(['chat_messages','notifications','task_submissions','xp_logs','referrals']);

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const JSON_COLS = {
  users: ['top_categories'],
  applications: ['pod_members', 'performance_snapshot'],
};

const BOOL_COLS = {
  jobs: ['escrow_funded', 'escrow_taken', 'escrow_release_pending', 'escrow_released', 'extension_requested'],
  kpis: ['is_primary'],
  applications: ['is_pod'],
  notifications: ['is_read'],
  tasks: ['is_active'],
};

function deserialize(table, row) {
  if (!row) return null;
  const out = { ...row };
  delete out.password_hash;
  for (const c of (JSON_COLS[table] || [])) {
    if (out[c] !== undefined) {
      try { out[c] = JSON.parse(out[c]); } catch { out[c] = []; }
    }
  }
  for (const c of (BOOL_COLS[table] || [])) {
    if (out[c] !== undefined) out[c] = out[c] === true || out[c] === 1 || out[c] === 't' || out[c] === 'true';
  }
  return out;
}

function serialize(table, data) {
  const out = { ...data };
  for (const c of (JSON_COLS[table] || [])) {
    if (out[c] !== undefined) out[c] = JSON.stringify(out[c]);
  }
  for (const c of (BOOL_COLS[table] || [])) {
    if (out[c] !== undefined) out[c] = Boolean(out[c]) ? true : false;
  }
  return out;
}

function buildEntityRouter(table, hooks = {}) {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    const db = getDb();
    const { _sort, _limit, ...filters } = req.query;
    let sql = `SELECT * FROM ${table} WHERE 1=1`;
    const params = [];
    for (const [k, v] of Object.entries(filters)) {
      sql += ` AND \`${k}\` = ?`;
      params.push(v);
    }
    if (_sort) {
      const desc = _sort.startsWith('-');
      sql += ` ORDER BY \`${desc ? _sort.slice(1) : _sort}\` ${desc ? 'DESC' : 'ASC'}`;
    } else {
      sql += ` ORDER BY created_date DESC`;
    }
    if (_limit) sql += ` LIMIT ${parseInt(_limit)}`;
    const rows = await db.all(sql, ...params);
    res.json(rows.map(r => deserialize(table, r)));
  });

  router.get('/:id', authMiddleware, async (req, res) => {
    const row = await getDb().get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    res.json(deserialize(table, row));
  });

  router.post('/', authMiddleware, async (req, res) => {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const id = uuidv4();
      const raw = serialize(table, req.body);
      const hasUpdated = !NO_UPDATED_DATE.has(table);
      const data = { id, created_date: now, ...(hasUpdated ? { updated_date: now } : {}), ...raw };
      if (hooks.beforeCreate) await hooks.beforeCreate(db, data, req);
      const cols = Object.keys(data);
      await db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map(c => data[c]));
      if (hooks.afterCreate) await hooks.afterCreate(db, data, req);
      const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
      res.status(201).json(deserialize(table, row));
    } catch (err) {
      res.status(err.statusCode || 400).json({ message: err.message });
    }
  });

  router.post('/bulk', authMiddleware, async (req, res) => {
    const db = getDb();
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const results = [];
    const tx = db.transaction(async () => {
      const now = new Date().toISOString();
      for (const item of items) {
        const id = uuidv4();
        const raw = serialize(table, item);
        const hasUpdated = !NO_UPDATED_DATE.has(table);
        const data = { id, created_date: now, ...(hasUpdated ? { updated_date: now } : {}), ...raw };
        const cols = Object.keys(data);
        await db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map(c => data[c]));
        const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
        results.push(row);
      }
    });
    try {
      await tx();
      res.status(201).json(results.map(r => deserialize(table, r)));
    } catch (err) {
      res.status(err.statusCode || 400).json({ message: err.message });
    }
  });

  router.patch('/:id', authMiddleware, async (req, res) => {
    try {
      const db = getDb();
      const existing = await db.get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id);
      if (!existing) return res.status(404).json({ message: 'Not found' });
      const raw = serialize(table, req.body);
      if (!NO_UPDATED_DATE.has(table)) raw.updated_date = new Date().toISOString();
      if (hooks.beforeUpdate) await hooks.beforeUpdate(db, req.params.id, raw, req, existing);
      const sets = Object.keys(raw).map(k => `\`${k}\` = ?`).join(', ');
      await db.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...Object.values(raw), req.params.id);
      if (hooks.afterUpdate) await hooks.afterUpdate(db, req.params.id, raw, req, existing);
      const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id);
      res.json(deserialize(table, row));
    } catch (err) {
      res.status(err.statusCode || 400).json({ message: err.message });
    }
  });

  router.delete('/:id', authMiddleware, async (req, res) => {
    try {
      const db = getDb();
      const existing = await db.get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id);
      if (!existing) return res.status(404).json({ message: 'Not found' });
      if (hooks.beforeDelete) await hooks.beforeDelete(db, req.params.id, req, existing);
      await db.run(`DELETE FROM ${table} WHERE id = ?`, req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(err.statusCode || 400).json({ message: err.message });
    }
  });

  return router;
}

module.exports = { buildEntityRouter, deserialize };