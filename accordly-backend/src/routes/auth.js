const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
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

// ── LOGOUT ──
router.post('/logout', authenticate, async (req, res) => {
  // In production, add the token to a Redis blacklist
  res.json({ success: true });
});

module.exports = router;
