const router = require('express').Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

// GET /wallet/balance — driver's own trip balance
router.get('/balance', auth, requireRole('DRIVER'), async (req, res, next) => {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { driverId: req.user.id },
      select: { balanceTrips: true },
    });

    res.json({ balanceTrips: wallet?.balanceTrips ?? 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
