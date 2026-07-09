const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('../services/email');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const { logger } = require('../utils/logger');

const router = express.Router();

// Strict rate limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message: { error: 'Too many auth attempts, please try again in 15 minutes.' },
  standardHeaders: true,
});

const generateTokens = (userId) => {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
  return { accessToken, refreshToken };
};

// ── REGISTER ──
router.post('/register', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('first_name').trim().isLength({ min: 1, max: 100 }),
  body('last_name').trim().isLength({ min: 1, max: 100 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, first_name, last_name, role = 'parent' } = req.body;

    // Check existing user
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const allowedRoles = ['parent', 'attorney', 'mediator', 'judge', 'gal'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const password_hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const verify_token = uuidv4();

    const result = await query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verify_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, role, plan`,
      [email, password_hash, first_name, last_name, role, verify_token]
    );

    const user = result.rows[0];

    // ── AUTO-LINK: if someone invited this email as a co-parent before
    // they signed up, complete that relationship now by filling in
    // parent_b_id. Only matches relationships still waiting on a partner.
    try {
      const linked = await query(
        `UPDATE coparent_relationships
         SET parent_b_id = $1
         WHERE invite_email = $2 AND parent_b_id IS NULL
         RETURNING id`,
        [user.id, email]
      );
      if (linked.rows.length) {
        logger.info(`Auto-linked user ${user.id} to relationship ${linked.rows[0].id} via invite_email match`);
      }
    } catch (linkErr) {
      // Don't fail registration if linking has an issue — just log it.
      logger.error('Co-parent auto-link failed:', linkErr.message);
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    logger.info(`New user registered: ${user.id} (${role})`);

    res.status(201).json({
      user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, plan: user.plan },
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ── LOGIN ──
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const result = await query(
      `SELECT id, email, password_hash, first_name, last_name, role, plan, plan_status, 
              two_factor_enabled, dv_waiver
       FROM users WHERE email = $1`,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // 2FA required
    if (user.two_factor_enabled) {
      return res.json({ requires_2fa: true, user_id: user.id });
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    res.json({
      user: {
        id: user.id, email: user.email,
        first_name: user.first_name, last_name: user.last_name,
        role: user.role, plan: user.plan, plan_status: user.plan_status,
        dv_waiver: user.dv_waiver,
      },
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ── REFRESH TOKEN ──
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(401).json({ error: 'Refresh token required' });

    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(decoded.userId);

    res.json({ access_token: accessToken, refresh_token: newRefreshToken });
  } catch (err) {
    if (err.name?.includes('JsonWebToken')) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    next(err);
  }
});

// ── GET CURRENT USER ──
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

// ── APPLY FOR DV WAIVER ──
router.post('/dv-waiver', authLimiter, authenticate, async (req, res, next) => {
  try {
    await query(
      `UPDATE users SET dv_waiver = TRUE, dv_waiver_granted_at = NOW(), plan = 'safe'
       WHERE id = $1`,
      [req.user.id]
    );
    logger.info(`DV waiver granted for user: ${req.user.id}`);
    res.json({ success: true, message: 'DV waiver granted. You now have full Safe plan access.' });
  } catch (err) {
    next(err);
  }
});

// ── FORGOT PASSWORD ──
router.post('/forgot-password', authLimiter, [
  body('email').isEmail().normalizeEmail(),
], async (req, res, next) => {
  try {
    const { email } = req.body;

    const result = await query('SELECT id, first_name FROM users WHERE email = $1', [email]);

    // Always respond the same way whether or not the email exists,
    // so this endpoint can't be used to check who has an account.
    if (!result.rows.length) {
      return res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await query(
      `UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3`,
      [resetToken, resetExpires, user.id]
    );

    const resetLink = `${process.env.APP_URL || 'https://www.accordlyparent.com'}/early-access/reset-password.html?token=${resetToken}`;
    await sendPasswordResetEmail(email, user.first_name, resetLink);

    logger.info(`Password reset requested for user: ${user.id}`);
    res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

// ── RESET PASSWORD ──
router.post('/reset-password', authLimiter, [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, password } = req.body;

    const result = await query(
      `SELECT id, password_reset_expires FROM users
       WHERE password_reset_token = $1`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    const user = result.rows[0];
    if (new Date(user.password_reset_expires) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const password_hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    await query(
      `UPDATE users
       SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL
       WHERE id = $2`,
      [password_hash, user.id]
    );

    logger.info(`Password reset completed for user: ${user.id}`);
    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    next(err);
  }
});

// ── LOGOUT ──
router.post('/logout', authenticate, async (req, res) => {
  // In production, add the token to a Redis blacklist
  res.json({ success: true });
});

module.exports = router;
