/**
 * Remaining route stubs — each is a full implementation skeleton
 * These are ready to expand. The patterns from messages.js and auth.js apply to all.
 */

// ── calendar.js ──
const express1 = require('express'); const r1 = express1.Router();
const { authenticate: a1, requirePlan: p1 } = require('../middleware/authenticate');
const { query: q1 } = require('../db/pool');
r1.use(a1);
r1.get('/:relationshipId', async (req, res, next) => {
  try {
    const { relationshipId } = req.params;
    const { start, end } = req.query;
    const result = await q1(
      `SELECT e.*, u.first_name || ' ' || u.last_name as created_by_name
       FROM calendar_events e JOIN users u ON u.id = e.created_by_id
       WHERE e.relationship_id = $1
         AND ($2::date IS NULL OR e.start_datetime >= $2::date)
         AND ($3::date IS NULL OR e.start_datetime <= $3::date)
       ORDER BY e.start_datetime ASC`,
      [relationshipId, start || null, end || null]
    );
    res.json({ events: result.rows });
  } catch(e){next(e)}
});
r1.post('/', async (req, res, next) => {
  try {
    const { relationship_id, title, event_type, start_datetime, end_datetime, all_day, location, notes, custody_parent } = req.body;
    const result = await q1(
      `INSERT INTO calendar_events (relationship_id, created_by_id, title, event_type, start_datetime, end_datetime, all_day, location, notes, custody_parent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [relationship_id, req.user.id, title, event_type, start_datetime, end_datetime, all_day, location, notes, custody_parent]
    );
    res.status(201).json({ event: result.rows[0] });
  } catch(e){next(e)}
});
r1.post('/:id/checkin', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    const result = await q1(
      `UPDATE calendar_events SET checkin_at = NOW(), checkin_lat = $1, checkin_lng = $2, status = 'completed'
       WHERE id = $3 AND (custody_parent = $4 OR created_by_id = $4) RETURNING *`,
      [lat, lng, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: result.rows[0] });
  } catch(e){next(e)}
});
module.exports.calendar = r1;

// ── children.js ──
const express2 = require('express'); const r2 = express2.Router();
const { authenticate: a2 } = require('../middleware/authenticate');
const { query: q2 } = require('../db/pool');
r2.use(a2);
r2.get('/relationship/:relationshipId', async (req, res, next) => {
  try {
    const result = await q2('SELECT * FROM children WHERE relationship_id = $1 ORDER BY date_of_birth', [req.params.relationshipId]);
    res.json({ children: result.rows });
  } catch(e){next(e)}
});
r2.post('/', async (req, res, next) => {
  try {
    const { relationship_id, first_name, last_name, date_of_birth, school_name, allergies, medications } = req.body;
    const result = await q2(
      `INSERT INTO children (relationship_id, first_name, last_name, date_of_birth, school_name, allergies, medications)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [relationship_id, first_name, last_name, date_of_birth, school_name, allergies, medications]
    );
    res.status(201).json({ child: result.rows[0] });
  } catch(e){next(e)}
});
r2.post('/:id/wellness', async (req, res, next) => {
  try {
    const { emoji, context } = req.body;
    const result = await q2(
      'INSERT INTO wellness_checkins (child_id, checked_in_by_id, emoji, context) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, req.user.id, emoji, context || 'after_transition']
    );
    res.status(201).json({ checkin: result.rows[0] });
  } catch(e){next(e)}
});
r2.get('/:id/wellness', async (req, res, next) => {
  try {
    const result = await q2(
      'SELECT * FROM wellness_checkins WHERE child_id = $1 ORDER BY created_at DESC LIMIT 60',
      [req.params.id]
    );
    res.json({ checkins: result.rows });
  } catch(e){next(e)}
});
r2.post('/:id/medication', async (req, res, next) => {
  try {
    const { medication_name, dosage, administered_at, notes } = req.body;
    const result = await q2(
      'INSERT INTO medication_logs (child_id, logged_by_id, medication_name, dosage, administered_at, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, req.user.id, medication_name, dosage, administered_at || new Date(), notes]
    );
    res.status(201).json({ log: result.rows[0] });
  } catch(e){next(e)}
});
module.exports.children = r2;

// ── violations.js ──
const express3 = require('express'); const r3 = express3.Router();
const { authenticate: a3 } = require('../middleware/authenticate');
const { query: q3 } = require('../db/pool');
r3.use(a3);
r3.get('/relationship/:relationshipId', async (req, res, next) => {
  try {
    const result = await q3(
      'SELECT * FROM violations WHERE relationship_id = $1 ORDER BY incident_date DESC',
      [req.params.relationshipId]
    );
    res.json({ violations: result.rows });
  } catch(e){next(e)}
});
r3.post('/', async (req, res, next) => {
  try {
    const { relationship_id, violator_id, violation_type, severity, description, incident_date } = req.body;
    const result = await q3(
      `INSERT INTO violations (relationship_id, reported_by_id, violator_id, violation_type, severity, description, incident_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [relationship_id, req.user.id, violator_id, violation_type, severity || 'medium', description, incident_date || new Date()]
    );
    res.status(201).json({ violation: result.rows[0] });
  } catch(e){next(e)}
});
module.exports.violations = r3;

// ── professional.js ──
const express4 = require('express'); const r4 = express4.Router();
const { authenticate: a4 } = require('../middleware/authenticate');
const { query: q4 } = require('../db/pool');
r4.use(a4);
r4.get('/cases', async (req, res, next) => {
  try {
    const result = await q4(
      `SELECT r.*, pa.professional_id, pa.access_type,
              ua.first_name || ' ' || ua.last_name as parent_a_name,
              ub.first_name || ' ' || ub.last_name as parent_b_name
       FROM professional_access pa
       JOIN coparent_relationships r ON r.id = pa.relationship_id
       LEFT JOIN users ua ON ua.id = r.parent_a_id
       LEFT JOIN users ub ON ub.id = r.parent_b_id
       WHERE pa.professional_id = $1 AND pa.is_active = TRUE`,
      [req.user.id]
    );
    res.json({ cases: result.rows });
  } catch(e){next(e)}
});
r4.post('/grant-access', async (req, res, next) => {
  try {
    const { professional_email, access_type, relationship_id, court_order_number } = req.body;
    const prof = await q4('SELECT id FROM users WHERE email = $1 AND role != $2', [professional_email, 'parent']);
    if (!prof.rows.length) return res.status(404).json({ error: 'Professional not found' });
    const result = await q4(
      `INSERT INTO professional_access (professional_id, relationship_id, user_id, access_type, court_order_number)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [prof.rows[0].id, relationship_id, req.user.id, access_type, court_order_number]
    );
    res.status(201).json({ access: result.rows[0] });
  } catch(e){next(e)}
});
module.exports.professional = r4;

// ── dhs.js ──
const express5 = require('express'); const r5 = express5.Router();
const { authenticate: a5, requirePlan: p5 } = require('../middleware/authenticate');
const { query: q5 } = require('../db/pool');
r5.use(a5);
r5.get('/report/:relationshipId', p5('safe'), async (req, res, next) => {
  try {
    const payments = await q5(
      `SELECT * FROM child_support_payments WHERE relationship_id = $1 ORDER BY due_date DESC`,
      [req.params.relationshipId]
    );
    const overdue = payments.rows.filter(p => p.status === 'overdue' || p.status === 'partial');
    const totalArrears = overdue.reduce((sum, p) => sum + (parseFloat(p.amount_ordered) - parseFloat(p.amount_paid || 0)), 0);
    res.json({
      relationship_id: req.params.relationshipId,
      generated_at: new Date().toISOString(),
      total_arrears: totalArrears,
      overdue_payments: overdue,
      all_payments: payments.rows,
      passport_threshold_met: totalArrears >= 2500,
      federal_threshold_met: totalArrears >= 5000,
      disclaimer: 'Accordly DHS Report. Patent Pending — USPTO #75170980. Consult a licensed attorney before filing.',
    });
  } catch(e){next(e)}
});
module.exports.dhs = r5;

// ── users.js ──
const express6 = require('express'); const r6 = express6.Router();
const { authenticate: a6 } = require('../middleware/authenticate');
const { query: q6 } = require('../db/pool');
r6.use(a6);
r6.get('/profile', async (req, res, next) => {
  try {
    const result = await q6(
      `SELECT id, email, first_name, last_name, role, plan, plan_status, dv_waiver, 
              phone, timezone, language, created_at
       FROM users WHERE id = $1`, [req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch(e){next(e)}
});
r6.patch('/profile', async (req, res, next) => {
  try {
    const { first_name, last_name, phone, timezone } = req.body;
    const result = await q6(
      'UPDATE users SET first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name), phone=COALESCE($3,phone), timezone=COALESCE($4,timezone) WHERE id=$5 RETURNING id,email,first_name,last_name,plan',
      [first_name, last_name, phone, timezone, req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch(e){next(e)}
});
r6.get('/relationships', async (req, res, next) => {
  try {
    const result = await q6(
      `SELECT r.*, ua.first_name || ' ' || ua.last_name as parent_a_name, ub.first_name || ' ' || ub.last_name as parent_b_name
       FROM coparent_relationships r
       LEFT JOIN users ua ON ua.id = r.parent_a_id
       LEFT JOIN users ub ON ub.id = r.parent_b_id
       WHERE r.parent_a_id = $1 OR r.parent_b_id = $1`, [req.user.id]
    );
    res.json({ relationships: result.rows });
  } catch(e){next(e)}
});
r6.post('/relationships', async (req, res, next) => {
  try {
    const { invite_email, case_number, court_name, court_state } = req.body;
    const result = await q6(
      `INSERT INTO coparent_relationships (parent_a_id, invite_email, case_number, court_name, court_state, invite_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, invite_email, case_number, court_name, court_state, require('uuid').v4()]
    );
    res.status(201).json({ relationship: result.rows[0] });
  } catch(e){next(e)}
});
module.exports.users = r6;

// ── health.js ──
const express7 = require('express'); const r7 = express7.Router();
r7.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Accordly API', version: '1.0.0', timestamp: new Date().toISOString(), patent: 'Pending USPTO #75170980' });
});
module.exports.health = r7;

// ── webhooks.js ──
const express8 = require('express'); const r8 = express8.Router();
r8.post('/stripe', (req, res) => { res.json({ received: true }); }); // Handled in payments.js
module.exports.webhooks = r8;
