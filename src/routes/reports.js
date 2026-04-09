const express = require('express');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { getAnomalies } = require('../jobs/anomalyDetection');

const router = express.Router();

// Helper: get start and end of a given date (ISO string or Date), defaulting to today
function getDayBounds(dateStr) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

// GET /reports/summary — system-wide summary for today (ADMIN)
router.get('/summary', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { start, end } = getDayBounds();

    const [activeDrivers, tripsToday, revenueResult, activeTerminals] = await Promise.all([
      prisma.driver.count(),
      prisma.scanTransaction.count({
        where: { status: 'APPROVED', createdAt: { gte: start, lte: end } },
      }),
      prisma.payment.aggregate({
        where: { status: 'SUCCESS', createdAt: { gte: start, lte: end } },
        _sum: { amountEtb: true },
      }),
      prisma.terminal.count({ where: { status: 'ACTIVE' } }),
    ]);

    res.json({
      activeDrivers,
      tripsToday,
      revenueToday: revenueResult._sum.amountEtb ?? 0,
      activeTerminals,
    });
  } catch (err) {
    next(err);
  }
});

// GET /reports/terminals/:id/daily — per-terminal daily stats (ADMIN)
router.get('/terminals/:id/daily', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const terminalId = req.params.id;
    const { start, end } = getDayBounds(req.query.date);

    const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });

    const [tripsProcessed, revenueResult, failedScans] = await Promise.all([
      prisma.scanTransaction.count({
        where: { terminalId, status: 'APPROVED', createdAt: { gte: start, lte: end } },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'SUCCESS',
          createdAt: { gte: start, lte: end },
          driver: { scans: { some: { terminalId } } },
        },
        _sum: { amountEtb: true },
      }),
      prisma.scanTransaction.count({
        where: {
          terminalId,
          status: { in: ['REJECTED_ZERO_BALANCE', 'REJECTED_INVALID_QR', 'REJECTED_TERMINAL_INACTIVE'] },
          createdAt: { gte: start, lte: end },
        },
      }),
    ]);

    res.json({
      terminalId,
      date: start.toISOString().split('T')[0],
      tripsProcessed,
      revenue: revenueResult._sum.amountEtb ?? 0,
      failedScans,
    });
  } catch (err) {
    next(err);
  }
});

// GET /reports/revenue — revenue grouped by terminal for a date range (ADMIN)
router.get('/revenue', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const where = { status: 'SUCCESS' };

    if (req.query.startDate || req.query.endDate) {
      where.createdAt = {};
      if (req.query.startDate) where.createdAt.gte = new Date(req.query.startDate);
      if (req.query.endDate) where.createdAt.lte = new Date(req.query.endDate);
    }

    // Get all terminals (optionally filtered)
    const terminalFilter = req.query.terminalId ? { id: req.query.terminalId } : {};
    const terminals = await prisma.terminal.findMany({
      where: terminalFilter,
      select: { id: true, name: true },
    });

    // For each terminal, sum revenue from payments of drivers who scanned there
    const results = await Promise.all(
      terminals.map(async (terminal) => {
        const revenue = await prisma.payment.aggregate({
          where: {
            ...where,
            driver: {
              scans: {
                some: {
                  terminalId: terminal.id,
                  ...(where.createdAt ? { createdAt: where.createdAt } : {}),
                },
              },
            },
          },
          _sum: { amountEtb: true },
        });
        return {
          terminalId: terminal.id,
          terminalName: terminal.name,
          revenue: revenue._sum.amountEtb ?? 0,
        };
      })
    );

    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

// GET /reports/failed-scans — failed scan counts per terminal per day (ADMIN)
router.get('/failed-scans', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { start, end } = getDayBounds(req.query.date);

    const terminalWhere = req.query.terminalId ? { id: req.query.terminalId } : {};
    const terminals = await prisma.terminal.findMany({
      where: terminalWhere,
      select: { id: true, name: true },
    });

    const results = await Promise.all(
      terminals.map(async (terminal) => {
        const failedScans = await prisma.scanTransaction.count({
          where: {
            terminalId: terminal.id,
            status: { in: ['REJECTED_ZERO_BALANCE', 'REJECTED_INVALID_QR', 'REJECTED_TERMINAL_INACTIVE'] },
            createdAt: { gte: start, lte: end },
          },
        });
        return {
          terminalId: terminal.id,
          terminalName: terminal.name,
          failedScans,
          date: start.toISOString().split('T')[0],
        };
      })
    );

    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

// GET /reports/anomalies — currently flagged anomalous terminals (ADMIN)
router.get('/anomalies', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const anomalies = getAnomalies();
    res.json({ data: anomalies });
  } catch (err) {
    next(err);
  }
});

// GET /reports/chart-data — trips + revenue for charts, supports startDate/endDate (ADMIN)
router.get('/chart-data', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = [];

    if (req.query.startDate && req.query.endDate) {
      // Custom date range — iterate each day between startDate and endDate
      const start = new Date(req.query.startDate);
      const end   = new Date(req.query.endDate);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(23, 59, 59, 999);

      // Build day-by-day array (cap at 60 days to avoid huge queries)
      const current = new Date(start);
      let dayCount = 0;
      while (current <= end && dayCount < 60) {
        const dayStart = new Date(current);
        dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd = new Date(current);
        dayEnd.setUTCHours(23, 59, 59, 999);

        const [trips, revenueResult, failedScans] = await Promise.all([
          prisma.scanTransaction.count({
            where: { status: 'APPROVED', createdAt: { gte: dayStart, lte: dayEnd } },
          }),
          prisma.payment.aggregate({
            where: { status: 'SUCCESS', createdAt: { gte: dayStart, lte: dayEnd } },
            _sum: { amountEtb: true },
          }),
          prisma.scanTransaction.count({
            where: {
              status: { in: ['REJECTED_ZERO_BALANCE', 'REJECTED_INVALID_QR', 'REJECTED_TERMINAL_INACTIVE'] },
              createdAt: { gte: dayStart, lte: dayEnd },
            },
          }),
        ]);

        result.push({
          date: dayStart.toISOString().split('T')[0],
          label: dayStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          trips,
          revenue: Number(revenueResult._sum.amountEtb ?? 0),
          failedScans,
        });

        current.setUTCDate(current.getUTCDate() + 1);
        dayCount++;
      }
    } else {
      // Default: last 7 days
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - i);
        const { start, end } = getDayBounds(date.toISOString().split('T')[0]);

        const [trips, revenueResult, failedScans] = await Promise.all([
          prisma.scanTransaction.count({
            where: { status: 'APPROVED', createdAt: { gte: start, lte: end } },
          }),
          prisma.payment.aggregate({
            where: { status: 'SUCCESS', createdAt: { gte: start, lte: end } },
            _sum: { amountEtb: true },
          }),
          prisma.scanTransaction.count({
            where: {
              status: { in: ['REJECTED_ZERO_BALANCE', 'REJECTED_INVALID_QR', 'REJECTED_TERMINAL_INACTIVE'] },
              createdAt: { gte: start, lte: end },
            },
          }),
        ]);

        result.push({
          date: start.toISOString().split('T')[0],
          label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          trips,
          revenue: Number(revenueResult._sum.amountEtb ?? 0),
          failedScans,
        });
      }
    }

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
