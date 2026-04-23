const express = require('express');
const { param } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate, requirePlan } = require('../middleware/authenticate');
const { generateCaseNarrative } = require('../services/aiAnalysis');

const router = express.Router();
router.use(authenticate);

// ── GENERATE COMPLIANCE REPORT ──
router.get('/compliance/:relationshipId', requirePlan('essential'), [
  param('relationshipId').isUUID(),
], async (req, res, next) => {
  try {
    const { relationshipId } = req.params;
    const { days = 90 } = req.query;

    // Verify access
    const rel = await query(
      `SELECT r.*, 
              ua.first_name || ' ' || ua.last_name as parent_a_name,
              ub.first_name || ' ' || ub.last_name as parent_b_name
       FROM coparent_relationships r
       LEFT JOIN users ua ON ua.id = r.parent_a_id
       LEFT JOIN users ub ON ub.id = r.parent_b_id
       WHERE r.id = $1 AND (r.parent_a_id = $2 OR r.parent_b_id = $2)`,
      [relationshipId, req.user.id]
    );
    if (!rel.rows.length) return res.status(403).json({ error: 'Not authorized' });
    const relationship = rel.rows[0];

    const cutoff = `NOW() - INTERVAL '${parseInt(days)} days'`;

    // Gather all compliance data in parallel
    const [messages, events, payments, violations] = await Promise.all([
      query(
        `SELECT ai_threat_level, ai_categories, created_at, sender_id 
         FROM messages WHERE relationship_id = $1 AND created_at > ${cutoff}`,
        [relationshipId]
      ),
      query(
        `SELECT status, custody_parent, start_datetime
         FROM calendar_events 
         WHERE relationship_id = $1 AND start_datetime > ${cutoff}
           AND event_type IN ('pickup','dropoff','custody')`,
        [relationshipId]
      ),
      query(
        `SELECT status, amount_ordered, amount_paid, due_date
         FROM child_support_payments 
         WHERE relationship_id = $1 AND due_date > NOW() - INTERVAL '${parseInt(days)} days'`,
        [relationshipId]
      ),
      query(
        `SELECT violation_type, severity, incident_date
         FROM violations WHERE relationship_id = $1 AND incident_date > ${cutoff}`,
        [relationshipId]
      ),
    ]);

    // Calculate scores
    const totalMessages = messages.rows.length;
    const flaggedMessages = messages.rows.filter(m => m.ai_threat_level !== 'none').length;
    const totalVisits = events.rows.length;
    const completedVisits = events.rows.filter(e => e.status === 'completed').length;
    const visitRate = totalVisits > 0 ? Math.round((completedVisits / totalVisits) * 100) : 100;
    const totalPayments = payments.rows.length;
    const paidPayments = payments.rows.filter(p => p.status === 'paid').length;
    const paymentRate = totalPayments > 0 ? Math.round((paidPayments / totalPayments) * 100) : 100;
    
    const isParentA = relationship.parent_a_id === req.user.id;
    
    // Simple fitness score algorithm
    let scoreA = 100, scoreB = 100;
    const coParentFlags = messages.rows.filter(
      m => m.sender_id !== req.user.id && m.ai_threat_level !== 'none'
    ).length;
    const myFlags = messages.rows.filter(
      m => m.sender_id === req.user.id && m.ai_threat_level !== 'none'
    ).length;
    
    if (isParentA) {
      scoreA = Math.max(0, 100 - myFlags * 8 - violations.rows.filter(v => v.severity === 'high').length * 10);
      scoreB = Math.max(0, 100 - coParentFlags * 8 - (100 - visitRate) * 0.3 - (100 - paymentRate) * 0.4);
    } else {
      scoreB = Math.max(0, 100 - myFlags * 8);
      scoreA = Math.max(0, 100 - coParentFlags * 8);
    }

    // Generate AI narrative for pro/safe plans
    let aiNarrative = null;
    if (['safe', 'pro'].includes(req.user.plan) || req.user.dv_waiver) {
      aiNarrative = await generateCaseNarrative({
        parentA: relationship.parent_a_name,
        parentB: relationship.parent_b_name || 'Co-parent (not yet joined)',
        period: `Last ${days} days`,
        scoreA: Math.round(scoreA),
        scoreB: Math.round(scoreB),
        visitRate: visitRate,
        paymentStatus: paymentRate === 100 ? 'Current' : `${paymentRate}% compliant — ${totalPayments - paidPayments} payment(s) overdue`,
        flagCount: flaggedMessages,
        violationCount: violations.rows.length,
        wellnessTrend: 'See child wellness data',
      });
    }

    res.json({
      report: {
        relationship_id: relationshipId,
        period_days: parseInt(days),
        generated_at: new Date().toISOString(),
        parent_a: { name: relationship.parent_a_name, fitness_score: Math.round(scoreA) },
        parent_b: { name: relationship.parent_b_name || 'Co-parent', fitness_score: Math.round(scoreB) },
        compliance: {
          visit_completion_rate: visitRate,
          total_visits: totalVisits,
          completed_visits: completedVisits,
          payment_compliance_rate: paymentRate,
          total_payments: totalPayments,
          paid_payments: paidPayments,
          communication_flags: flaggedMessages,
          violations: violations.rows.length,
        },
        ai_narrative: aiNarrative,
        disclaimer: 'This report was generated with AI assistance from Accordly. All data is derived from timestamped platform records. Patent Pending — USPTO #75170980. Admissibility is subject to applicable rules of evidence. Consult a licensed attorney before filing.',
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
