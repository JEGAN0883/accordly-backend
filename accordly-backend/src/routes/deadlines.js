const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authenticate');
const { query } = require('../db/pool');

router.use(authenticate);

// GET /api/v1/deadlines/:relationshipId — list all court deadlines for a relationship
router.get('/:relationshipId', async (req, res, next) => {
  try {
    const { relationshipId } = req.params;

    // Confirm this user belongs to the relationship
    const relCheck = await query(
      `SELECT id FROM coparent_relationships WHERE id = $1 AND (parent_a_id = $2 OR parent_b_id = $2)`,
      [relationshipId, req.user.id]
    );
    if (!relCheck.rows.length) return res.status(403).json({ error: 'Not authorized for this relationship' });

    const result = await query(
      `SELECT * FROM court_deadlines
       WHERE relationship_id = $1
       ORDER BY due_date ASC`,
      [relationshipId]
    );

    res.json({ deadlines: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/deadlines — create a new court deadline
router.post('/', async (req, res, next) => {
  try {
    const { relationship_id, deadline_type, title, due_date, notes, notify_attorney } = req.body;

    if (!relationship_id || !title || !due_date) {
      return res.status(400).json({ error: 'relationship_id, title, and due_date are required.' });
    }

    const relCheck = await query(
      `SELECT id FROM coparent_relationships WHERE id = $1 AND (parent_a_id = $2 OR parent_b_id = $2)`,
      [relationship_id, req.user.id]
    );
    if (!relCheck.rows.length) return res.status(403).json({ error: 'Not authorized for this relationship' });

    const result = await query(
      `INSERT INTO court_deadlines
         (relationship_id, created_by_id, deadline_type, title, due_date, notes, notify_attorney)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [relationship_id, req.user.id, deadline_type || 'other', title, due_date, notes || null, notify_attorney || false]
    );

    res.status(201).json({ deadline: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/deadlines/:id — mark complete or edit
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_completed, title, due_date, notes, deadline_type } = req.body;

    const existing = await query(
      `SELECT d.* FROM court_deadlines d
       JOIN coparent_relationships r ON r.id = d.relationship_id
       WHERE d.id = $1 AND (r.parent_a_id = $2 OR r.parent_b_id = $2)`,
      [id, req.user.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Deadline not found.' });

    const merged = {
      ...existing.rows[0],
      ...(is_completed !== undefined && { is_completed }),
      ...(title !== undefined && { title }),
      ...(due_date !== undefined && { due_date }),
      ...(notes !== undefined && { notes }),
      ...(deadline_type !== undefined && { deadline_type }),
    };

    const result = await query(
      `UPDATE court_deadlines
       SET is_completed = $1, completed_at = $2, title = $3, due_date = $4, notes = $5, deadline_type = $6
       WHERE id = $7
       RETURNING *`,
      [
        merged.is_completed,
        merged.is_completed ? new Date() : null,
        merged.title,
        merged.due_date,
        merged.notes,
        merged.deadline_type,
        id
      ]
    );

    res.json({ deadline: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/deadlines/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await query(
      `DELETE FROM court_deadlines d
       USING coparent_relationships r
       WHERE d.id = $1 AND d.relationship_id = r.id AND (r.parent_a_id = $2 OR r.parent_b_id = $2)`,
      [id, req.user.id]
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
