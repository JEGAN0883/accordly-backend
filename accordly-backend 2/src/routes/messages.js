const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query, transaction } = require('../db/pool');
const { authenticate, requirePlan } = require('../middleware/authenticate');
const { analyzeMessage, analyzePattern } = require('../services/aiAnalysis');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ── SEND MESSAGE (with AI analysis) ──
router.post('/', [
  body('relationship_id').isUUID(),
  body('content').trim().isLength({ min: 1, max: 5000 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { relationship_id, content } = req.body;

    // Verify sender belongs to this relationship
    const relCheck = await query(
      `SELECT id FROM coparent_relationships WHERE id = $1 AND (parent_a_id = $2 OR parent_b_id = $2)`,
      [relationship_id, req.user.id]
    );
    if (!relCheck.rows.length) return res.status(403).json({ error: 'Not authorized for this relationship' });

    // ── AI ANALYSIS (Essential+ plans) ──
    let aiResult = { threat_level: 'none', should_block: false, categories: [], analysis: null };
    const plansWithAI = ['essential', 'safe', 'pro'];
    
    if (plansWithAI.includes(req.user.plan) || req.user.dv_waiver) {
      // Get recent flags for context
      const recentFlags = await query(
        `SELECT ai_threat_level, ai_categories, created_at 
         FROM messages 
         WHERE relationship_id = $1 AND ai_threat_level != 'none' 
           AND created_at > NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC LIMIT 10`,
        [relationship_id]
      );

      aiResult = await analyzeMessage(content, {
        recentFlags: recentFlags.rows,
      });
    }

    // Store message
    const result = await query(
      `INSERT INTO messages 
        (relationship_id, sender_id, content, content_original, 
         status, ai_analyzed, ai_threat_level, ai_categories, 
         ai_analysis_text, ai_suggested_rewrite, ai_blocked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        relationship_id,
        req.user.id,
        aiResult.should_block ? '[Message blocked by AI]' : content,
        aiResult.should_block ? content : null,
        aiResult.should_block ? 'blocked' : 'sent',
        plansWithAI.includes(req.user.plan),
        aiResult.threat_level,
        JSON.stringify(aiResult.categories),
        aiResult.analysis,
        aiResult.suggested_rewrite,
        aiResult.should_block,
      ]
    );

    const message = result.rows[0];

    // Log violation if high/critical
    if (['high', 'critical'].includes(aiResult.threat_level)) {
      await query(
        `INSERT INTO violations 
          (relationship_id, reported_by_id, violation_type, severity, description, 
           incident_date, ai_analysis, related_message_id)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)`,
        [
          relationship_id,
          req.user.id,
          'communication',
          aiResult.threat_level === 'critical' ? 'critical' : 'high',
          `AI detected: ${aiResult.categories.join(', ')}`,
          aiResult.analysis,
          message.id,
        ]
      ).catch(err => logger.error('Failed to auto-log violation:', err.message));
    }

    res.status(201).json({
      message,
      ai_analysis: plansWithAI.includes(req.user.plan) ? aiResult : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET MESSAGES ──
router.get('/relationship/:relationshipId', [
  param('relationshipId').isUUID(),
], async (req, res, next) => {
  try {
    const { relationshipId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * Math.min(limit, 100);

    const relCheck = await query(
      `SELECT id FROM coparent_relationships WHERE id = $1 AND (parent_a_id = $2 OR parent_b_id = $2)`,
      [relationshipId, req.user.id]
    );
    if (!relCheck.rows.length) return res.status(403).json({ error: 'Not authorized' });

    const result = await query(
      `SELECT m.*, 
              u.first_name || ' ' || u.last_name as sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.relationship_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [relationshipId, Math.min(limit, 100), offset]
    );

    // Mark messages as read
    await query(
      `UPDATE messages SET read_at = NOW(), status = 'read'
       WHERE relationship_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [relationshipId, req.user.id]
    );

    res.json({ messages: result.rows });
  } catch (err) {
    next(err);
  }
});

// ── GET PATTERN ANALYSIS ──
router.get('/pattern/:relationshipId', requirePlan('safe'), [
  param('relationshipId').isUUID(),
], async (req, res, next) => {
  try {
    const { relationshipId } = req.params;

    const result = await query(
      `SELECT ai_threat_level, ai_categories, created_at
       FROM messages
       WHERE relationship_id = $1 
         AND ai_threat_level != 'none'
         AND created_at > NOW() - INTERVAL '30 days'
       ORDER BY created_at DESC`,
      [relationshipId]
    );

    const pattern = await analyzePattern(result.rows);
    
    res.json({ pattern, flag_count: result.rows.length, flags: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
