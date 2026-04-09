const router = require('express').Router();
const bcrypt = require('bcrypt');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const validate = require('../middleware/validate');

const createFacilitatorSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(9),
  password: z.string().min(8),
  terminalId: z.string().uuid().optional().nullable(),
});

// GET /facilitators/me/stats — today's scan stats for the logged-in facilitator
router.get('/me/stats', auth, requireRole('FACILITATOR'), async (req, res, next) => {
  try {
    const facilitatorId = req.user.id;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const where = { facilitatorId, createdAt: { gte: todayStart, lte: todayEnd } };

    const [total, approved, recent, facilitator] = await Promise.all([
      prisma.scanTransaction.count({ where }),
      prisma.scanTransaction.count({ where: { ...where, status: 'APPROVED' } }),
      prisma.scanTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { driver: { select: { fullName: true, licensePlate: true } } },
      }),
      prisma.facilitator.findUnique({
        where: { id: facilitatorId },
        select: { fullName: true, phone: true, terminal: { select: { name: true, locationDescription: true } } },
      }),
    ]);

    res.json({
      facilitator: {
        fullName: facilitator?.fullName,
        phone: facilitator?.phone,
        terminalName: facilitator?.terminal?.name ?? null,
        terminalLocation: facilitator?.terminal?.locationDescription ?? null,
      },
      stats: { total, approved, rejected: total - approved },
      recentScans: recent,
    });
  } catch (err) {
    next(err);
  }
});

// POST /facilitators — create facilitator (ADMIN)
router.post('/', auth, requireRole('ADMIN'), validate(createFacilitatorSchema), async (req, res, next) => {
  try {
    const { fullName, phone, password, terminalId } = req.body;
    const passwordHash = await bcrypt.hash(password, 12);

    const facilitator = await prisma.facilitator.create({
      data: {
        fullName,
        phone,
        passwordHash,
        terminalId: terminalId || null,
      },
      select: { id: true, fullName: true, phone: true, terminalId: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        actorRole: 'ADMIN',
        actionType: 'ADMIN_FACILITATOR_CREATED',
        targetEntity: 'Facilitator',
        targetId: facilitator.id,
        metadata: { phone, terminalId: terminalId || null },
      },
    });

    res.status(201).json(facilitator);
  } catch (err) {
    next(err);
  }
});

// GET /facilitators — list all facilitators (ADMIN)
router.get('/', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const facilitators = await prisma.facilitator.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fullName: true,
        phone: true,
        terminalId: true,
        createdAt: true,
        terminal: { select: { id: true, name: true } },
      },
    });
    res.json(facilitators);
  } catch (err) {
    next(err);
  }
});

// GET /facilitators/unassigned — facilitators with no terminal (ADMIN)
router.get('/unassigned', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const facilitators = await prisma.facilitator.findMany({
      where: { terminalId: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fullName: true, phone: true },
    });
    res.json(facilitators);
  } catch (err) {
    next(err);
  }
});

// DELETE /facilitators/:id — delete facilitator (ADMIN)
router.delete('/:id', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const facilitator = await prisma.facilitator.findUnique({ where: { id: req.params.id } });
    if (!facilitator) return res.status(404).json({ error: 'Facilitator not found' });

    await prisma.facilitator.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        actorRole: 'ADMIN',
        actionType: 'ADMIN_FACILITATOR_DELETED',
        targetEntity: 'Facilitator',
        targetId: req.params.id,
        metadata: { phone: facilitator.phone },
      },
    });

    res.json({ message: 'Facilitator deleted' });
  } catch (err) {
    next(err);
  }
});

// GET /facilitators/:id — facilitator detail with scan stats (ADMIN)
router.get('/:id', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const facilitator = await prisma.facilitator.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        fullName: true,
        phone: true,
        terminalId: true,
        createdAt: true,
        terminal: { select: { id: true, name: true, locationDescription: true } },
        _count: { select: { scans: true } },
      },
    });

    if (!facilitator) return res.status(404).json({ error: 'Facilitator not found' });

    const [approved, rejected] = await Promise.all([
      prisma.scanTransaction.count({ where: { facilitatorId: req.params.id, status: 'APPROVED' } }),
      prisma.scanTransaction.count({ where: { facilitatorId: req.params.id, status: { not: 'APPROVED' } } }),
    ]);

    res.json({
      ...facilitator,
      totalScans: facilitator._count.scans,
      approvedScans: approved,
      rejectedScans: rejected,
    });
  } catch (err) {
    next(err);
  }
});

// GET /facilitators/:id/scans — paginated scan history for a facilitator (ADMIN)
router.get('/:id/scans', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const where = { facilitatorId: req.params.id };
    if (req.query.status) where.status = req.query.status;
    if (req.query.startDate || req.query.endDate) {
      where.createdAt = {};
      if (req.query.startDate) where.createdAt.gte = new Date(req.query.startDate);
      if (req.query.endDate) where.createdAt.lte = new Date(req.query.endDate + 'T23:59:59Z');
    }

    const [scans, total] = await Promise.all([
      prisma.scanTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          driver: { select: { id: true, fullName: true, phone: true, licensePlate: true } },
          terminal: { select: { id: true, name: true } },
        },
      }),
      prisma.scanTransaction.count({ where }),
    ]);

    res.json({ data: scans, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
