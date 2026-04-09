const router = require('express').Router();
const { z } = require('zod');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const validate = require('../middleware/validate');

const packageSchema = z.object({
  name: z.string().min(1),
  tripCount: z.number().int().positive(),
  priceEtb: z.number().positive(),
  isActive: z.boolean().optional(),
});

const updateSchema = packageSchema.partial();

// GET /packages/admin — list all packages (ADMIN)
router.get('/admin', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const packages = await prisma.tripPackage.findMany({ orderBy: { tripCount: 'asc' } });
    res.json(packages);
  } catch (err) { next(err); }
});

// POST /packages — create package (ADMIN)
router.post('/', auth, requireRole('ADMIN'), validate(packageSchema), async (req, res, next) => {
  try {
    const { name, tripCount, priceEtb, isActive } = req.body;
    const pkg = await prisma.tripPackage.create({
      data: { name, tripCount, priceEtb, isActive: isActive ?? true },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user.id, actorRole: 'ADMIN',
        actionType: 'ADMIN_PACKAGE_CREATED', targetEntity: 'TripPackage',
        targetId: pkg.id, metadata: { name, tripCount, priceEtb },
      },
    });
    res.status(201).json(pkg);
  } catch (err) { next(err); }
});

// PATCH /packages/:id — update package (ADMIN)
router.patch('/:id', auth, requireRole('ADMIN'), validate(updateSchema), async (req, res, next) => {
  try {
    const pkg = await prisma.tripPackage.update({
      where: { id: req.params.id },
      data: req.body,
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user.id, actorRole: 'ADMIN',
        actionType: 'ADMIN_PACKAGE_UPDATED', targetEntity: 'TripPackage',
        targetId: pkg.id, metadata: req.body,
      },
    });
    res.json(pkg);
  } catch (err) { next(err); }
});

// DELETE /packages/:id — delete package (ADMIN)
router.delete('/:id', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    await prisma.tripPackage.delete({ where: { id: req.params.id } });
    res.json({ message: 'Package deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
