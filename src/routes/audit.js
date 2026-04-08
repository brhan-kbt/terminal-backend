const express = require('express');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// GET /audit — paginated audit log (ADMIN only)
router.get('/', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Build dynamic where clause
    const where = {};

    if (req.query.terminalId) {
      where.metadata = { path: ['terminalId'], equals: req.query.terminalId };
    }

    if (req.query.driverId) {
      where.actorId = req.query.driverId;
    }

    if (req.query.actionType) {
      where.actionType = req.query.actionType;
    }

    if (req.query.startDate || req.query.endDate) {
      where.createdAt = {};
      if (req.query.startDate) {
        where.createdAt.gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        where.createdAt.lte = new Date(req.query.endDate);
      }
    }

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
