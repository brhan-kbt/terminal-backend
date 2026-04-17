const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const validate = require('../middleware/validate');
const { emitScanEvent } = require('../events/gateway');

const router = express.Router();

// In-flight request tracking to handle concurrent duplicate requests (Rule 8, Case 2)
const inFlightKeys = new Set();

const scanSchema = z.object({
  qrPayload: z.string().min(1),
  idempotencyKey: z.string().uuid(),
});

// POST /scan — FACILITATOR only
router.post('/', auth, requireRole('FACILITATOR'), validate(scanSchema), async (req, res, next) => {
  const { qrPayload, idempotencyKey } = req.body;
  const facilitatorId = req.user.id;
  const terminalId = req.user.terminalId;

  // Step 1: Verify QR JWT with QR_SECRET
  let driverId;
  try {
    const decoded = jwt.verify(qrPayload, process.env.QR_SECRET);
    driverId = decoded.driverId;
  } catch (err) {
    // Invalid or expired QR — log best-effort then reject
    await prisma.auditLog.create({
      data: {
        actorId: facilitatorId,
        actorRole: 'FACILITATOR',
        actionType: 'SCAN_REJECTED_INVALID_QR',
        targetEntity: 'Driver',
        targetId: 'unknown',
        metadata: { idempotencyKey, terminalId, reason: 'INVALID_QR' },
      },
    }).catch(() => {});
    return res.status(404).json({
      status: 'REJECTED',
      reason: 'DRIVER_NOT_FOUND',
      message: 'Driver Not Found',
    });
  }

  // Step 1b: Verify the QR payload matches the driver's CURRENT stored qrPayload.
  // This invalidates old QR codes after regeneration.
  const driverForQrCheck = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { qrPayload: true },
  });
  if (!driverForQrCheck || driverForQrCheck.qrPayload !== qrPayload) {
    await prisma.auditLog.create({
      data: {
        actorId: facilitatorId,
        actorRole: 'FACILITATOR',
        actionType: 'SCAN_REJECTED_INVALID_QR',
        targetEntity: 'Driver',
        targetId: driverId,
        metadata: { idempotencyKey, terminalId, reason: 'QR_REVOKED' },
      },
    }).catch(() => {});
    return res.status(404).json({
      status: 'REJECTED',
      reason: 'DRIVER_NOT_FOUND',
      message: 'QR Code Revoked — Please show updated QR',
    });
  }

  // Step 2: Check idempotency record (already processed)
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { key: idempotencyKey },
  });
  if (existing) {
    if (new Date() < new Date(existing.expiresAt)) {
      // Return cached result within TTL
      return res.status(200).json(existing.result);
    }
    // Expired record — delete and treat as new request
    await prisma.idempotencyRecord.delete({ where: { key: idempotencyKey } }).catch(() => {});
  }

  // Step 3: Check if this key is currently in-flight (concurrent duplicate)
  if (inFlightKeys.has(idempotencyKey)) {
    return res.status(409).json({ error: 'Request already in progress' });
  }

  inFlightKeys.add(idempotencyKey);

  try {
    // Step 4: Check terminal status
    const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!terminal || terminal.status === 'INACTIVE') {
      await prisma.auditLog.create({
        data: {
          actorId: facilitatorId,
          actorRole: 'FACILITATOR',
          actionType: 'SCAN_REJECTED_TERMINAL_INACTIVE',
          targetEntity: 'Terminal',
          targetId: terminalId || 'unknown',
          metadata: { idempotencyKey, driverId },
        },
      }).catch(() => {});
      return res.status(403).json({
        status: 'REJECTED',
        reason: 'TERMINAL_INACTIVE',
        message: 'Terminal is inactive',
      });
    }

    // Step 5: Verify driver exists
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) {
      return res.status(404).json({
        status: 'REJECTED',
        reason: 'DRIVER_NOT_FOUND',
        message: 'Driver Not Found',
      });
    }

    // Step 6: Atomic transaction with SELECT FOR UPDATE
    const scanResult = await prisma.$transaction(async (tx) => {
      // Lock the wallet row to prevent concurrent deductions (Rule 4)
      const wallets = await tx.$queryRaw`
        SELECT id, "balanceTrips" FROM "Wallet"
        WHERE "driverId" = ${driverId}
        FOR UPDATE
      `;

      const wallet = wallets[0];

      if (!wallet || wallet.balanceTrips <= 0) {
        // Rule 5: Zero balance — hard reject
        await tx.scanTransaction.create({
          data: {
            driverId,
            facilitatorId,
            terminalId,
            idempotencyKey,
            status: 'REJECTED_ZERO_BALANCE',
          },
        });

        await tx.auditLog.create({
          data: {
            actorId: facilitatorId,
            actorRole: 'FACILITATOR',
            actionType: 'SCAN_REJECTED_ZERO_BALANCE',
            targetEntity: 'Driver',
            targetId: driverId,
            metadata: { idempotencyKey, terminalId, balance: wallet?.balanceTrips ?? 0 },
          },
        });

        return {
          approved: false,
          response: {
            status: 'REJECTED',
            reason: 'INSUFFICIENT_BALANCE',
            message: 'Insufficient Balance — Driver Cannot Depart',
          },
          httpStatus: 422,
        };
      }

      // Rule 3: Deduct exactly 1 trip
      await tx.$executeRaw`
        UPDATE "Wallet"
        SET "balanceTrips" = "balanceTrips" - 1, "updatedAt" = NOW()
        WHERE "driverId" = ${driverId}
      `;

      const newBalance = Number(wallet.balanceTrips) - 1;

      await tx.scanTransaction.create({
        data: {
          driverId,
          facilitatorId,
          terminalId,
          idempotencyKey,
          status: 'APPROVED',
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: facilitatorId,
          actorRole: 'FACILITATOR',
          actionType: 'SCAN_APPROVED',
          targetEntity: 'Driver',
          targetId: driverId,
          metadata: { idempotencyKey, terminalId, newBalance },
        },
      });

      // Rule 8: Store idempotency record with 60s TTL
      const expiresAt = new Date(Date.now() + 60 * 1000);
      const approvedResult = {
        status: 'APPROVED',
        driverName: driver.fullName,
        remainingBalance: newBalance,
      };

      await tx.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          result: approvedResult,
          expiresAt,
        },
      });

      return {
        approved: true,
        response: approvedResult,
        httpStatus: 200,
        newBalance,
      };
    });

    // Step 7: Emit WebSocket event AFTER commit
    if (scanResult.approved) {
      emitScanEvent('scan.approved', {
        terminalId,
        driverId,
        driverName: driver.fullName,
        remainingBalance: scanResult.newBalance,
        timestamp: new Date().toISOString(),
      });
    } else {
      emitScanEvent('scan.rejected', {
        terminalId,
        driverId,
        reason: scanResult.response.reason,
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(scanResult.httpStatus).json(scanResult.response);

  } catch (err) {
    next(err);
  } finally {
    inFlightKeys.delete(idempotencyKey);
  }
});

module.exports = router;
