const router = require('express').Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

// GET /drivers/me — driver's own profile + wallet balance
router.get('/me', auth, requireRole('DRIVER'), async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        phone: true,
        licensePlate: true,
        qrPayload: true,
        createdAt: true,
        wallet: {
          select: { balanceTrips: true },
        },
      },
    });

    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    res.json({
      id: driver.id,
      fullName: driver.fullName,
      phone: driver.phone,
      licensePlate: driver.licensePlate,
      qrPayload: driver.qrPayload,
      createdAt: driver.createdAt,
      balanceTrips: driver.wallet?.balanceTrips ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /drivers — paginated list of all drivers (admin)
router.get('/', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [drivers, total] = await Promise.all([
      prisma.driver.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fullName: true,
          phone: true,
          licensePlate: true,
          createdAt: true,
          wallet: { select: { balanceTrips: true } },
          _count: {
            select: {
              scans: { where: { status: 'APPROVED' } },
            },
          },
        },
      }),
      prisma.driver.count(),
    ]);

    const data = drivers.map((d) => ({
      id: d.id,
      fullName: d.fullName,
      phone: d.phone,
      licensePlate: d.licensePlate,
      createdAt: d.createdAt,
      balanceTrips: d.wallet?.balanceTrips ?? 0,
      lifetimeTrips: d._count.scans,
    }));

    res.json({
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /drivers/:id — single driver detail (admin)
router.get('/:id', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        fullName: true,
        phone: true,
        licensePlate: true,
        createdAt: true,
        wallet: { select: { balanceTrips: true } },
        _count: {
          select: {
            scans: { where: { status: 'APPROVED' } },
          },
        },
      },
    });

    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    res.json({
      id: driver.id,
      fullName: driver.fullName,
      phone: driver.phone,
      licensePlate: driver.licensePlate,
      createdAt: driver.createdAt,
      balanceTrips: driver.wallet?.balanceTrips ?? 0,
      lifetimeTrips: driver._count.scans,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
