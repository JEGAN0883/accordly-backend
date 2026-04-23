const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

/**
 * Verify JWT token and attach user to request
 * Usage: router.get('/protected', authenticate, handler)
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      'SELECT id, email, first_name, last_name, role, plan, plan_status, dv_waiver FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    next(err);
  }
};

/**
 * Require a specific role or higher
 * Usage: requireRole('attorney')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

/**
 * Require a specific plan tier
 * Plans in order: free < essential < safe < pro
 */
const PLAN_LEVELS = { free: 0, essential: 1, safe: 2, pro: 3, attorney_pro: 2, mediator: 2, judge: 2, court: 3 };

const requirePlan = (minimumPlan) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  
  // DV waiver grants full safe plan access
  if (req.user.dv_waiver && PLAN_LEVELS['safe'] >= PLAN_LEVELS[minimumPlan]) {
    return next();
  }

  const userLevel = PLAN_LEVELS[req.user.plan] ?? 0;
  const requiredLevel = PLAN_LEVELS[minimumPlan] ?? 0;

  if (userLevel < requiredLevel) {
    return res.status(403).json({ 
      error: 'Plan upgrade required', 
      code: 'UPGRADE_REQUIRED',
      required_plan: minimumPlan,
      current_plan: req.user.plan,
    });
  }
  next();
};

module.exports = { authenticate, requireRole, requirePlan };
