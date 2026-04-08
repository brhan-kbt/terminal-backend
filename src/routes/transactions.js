const express = require('express');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// GET /transactions/history — paginated scan transaction history for authenticated driver (DRIVER)
router.get('/history', auth, requireRole('DRIVER'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const driverId = req.user.id;

    const [scans, total] = await Promise.all([
      prisma.scanTransaction.findMany({
        where: { driverId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          terminal: { select: { name: true } },
        },
      }),
      prisma.scanTransaction.count({ where: { driverId } }),
    ]);

    const data = scans.map((scan) => ({
      id: scan.id,
      terminalName: scan.terminal.name,
      status: scan.status,
      createdAt: scan.createdAt,
      deductedTrips: 1,
    }));

    res.json({
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
