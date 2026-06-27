/**
 * iMATOMs Platform — Backend API Server v3.0
 * TKO · TECHNOLOGY — Towards Sustainable Organization
 * Node.js + Express + PostgreSQL + JWT
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { Pool }    = require('pg');
const bcrypt      = require('bcrypt');
const jwt         = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('DB Pool Error:', err));

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Rate limit — 200 requests per 15 min per IP
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
}));

// ── HELPERS ───────────────────────────────────────────────────
const JWT_SECRET         = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const JWT_EXPIRES        = process.env.JWT_EXPIRES || '8h';
const REFRESH_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, building_id: user.building_id, modules: user.modules },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Audit log helper
async function audit(userId, action, table, recordId, oldData, newData, ip) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, table_name, record_id, old_data, new_data, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, action, table, recordId, oldData ? JSON.stringify(oldData) : null,
       newData ? JSON.stringify(newData) : null, ip]
    );
  } catch (e) { console.error('Audit error:', e.message); }
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', version: '3.0', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'db_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE (username=$1 OR email=$1) AND status='approved'`,
      [username]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Update last login
    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);

    const token = signToken(user);

    // Refresh token
    const refreshToken = uuid();
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)`,
      [user.id, refreshToken, new Date(Date.now() + REFRESH_EXPIRES_MS)]
    );

    await audit(user.id, 'LOGIN', 'users', user.id, null, { username: user.username }, req.ip);

    const { password_hash, ...safeUser } = user;
    res.json({ token, refresh_token: refreshToken, user: safeUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/refresh
app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const { rows } = await pool.query(
      `SELECT rt.*, u.* FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token=$1 AND rt.expires_at > NOW() AND u.status='approved'`,
      [refresh_token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = rows[0];
    const token = signToken(user);
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) await pool.query('DELETE FROM refresh_tokens WHERE token=$1', [refresh_token]);
  await audit(req.user.id, 'LOGOUT', 'users', req.user.id, null, null, req.ip);
  res.json({ message: 'Logged out' });
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, full_name, position, building_id, business_group, department } = req.body;
  if (!username || !email || !password || !full_name) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const exists = await pool.query('SELECT id FROM users WHERE username=$1 OR email=$2', [username, email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username or email already exists' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, full_name, position, building_id, business_group, department, role, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'viewer','pending') RETURNING id, username, email, full_name, role, status`,
      [username, email, hash, full_name, position, building_id || null, business_group, department]
    );
    res.status(201).json({ message: 'Registration submitted, pending approval', user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, full_name, position, role, building_id, business_group, department, modules, avatar_url, status, last_login
       FROM users WHERE id=$1`, [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// BUILDINGS
// ══════════════════════════════════════════════════════════════

app.get('/api/buildings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM buildings WHERE status='active' ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/buildings/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM buildings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// USERS (Admin Management)
// ══════════════════════════════════════════════════════════════

app.get('/api/users', authMiddleware, requireRole('superadmin','admin','manager'), async (req, res) => {
  try {
    const bid = req.user.role === 'superadmin' ? null : req.user.building_id;
    const query = bid
      ? `SELECT id,username,email,full_name,position,role,building_id,status,modules,last_login,created_at FROM users WHERE building_id=$1 ORDER BY full_name`
      : `SELECT id,username,email,full_name,position,role,building_id,status,modules,last_login,created_at FROM users ORDER BY full_name`;
    const { rows } = await pool.query(query, bid ? [bid] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/users/:id/approve', authMiddleware, requireRole('superadmin','admin'), async (req, res) => {
  const { role, modules } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET status='approved', role=COALESCE($1,role), modules=COALESCE($2,modules), updated_at=NOW()
       WHERE id=$3 RETURNING id, username, role, status`,
      [role, modules, req.params.id]
    );
    await audit(req.user.id, 'APPROVE_USER', 'users', req.params.id, null, rows[0], req.ip);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/users/:id/password', authMiddleware, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (req.user.id !== req.params.id && !['superadmin','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  if (new_password?.length < 8) return res.status(400).json({ error: 'Min 8 characters' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.id === req.params.id) {
      const valid = await bcrypt.compare(old_password, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: 'Old password incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.params.id]);
    res.json({ message: 'Password updated' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// ASSETS
// ══════════════════════════════════════════════════════════════

app.get('/api/assets', authMiddleware, async (req, res) => {
  const { module, status, criticality, search } = req.query;
  const bid = req.user.building_id;
  try {
    let q = `SELECT a.*, c.name as category_name
             FROM assets a LEFT JOIN asset_categories c ON c.id = a.category_id
             WHERE a.building_id=$1`;
    const params = [bid];
    let i = 2;
    if (module)      { q += ` AND a.module=$${i++}`;      params.push(module); }
    if (status)      { q += ` AND a.status=$${i++}`;      params.push(status); }
    if (criticality) { q += ` AND a.criticality=$${i++}`; params.push(criticality); }
    if (search)      { q += ` AND (a.name ILIKE $${i} OR a.asset_no ILIKE $${i})`; params.push(`%${search}%`); i++; }
    q += ' ORDER BY a.asset_no';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/assets', authMiddleware, requireRole('superadmin','admin','manager','engineer'), async (req, res) => {
  const f = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO assets (building_id, category_id, asset_no, name, brand, model, serial_no, location, floor, zone,
         module, status, criticality, install_date, warranty_expire, purchase_cost, pm_interval_days, next_pm_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [req.user.building_id, f.category_id||null, f.asset_no, f.name, f.brand, f.model, f.serial_no,
       f.location, f.floor, f.zone, f.module, f.status||'operational', f.criticality||'medium',
       f.install_date||null, f.warranty_expire||null, f.purchase_cost||null, f.pm_interval_days||90,
       f.next_pm_date||null, f.notes, req.user.id]
    );
    await audit(req.user.id, 'CREATE_ASSET', 'assets', rows[0].id, null, rows[0], req.ip);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/assets/:id', authMiddleware, requireRole('superadmin','admin','manager','engineer'), async (req, res) => {
  const f = req.body;
  try {
    const old = await pool.query('SELECT * FROM assets WHERE id=$1', [req.params.id]);
    const { rows } = await pool.query(
      `UPDATE assets SET name=$1, brand=$2, model=$3, serial_no=$4, location=$5, floor=$6, status=$7,
         criticality=$8, pm_interval_days=$9, next_pm_date=$10, notes=$11, updated_at=NOW()
       WHERE id=$12 AND building_id=$13 RETURNING *`,
      [f.name, f.brand, f.model, f.serial_no, f.location, f.floor, f.status,
       f.criticality, f.pm_interval_days, f.next_pm_date, f.notes, req.params.id, req.user.building_id]
    );
    await audit(req.user.id, 'UPDATE_ASSET', 'assets', req.params.id, old.rows[0], rows[0], req.ip);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// PM Due Alert — assets due within N days
app.get('/api/assets/pm-due', authMiddleware, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM assets
       WHERE building_id=$1 AND next_pm_date <= CURRENT_DATE + $2 AND status NOT IN ('decommissioned')
       ORDER BY next_pm_date ASC`,
      [req.user.building_id, days]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// WORK ORDERS
// ══════════════════════════════════════════════════════════════

app.get('/api/work-orders', authMiddleware, async (req, res) => {
  const { status, wo_type, module, search } = req.query;
  try {
    let q = `SELECT wo.*, a.name as asset_name, a.asset_no,
               u1.full_name as assigned_name, u2.full_name as requested_name
             FROM work_orders wo
             LEFT JOIN assets a ON a.id = wo.asset_id
             LEFT JOIN users u1 ON u1.id = wo.assigned_to
             LEFT JOIN users u2 ON u2.id = wo.requested_by
             WHERE wo.building_id=$1`;
    const params = [req.user.building_id];
    let i = 2;
    if (status)  { q += ` AND wo.status=$${i++}`;  params.push(status); }
    if (wo_type) { q += ` AND wo.wo_type=$${i++}`; params.push(wo_type); }
    if (module)  { q += ` AND wo.module=$${i++}`;  params.push(module); }
    if (search)  { q += ` AND (wo.title ILIKE $${i} OR wo.wo_no ILIKE $${i})`; params.push(`%${search}%`); i++; }
    q += ' ORDER BY wo.created_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/work-orders', authMiddleware, async (req, res) => {
  const f = req.body;
  // Auto-generate WO number
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*) FROM work_orders WHERE building_id=$1 AND EXTRACT(YEAR FROM created_at)=$2`,
    [req.user.building_id, new Date().getFullYear()]
  );
  const woNo = `WO-${new Date().getFullYear()}-${String(parseInt(cnt[0].count)+1).padStart(4,'0')}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO work_orders (building_id, wo_no, asset_id, wo_type, title, description, priority,
         planned_start, planned_end, assigned_to, module, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.building_id, woNo, f.asset_id||null, f.wo_type||'corrective', f.title, f.description,
       f.priority||'medium', f.planned_start||null, f.planned_end||null, f.assigned_to||null,
       f.module||'office', req.user.id]
    );
    await audit(req.user.id, 'CREATE_WO', 'work_orders', rows[0].id, null, rows[0], req.ip);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/work-orders/:id/status', authMiddleware, async (req, res) => {
  const { status, action_taken, root_cause, labor_hours, parts_cost } = req.body;
  try {
    const extra = {};
    if (status === 'in_progress') extra.actual_start = 'NOW()';
    if (['completed','verified'].includes(status)) extra.actual_end = 'NOW()';
    const { rows } = await pool.query(
      `UPDATE work_orders SET status=$1, action_taken=COALESCE($2,action_taken),
         root_cause=COALESCE($3,root_cause), labor_hours=COALESCE($4,labor_hours),
         parts_cost=COALESCE($5,parts_cost),
         actual_start=CASE WHEN $1='in_progress' AND actual_start IS NULL THEN NOW() ELSE actual_start END,
         actual_end=CASE WHEN $1 IN ('completed','verified') THEN NOW() ELSE actual_end END,
         updated_at=NOW()
       WHERE id=$6 AND building_id=$7 RETURNING *`,
      [status, action_taken, root_cause, labor_hours, parts_cost, req.params.id, req.user.building_id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// INCIDENTS
// ══════════════════════════════════════════════════════════════

app.get('/api/incidents', authMiddleware, async (req, res) => {
  const { status, severity, module } = req.query;
  try {
    let q = `SELECT i.*, u.full_name as reporter_name FROM incidents i
             LEFT JOIN users u ON u.id = i.reported_by
             WHERE i.building_id=$1`;
    const params = [req.user.building_id];
    let n = 2;
    if (status)   { q += ` AND i.status=$${n++}`;   params.push(status); }
    if (severity) { q += ` AND i.severity=$${n++}`; params.push(severity); }
    if (module)   { q += ` AND i.module=$${n++}`;   params.push(module); }
    q += ' ORDER BY i.occurred_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/incidents', authMiddleware, async (req, res) => {
  const f = req.body;
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*) FROM incidents WHERE building_id=$1 AND EXTRACT(YEAR FROM created_at)=$2`,
    [req.user.building_id, new Date().getFullYear()]
  );
  const incNo = `INC-${new Date().getFullYear()}-${String(parseInt(cnt[0].count)+1).padStart(4,'0')}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO incidents (building_id, incident_no, title, description, incident_type, severity,
         asset_id, location, occurred_at, reported_by, module)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.building_id, incNo, f.title, f.description, f.incident_type, f.severity,
       f.asset_id||null, f.location, f.occurred_at||new Date(), req.user.id, f.module||'office']
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// ESG — ENERGY / WATER / CARBON
// ══════════════════════════════════════════════════════════════

app.get('/api/esg/energy', authMiddleware, async (req, res) => {
  const { year, month } = req.query;
  try {
    let q = `SELECT * FROM energy_readings WHERE building_id=$1`;
    const p = [req.user.building_id];
    let n = 2;
    if (year)  { q += ` AND EXTRACT(YEAR FROM reading_date)=$${n++}`;  p.push(year); }
    if (month) { q += ` AND EXTRACT(MONTH FROM reading_date)=$${n++}`; p.push(month); }
    q += ' ORDER BY reading_date DESC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/esg/energy', authMiddleware, async (req, res) => {
  const { energy_type, reading_date, reading_kwh, cost_thb, floor, zone } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO energy_readings (building_id, energy_type, reading_date, reading_kwh, cost_thb, floor, zone)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.building_id, energy_type||'electricity', reading_date, reading_kwh, cost_thb, floor, zone]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/esg/summary', authMiddleware, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  try {
    const energy = await pool.query(
      `SELECT EXTRACT(MONTH FROM reading_date) as month, SUM(reading_kwh) as kwh, SUM(cost_thb) as cost
       FROM energy_readings WHERE building_id=$1 AND EXTRACT(YEAR FROM reading_date)=$2
       GROUP BY month ORDER BY month`,
      [req.user.building_id, year]
    );
    const water = await pool.query(
      `SELECT EXTRACT(MONTH FROM reading_date) as month, SUM(reading_m3) as m3, SUM(cost_thb) as cost
       FROM water_readings WHERE building_id=$1 AND EXTRACT(YEAR FROM reading_date)=$2
       GROUP BY month ORDER BY month`,
      [req.user.building_id, year]
    );
    res.json({ energy: energy.rows, water: water.rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// KPI
// ══════════════════════════════════════════════════════════════

app.get('/api/kpi', authMiddleware, async (req, res) => {
  const { pillar, module, year, month } = req.query;
  try {
    let q = `SELECT * FROM kpi_records WHERE building_id=$1`;
    const p = [req.user.building_id];
    let n = 2;
    if (pillar) { q += ` AND pillar=$${n++}`; p.push(pillar); }
    if (module) { q += ` AND module=$${n++}`; p.push(module); }
    if (year)   { q += ` AND period_year=$${n++}`; p.push(year); }
    if (month)  { q += ` AND period_month=$${n++}`; p.push(month); }
    q += ' ORDER BY kpi_code';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/kpi', authMiddleware, requireRole('superadmin','admin','manager','engineer'), async (req, res) => {
  const f = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO kpi_records (building_id, kpi_code, kpi_name, pillar, module, period_year, period_month, target, actual, unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING *`,
      [req.user.building_id, f.kpi_code, f.kpi_name, f.pillar, f.module, f.period_year, f.period_month, f.target, f.actual, f.unit]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// DASHBOARD SUMMARY
// ══════════════════════════════════════════════════════════════

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const bid = req.user.building_id;
  try {
    const [assets, wo, inc, pmDue, notif] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) as cnt FROM assets WHERE building_id=$1 GROUP BY status`, [bid]),
      pool.query(`SELECT status, COUNT(*) as cnt FROM work_orders WHERE building_id=$1 GROUP BY status`, [bid]),
      pool.query(`SELECT severity, COUNT(*) as cnt FROM incidents WHERE building_id=$1 AND status!='closed' GROUP BY severity`, [bid]),
      pool.query(`SELECT COUNT(*) as cnt FROM assets WHERE building_id=$1 AND next_pm_date <= CURRENT_DATE + 30 AND status!='decommissioned'`, [bid]),
      pool.query(`SELECT COUNT(*) as cnt FROM notifications WHERE building_id=$1 AND is_read=FALSE`, [bid]),
    ]);
    res.json({
      assets:         assets.rows,
      work_orders:    wo.rows,
      incidents:      inc.rows,
      pm_due_30days:  parseInt(pmDue.rows[0].cnt),
      unread_notif:   parseInt(notif.rows[0].cnt),
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE (user_id=$1 OR building_id=$2) ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, req.user.building_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// TENANT REQUESTS (Office Module)
// ══════════════════════════════════════════════════════════════

app.get('/api/tenant-requests', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tr.*, u.full_name as assigned_name FROM tenant_requests tr
       LEFT JOIN users u ON u.id = tr.assigned_to
       WHERE tr.building_id=$1 ORDER BY tr.created_at DESC`,
      [req.user.building_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/tenant-requests', authMiddleware, async (req, res) => {
  const f = req.body;
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*) FROM tenant_requests WHERE building_id=$1`, [req.user.building_id]
  );
  const reqNo = `TR-${String(parseInt(cnt[0].count)+1).padStart(5,'0')}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO tenant_requests (building_id, request_no, tenant_name, floor, unit, category, description, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.building_id, reqNo, f.tenant_name, f.floor, f.unit, f.category, f.description, f.priority||'normal']
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// BIOMEDICAL (Healthcare Module)
// ══════════════════════════════════════════════════════════════

app.get('/api/biomedical', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM biomedical_devices WHERE building_id=$1 ORDER BY bme_no`,
      [req.user.building_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/biomedical', authMiddleware, async (req, res) => {
  const f = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO biomedical_devices (building_id, bme_no, name, brand, model, serial_no, risk_class,
         department, location, install_date, warranty_expire, calibration_due, pm_interval, next_pm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.building_id, f.bme_no, f.name, f.brand, f.model, f.serial_no, f.risk_class,
       f.department, f.location, f.install_date||null, f.warranty_expire||null,
       f.calibration_due||null, f.pm_interval||90, f.next_pm||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════
// TRAINING (Skill Academy)
// ══════════════════════════════════════════════════════════════

app.get('/api/training/courses', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM training_courses ORDER BY code');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/training/records', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tr.*, tc.name as course_name, tc.category, u.full_name
       FROM training_records tr
       JOIN training_courses tc ON tc.id = tr.course_id
       JOIN users u ON u.id = tr.user_id
       WHERE tr.building_id=$1 ORDER BY tr.trained_date DESC`,
      [req.user.building_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/training/records', authMiddleware, async (req, res) => {
  const f = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO training_records (building_id, user_id, course_id, trained_date, expire_date, score, result, trainer, cert_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.building_id, f.user_id, f.course_id, f.trained_date, f.expire_date||null,
       f.score||null, f.result||'pending', f.trainer, f.cert_no]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ iMATOMs API v3.0 running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
