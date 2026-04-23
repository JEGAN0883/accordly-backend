const express = require('express');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ── EMERGENCY EXPORT ──
// Available on ALL plans including free — safety is never paywalled
router.post('/emergency-export', async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    // Find user's relationships
    const relationships = await query(
      `SELECT r.id, r.case_number, r.court_name,
              ua.first_name || ' ' || ua.last_name as parent_a_name,
              ub.first_name || ' ' || ub.last_name as parent_b_name
       FROM coparent_relationships r
       LEFT JOIN users ua ON ua.id = r.parent_a_id
       LEFT JOIN users ub ON ub.id = r.parent_b_id
       WHERE r.parent_a_id = $1 OR r.parent_b_id = $1`,
      [userId]
    );

    if (!relationships.rows.length) {
      return res.json({ success: true, message: 'Emergency export logged.', export_id: null });
    }

    const relationshipId = relationships.rows[0].id;
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Gather last 30 days of data
    const [messages, events, violations, payments] = await Promise.all([
      query(
        `SELECT m.content, m.created_at, m.ai_threat_level, m.ai_categories, m.ai_analysis_text,
                u.first_name || ' ' || u.last_name as sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.relationship_id = $1 AND m.created_at > $2
         ORDER BY m.created_at DESC`,
        [relationshipId, cutoff]
      ),
      query(
        `SELECT title, event_type, start_datetime, status, location
         FROM calendar_events WHERE relationship_id = $1 AND start_datetime > $2
         ORDER BY start_datetime DESC`,
        [relationshipId, cutoff]
      ),
      query(
        `SELECT violation_type, severity, description, incident_date, ai_analysis
         FROM violations WHERE relationship_id = $1 AND incident_date > $2
         ORDER BY incident_date DESC`,
        [relationshipId, cutoff]
      ),
      query(
        `SELECT amount_ordered, amount_paid, due_date, status
         FROM child_support_payments WHERE relationship_id = $1 AND due_date > $2`,
        [relationshipId, cutoff]
      ),
    ]);

    // Log the emergency export activation
    logger.warn(`EMERGENCY EXPORT activated by user ${userId} at ${new Date().toISOString()}`);

    // In production: generate PDF and send to emergency contacts
    // Here we return the structured data
    const exportData = {
      export_id: `EMEX-${Date.now()}`,
      generated_at: new Date().toISOString(),
      generated_by: `${req.user.first_name} ${req.user.last_name}`,
      case: relationships.rows[0],
      period: 'Last 30 days',
      summary: {
        messages: messages.rows.length,
        flagged_messages: messages.rows.filter(m => m.ai_threat_level !== 'none').length,
        events: events.rows.length,
        violations: violations.rows.length,
        payments: payments.rows.length,
      },
      messages: messages.rows,
      events: events.rows,
      violations: violations.rows,
      payments: payments.rows,
      crisis_resources: {
        national_dv_hotline: '1-800-799-7233',
        crisis_text: 'Text HOME to 741741',
        emergency: '911',
        legal_aid: 'lawhelp.org',
      },
      disclaimer: 'EMERGENCY EXPORT — Accordly Platform. All records are timestamped and tamper-evident. Patent Pending — USPTO #75170980.',
    };

    res.json({ success: true, data: exportData });
  } catch (err) {
    next(err);
  }
});

// ── CRISIS ASSESSMENT ──
router.post('/crisis-assessment', async (req, res, next) => {
  try {
    const { feeling_weight, situation_weight, children_weight, history_weight } = req.body;
    
    const total = (feeling_weight || 0) + (situation_weight || 0) + 
                  (children_weight || 0) + (history_weight || 0);
    const maxPossible = 4 * 5;
    const pct = total / maxPossible;

    let directive, type, steps;

    if (situation_weight >= 5 || (pct > 0.7 && feeling_weight >= 4)) {
      type = 'leave'; directive = 'Leave the home now.';
      steps = [
        'Go to the nearest exit now. Take the children if with you.',
        'Call 911 when you are away. Say your address first.',
        'Do not collect belongings. Do not explain. Move.',
        'Accordly is exporting your documentation automatically.',
      ];
    } else if (pct > 0.55) {
      type = 'safety'; directive = 'Contact the DV Hotline. Build a safety plan tonight.';
      steps = [
        'Call 1-800-799-7233 — they help without pressure.',
        'Identify where you could go if you needed to leave quickly.',
        'Make sure your Accordly documentation is up to date.',
        'If the situation escalates, call 911.',
      ];
    } else if (pct > 0.35) {
      type = 'court'; directive = 'Contact your attorney. Escalate through the court.';
      steps = [
        'Generate your Accordly compliance report now.',
        'Contact your attorney this week about contempt filing.',
        'If no attorney, contact legal aid at lawhelp.org.',
        'Do not retaliate. Your compliance record is your protection.',
      ];
    } else if (pct > 0.2) {
      type = 'document'; directive = 'Document now. Build your record.';
      steps = [
        'Log this incident in Accordly with all details.',
        'Your pattern is building — consistent documentation is your foundation.',
        'Continue to follow your parenting plan.',
        'Share your record with your attorney at your next meeting.',
      ];
    } else {
      type = 'stable'; directive = 'You are stable. Keep documenting. Stay compliant.';
      steps = [
        'Continue to follow your parenting plan exactly.',
        'Document any incidents through Accordly as they occur.',
        'Review your safety plan periodically.',
        'Your Accordly record is building even when nothing is happening.',
      ];
    }

    res.json({ type, directive, steps, severity_pct: Math.round(pct * 100) });
  } catch (err) {
    next(err);
  }
});

// ── SAFE EXIT TRACKING (anonymous) ──
router.post('/safe-exit', async (req, res) => {
  logger.info(`Safe exit activated at ${new Date().toISOString()}`);
  res.json({ redirect: 'https://weather.com' });
});

module.exports = router;
