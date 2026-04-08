const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const validate = require('../middleware/validate');
const { emitPaymentEvent } = require('../events/gateway');

const router = express.Router();

// Chapa API base URL
const CHAPA_BASE_URL = process.env.CHAPA_BASE_URL || 'https://api.chapa.co/v1';

// Helper: call Chapa initialize endpoint
async function chapaInitialize(payload) {
  const response = await axios.post(
    `${CHAPA_BASE_URL}/transaction/initialize`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return response.data; // { status: 'success', message: '...', data: { checkout_url } }
}

// Helper: call Chapa verify endpoint
async function chapaVerify(txRef) {
  const response = await axios.get(
    `${CHAPA_BASE_URL}/transaction/verify/${txRef}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      },
      timeout: 15000,
    }
  );
  return response.data; // { status: 'success', data: { status: 'success', ... } }
}

// Helper: verify Chapa webhook signature
// Chapa sends either 'Chapa-Signature' or 'x-chapa-signature' header
// The value is HMAC-SHA256 of the raw body signed with CHAPA_WEBHOOK_SECRET
function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.CHAPA_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured (dev mode)

  const sig = headers['chapa-signature'] || headers['x-chapa-signature'];
  if (!sig) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return sig === expected;
}

// GET /payments/packages — list active trip packages (DRIVER)
router.get('/packages', auth, requireRole('DRIVER'), async (req, res, next) => {
  try {
    const packages = await prisma.tripPackage.findMany({
      where: { isActive: true },
      orderBy: { tripCount: 'asc' },
    });
    res.json(packages);
  } catch (err) {
    next(err);
  }
});

// POST /payments/initiate — initiate Chapa payment (DRIVER)
const initiateSchema = z.object({ packageId: z.string().min(1) });

router.post('/initiate', auth, requireRole('DRIVER'), validate(initiateSchema), async (req, res, next) => {
  console.log('[payments] Initiate payment request from driverId:', req.user.id, 'payload:', req.body);
  try {
    const { packageId } = req.body;
    const driverId = req.user.id;

    const pkg = await prisma.tripPackage.findFirst({
      where: { id: packageId, isActive: true },
    });
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    // Generate a readable tx_ref as recommended by Chapa
    const nameParts = driver.fullName.replace(/\s+/g, '-').toLowerCase();
    const txRef = `${nameParts}-${Date.now()}-${uuidv4().slice(0, 8)}`;

    // Split name for Chapa fields
    const parts = driver.fullName.trim().split(' ');
    const firstName = parts[0] || 'Driver';
    const lastName = parts.slice(1).join(' ') || 'User';

    // Generate a safe email from phone number
    const safePhone = driver.phone.replace(/[^0-9]/g, '');
    const email = `${safePhone}@smarttaxi.et`;

    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';

    // Create PENDING payment record BEFORE calling Chapa (Rule 2)
    await prisma.payment.create({
      data: {
        driverId,
        txRef,
        status: 'PENDING',
        packageId,
        packageSize: pkg.tripCount,
        amountEtb: pkg.priceEtb,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: driverId,
        actorRole: 'DRIVER',
        actionType: 'PAYMENT_INITIATED',
        targetEntity: 'Payment',
        targetId: txRef,
        metadata: {
          packageId,
          packageSize: pkg.tripCount,
          amountEtb: pkg.priceEtb.toString(),
        },
      },
    });

    // Call Chapa initialize API
    let chapaResponse;
    console.log(email, firstName, lastName);
    try {
      chapaResponse = await chapaInitialize({
        tx_ref: txRef,
        amount: Number(pkg.priceEtb).toFixed(2),
        currency: 'ETB',
        email: "berhanu@gmail.com",
        first_name: firstName,
        last_name: lastName,
        // phone_number must be 10 digits in 09xxxxxxxx or 07xxxxxxxx format
        // We skip it to avoid validation errors with +251 format
        callback_url: `${backendUrl}/payments/webhook`,
        return_url: `${backendUrl}/payments/return/${txRef}`,
        customization: {
          title: 'Smart Taxi',
          description: `${pkg.tripCount} trips`,
        },
      });
    } catch (chapaErr) {
      const errData = chapaErr.response?.data;
      console.log('[payments] Chapa initiate error response:', errData);
      console.error('[payments] Chapa initiate error:', errData || chapaErr.message, 'txRef:', txRef);
      // Mark payment as failed so driver can retry
      await prisma.payment.update({
        where: { txRef },
        data: { status: 'FAILED', processedAt: new Date() },
      }).catch(() => {});
      return res.status(502).json({
        error: 'Payment gateway error. Please try again.',
        detail: errData?.message || chapaErr.message,
      });
    }

    // Chapa returns: { status: 'success', message: '...', data: { checkout_url } }
    const checkoutUrl = chapaResponse?.data?.checkout_url;
    if (!checkoutUrl) {
      console.error('[payments] No checkout_url in Chapa response:', chapaResponse);
      return res.status(502).json({ error: 'Payment gateway did not return a checkout URL.' });
    }

    res.json({ checkoutUrl, txRef });
  } catch (err) {
    next(err);
  }
});

// GET /payments/status/:txRef — poll payment status (DRIVER)
router.get('/status/:txRef', auth, requireRole('DRIVER'), async (req, res, next) => {
  try {
    const payment = await prisma.payment.findFirst({
      where: { txRef: req.params.txRef, driverId: req.user.id },
      select: {
        txRef: true,
        status: true,
        packageSize: true,
        amountEtb: true,
        createdAt: true,
        processedAt: true,
      },
    });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json(payment);
  } catch (err) {
    next(err);
  }
});

// GET /payments/return/:txRef — Chapa return URL redirect handler
// Chapa redirects here after payment. We verify and update status, then return a simple page.
router.get('/return/:txRef', async (req, res, next) => {
  try {
    const { txRef } = req.params;
    const payment = await prisma.payment.findUnique({ where: { txRef } });

    if (!payment || payment.status !== 'PENDING') {
      return res.send('<html><body><h2>Payment already processed. You can close this page.</h2></body></html>');
    }

    // Verify with Chapa to get final status
    try {
      const verifyResult = await chapaVerify(txRef);
      const chapaStatus = verifyResult?.data?.status;

      if (chapaStatus === 'success') {
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
              actorId: payment.driverId,
              actorRole: 'DRIVER',
              actionType: 'PAYMENT_RETURN_VERIFIED',
              targetEntity: 'Payment',
              targetId: txRef,
              metadata: { packageSize: payment.packageSize, chapaStatus },
            },
          });
        });

        emitPaymentEvent({
          driverId: payment.driverId,
          txRef,
          packageSize: payment.packageSize,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (verifyErr) {
      console.error('[payments] Return verify error:', verifyErr.message);
    }

    // Return a simple page the WebView can detect
    res.send(`<html><body><h2>Payment complete. Return to the app.</h2><p>tx_ref: ${txRef}</p></body></html>`);
  } catch (err) {
    next(err);
  }
});

// GET /payments/history — driver's payment history (DRIVER)
router.get('/history', auth, requireRole('DRIVER'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: { driverId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          txRef: true,
          status: true,
          packageSize: true,
          amountEtb: true,
          createdAt: true,
          processedAt: true,
          package: { select: { name: true } },
        },
      }),
      prisma.payment.count({ where: { driverId: req.user.id } }),
    ]);

    res.json({
      data: payments,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /payments/webhook — Chapa webhook (Public, signature verified)
// Must use express.raw() to get raw body for HMAC verification
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res, next) => {
  try {
    const rawBody = req.body; // Buffer

    // Verify signature
    if (!verifyWebhookSignature(rawBody, req.headers)) {
      console.warn('[webhook] Signature verification failed. IP:', req.ip);
      await prisma.auditLog.create({
        data: {
          actorId: 'SYSTEM',
          actorRole: 'SYSTEM',
          actionType: 'PAYMENT_WEBHOOK_SIGNATURE_FAILED',
          targetEntity: 'Webhook',
          targetId: 'unknown',
          metadata: { ip: req.ip },
        },
      }).catch(() => {});
      return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Chapa webhook payload: { tx_ref, status, ... }
    const { tx_ref, status } = event;

    if (!tx_ref) return res.status(400).json({ error: 'Missing tx_ref' });

    const payment = await prisma.payment.findUnique({ where: { txRef: tx_ref } });
    if (!payment) {
      console.warn('[webhook] Unknown tx_ref:', tx_ref);
      await prisma.auditLog.create({
        data: {
          actorId: 'SYSTEM',
          actorRole: 'SYSTEM',
          actionType: 'PAYMENT_WEBHOOK_UNKNOWN_TXREF',
          targetEntity: 'Payment',
          targetId: tx_ref,
          metadata: { status, ip: req.ip },
        },
      }).catch(() => {});
      // Return 200 so Chapa doesn't keep retrying for unknown refs
      return res.status(200).json({ message: 'OK' });
    }

    // Idempotency: already processed
    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      return res.status(200).json({ message: 'Already processed' });
    }

    // Always verify with Chapa before crediting wallet (best practice from docs)
    let verifiedStatus = status;
    try {
      const verifyResult = await chapaVerify(tx_ref);
      verifiedStatus = verifyResult?.data?.status || status;
    } catch (verifyErr) {
      console.warn('[webhook] Could not verify with Chapa, using webhook status:', verifyErr.message);
    }

    if (verifiedStatus === 'success') {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { txRef: tx_ref },
          data: { status: 'SUCCESS', processedAt: new Date() },
        });
        await tx.wallet.update({
          where: { driverId: payment.driverId },
          data: { balanceTrips: { increment: payment.packageSize } },
        });
        await tx.auditLog.create({
          data: {
            actorId: payment.driverId,
            actorRole: 'DRIVER',
            actionType: 'PAYMENT_WEBHOOK_SUCCESS',
            targetEntity: 'Payment',
            targetId: tx_ref,
            metadata: {
              packageSize: payment.packageSize,
              amountEtb: payment.amountEtb.toString(),
              verifiedStatus,
            },
          },
        });
      });

      emitPaymentEvent({
        driverId: payment.driverId,
        txRef: tx_ref,
        packageSize: payment.packageSize,
        timestamp: new Date().toISOString(),
      });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { txRef: tx_ref },
          data: { status: 'FAILED', processedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            actorId: payment.driverId,
            actorRole: 'DRIVER',
            actionType: 'PAYMENT_WEBHOOK_FAILED',
            targetEntity: 'Payment',
            targetId: tx_ref,
            metadata: { status, verifiedStatus },
          },
        });
      });
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ message: 'OK' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
