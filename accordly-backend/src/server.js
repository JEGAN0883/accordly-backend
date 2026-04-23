/**
 * Accordly API Server
 * Patent Pending — USPTO Receipt #75170980
 * 
 * Start: npm start (production) | npm run dev (development)
 * Deploy: Railway, Render, Heroku, or any Node.js host
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { logger } = require('./utils/logger');

// Route imports
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');
const calendarRoutes = require('./routes/calendar');
const paymentRoutes = require('./routes/payments');
const childRoutes = require('./routes/children');
const violationRoutes = require('./routes/violations');
const reportRoutes = require('./routes/reports');
const safetyRoutes = require('./routes/safety');
const dhsRoutes = require('./routes/dhs');
const professionalRoutes = require('./routes/professional');
const webhookRoutes = require('./routes/webhooks');
const healthRoutes = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY MIDDLEWARE ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'https://api.anthropic.com'],
    }
  }
}));

// ── CORS ──
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || corsOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-ID'],
  credentials: true,
  maxAge: 86400,
}));

// ── STRIPE WEBHOOKS (raw body required — must be before json parser) ──
app.use('/api/v1/webhooks/stripe', 
  express.raw({ type: 'application/json' }),
  webhookRoutes
);

// ── BODY PARSING ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── LOGGING ──
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
}

// ── GLOBAL RATE LIMITING ──
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// ── HEALTH CHECK ──
app.use('/health', healthRoutes);

// ── API ROUTES ──
const API = '/api/v1';
app.use(`${API}/auth`,          authRoutes);
app.use(`${API}/users`,         userRoutes);
app.use(`${API}/messages`,      messageRoutes);
app.use(`${API}/calendar`,      calendarRoutes);
app.use(`${API}/payments`,      paymentRoutes);
app.use(`${API}/children`,      childRoutes);
app.use(`${API}/violations`,    violationRoutes);
app.use(`${API}/reports`,       reportRoutes);
app.use(`${API}/safety`,        safetyRoutes);
app.use(`${API}/dhs`,           dhsRoutes);
app.use(`${API}/professional`,  professionalRoutes);

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  logger.error(`${err.status || 500} — ${err.message}`, {
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'An error occurred. Please try again.' 
      : err.message,
  });
});

// ── START ──
app.listen(PORT, () => {
  logger.info(`🛡 Accordly API running on port ${PORT}`);
  logger.info(`📋 Environment: ${process.env.NODE_ENV}`);
  logger.info(`⚖️ Patent Pending — USPTO #75170980`);
});

module.exports = app;
