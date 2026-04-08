const router = require('express').Router();
const { z } = require('zod');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const validate = require('../middleware/validate');

const createTerminalSchema = z.object({
  name: z.string().min(1),
  locationDescription: z.string().min(1),
  gpsLat: z.number(),
  gpsLng: z.number(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const updateTerminalSchema = z.object({
  name: z.string().min(1).optional(),
  locationDescription: z.string().min(1).optional(),
  gpsLat: z.number().optional(),
  gpsLng: z.number().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const assignFacilitatorSchema = z.object({
  facilitatorId: z.string().uuid(),
});

// POST /terminals — create terminal
router.post(
  '/',
  auth,
  requireRole('ADMIN'),
  validate(createTerminalSchema),
  async (req, res, next) => {
    try {
      const { name, locationDescription, gpsLat, gpsLng, status } = req.body;

      const terminal = await prisma.terminal.create({
        data: { name, locationDescription, gpsLat, gpsLng, ...(status && { status }) },
      });

      await prisma.auditLog.create({
        data: {
          actorId: req.user.id,
          actorRole: 'ADMIN',
          actionType: 'ADMIN_TERMINAL_CREATED',
          targetEntity: 'Terminal',
          targetId: terminal.id,
          metadata: { name, locationDescription, gpsLat, gpsLng, status: terminal.status },
        },
      });

      res.status(201).json(terminal);
    } catch (err) {
      next(err);
    }
  }
);

// GET /terminals — list all terminals with facilitator count
router.get('/', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const terminals = await prisma.terminal.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { facilitators: true } },
      },
    });

    const data = terminals.map((t) => ({
      id: t.id,
      name: t.name,
      locationDescription: t.locationDescription,
      gpsLat: t.gpsLat,
      gpsLng: t.gpsLng,
      status: t.status,
      createdAt: t.createdAt,
      facilitatorCount: t._count.facilitators,
    }));

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /terminals/:id — single terminal with facilitators array
router.get('/:id', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.id },
      include: {
        facilitators: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            createdAt: true,
          },
        },
      },
    });

    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    res.json(terminal);
  } catch (err) {
    next(err);
  }
});

// PATCH /terminals/:id — update terminal
router.patch(
  '/:id',
  auth,
  requireRole('ADMIN'),
  validate(updateTerminalSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const existing = await prisma.terminal.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: 'Terminal not found' });
      }

      const terminal = await prisma.terminal.update({
        where: { id },
        data: req.body,
      });

      await prisma.auditLog.create({
        data: {
          actorId: req.user.id,
          actorRole: 'ADMIN',
          actionType: 'ADMIN_TERMINAL_UPDATED',
          targetEntity: 'Terminal',
          targetId: terminal.id,
          metadata: { changes: req.body },
        },
      });

      res.json(terminal);
    } catch (err) {
      next(err);
    }
  }
);

// POST /terminals/:id/facilitators — assign facilitator to terminal
router.post(
  '/:id/facilitators',
  auth,
  requireRole('ADMIN'),
  validate(assignFacilitatorSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { facilitatorId } = req.body;

      const terminal = await prisma.terminal.findUnique({ where: { id } });
      if (!terminal) {
        return res.status(404).json({ error: 'Terminal not found' });
      }

      const facilitator = await prisma.facilitator.findUnique({
        where: { id: facilitatorId },
      });
      if (!facilitator) {
        return res.status(404).json({ error: 'Facilitator not found' });
      }

      const updated = await prisma.facilitator.update({
        where: { id: facilitatorId },
        data: { terminalId: id },
        select: { id: true, fullName: true, phone: true, terminalId: true },
      });

      await prisma.auditLog.create({
        data: {
          actorId: req.user.id,
          actorRole: 'ADMIN',
          actionType: 'ADMIN_FACILITATOR_ASSIGNED',
          targetEntity: 'Facilitator',
          targetId: facilitatorId,
          metadata: { terminalId: id, terminalName: terminal.name },
        },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
