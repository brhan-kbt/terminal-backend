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

module.exports = router;
