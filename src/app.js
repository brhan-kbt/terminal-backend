const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth');
const driversRouter = require('./routes/drivers');
const walletRouter = require('./routes/wallet');
const scanRouter = require('./routes/scan');
const paymentsRouter = require('./routes/payments');
const transactionsRouter = require('./routes/transactions');
const terminalsRouter = require('./routes/terminals');
const facilitatorsRouter = require('./routes/facilitators');
const reportsRouter = require('./routes/reports');
const auditRouter = require('./routes/audit');
const adminRouter = require('./routes/admin');

const app = express();

// --- Core middleware ---
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// --- Routes ---
app.use('/auth', authRouter);
app.use('/drivers', driversRouter);
app.use('/wallet', walletRouter);
app.use('/scan', scanRouter);
app.use('/payments', paymentsRouter);
app.use('/transactions', transactionsRouter);
app.use('/terminals', terminalsRouter);
app.use('/facilitators', facilitatorsRouter);
app.use('/reports', reportsRouter);
app.use('/audit', auditRouter);
app.use('/admin', adminRouter);

// --- Global error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Prisma known request error: P2002 = unique constraint violation
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'A record with that value already exists' });
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({ error: message });
});

module.exports = app;
