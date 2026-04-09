const express = require('express');
const axios = require('axios');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { emitPaymentEvent } = require('../events/gateway');

const router = express.Router();

// GET /admin/payments — paginated payments list (ADMIN)
router.get('/payments', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 15));
    const skip = (page - 1) * limit;

    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.driverId) where.driverId = req.query.driverId;
    if (req.query.search) {
      where.OR = [
        { txRef: { contains: req.query.search, mode: 'insensitive' } },
        { driver: { fullName: { contains: req.query.search, mode: 'insensitive' } } },
        { driver: { phone: { contains: req.query.search, mode: 'insensitive' } } },
      ];
    }
    if (req.query.startDate || req.query.endDate) {
      where.createdAt = {};
      if (req.query.startDate) where.createdAt.gte = new Date(req.query.startDate);
      if (req.query.endDate) where.createdAt.lte = new Date(req.query.endDate + 'T23:59:59Z');
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          driver: { select: { id: true, fullName: true, phone: true } },
          package: { select: { name: true, tripCount: true } },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({ data: payments, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
});

// POST /admin/payments/verify/:txRef — manually verify a Chapa payment (ADMIN only)
router.post('/payments/verify/:txRef', auth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { txRef } = req.params;

    // Find the payment record
    const payment = await prisma.payment.findUnique({ where: { txRef } });
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Call Chapa verify API — GET /transaction/verify/:txRef
    let chapaResult;
    try {
      const response = await axios.get(
        `${process.env.CHAPA_BASE_URL || 'https://api.chapa.co/v1'}/transaction/verify/${txRef}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
          },
          timeout: 15000,
        }
      );
      chapaResult = response.data;
    } catch (chapaErr) {
      console.error('[admin] Chapa verify error:', chapaErr.response?.data || chapaErr.message);
      return res.status(502).json({ error: 'Payment gateway error. Please try again.' });
    }

    // Chapa verify response: { status: 'success', data: { status: 'success', ... } }
    const chapaStatus = chapaResult?.data?.status;

    // Only update wallet if Chapa says success AND payment is still PENDING
    if (chapaStatus === 'success' && payment.status === 'PENDING') {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { txRef },
          data: { status: 'SUCCESS', processedAt: new Date() },
        });

        await tx.wallet.update({
          where: { driverId: payment.driverId },
          data: { balanceTrips: { increment: payment.packageSize } },
        });

        await tx.auditLog.create({
          data: {
            actorId: req.user.id,
            actorRole: 'ADMIN',
            actionType: 'PAYMENT_MANUAL_VERIFIED',
            targetEntity: 'Payment',
            targetId: txRef,
            metadata: {
              driverId: payment.driverId,
              packageSize: payment.packageSize,
              amountEtb: payment.amountEtb.toString(),
              chapaStatus,
            },
          },
        });
      });

      emitPaymentEvent({
        driverId: payment.driverId,
        txRef,
        packageSize: payment.packageSize,
        timestamp: new Date().toISOString(),
      });

      return res.json({
        message: 'Payment verified and wallet credited',
        txRef,
        chapaStatus,
        packageSize: payment.packageSize,
      });
    }

    // Not success or already processed — return status without modifying wallet
    return res.json({
      message: 'Payment not updated',
      txRef,
      chapaStatus,
      paymentStatus: payment.status,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
