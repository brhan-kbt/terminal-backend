const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const validate = require('../middleware/validate');

const router = express.Router();

// Rate limiter: 10 requests per phone per 15 minutes
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  handler: (req, res) =>
    res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' }),
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation schemas
const registerDriverSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(9),
  licensePlate: z.string().min(2),
  password: z.string().min(8),
});

const loginSchema = z.object({
  phone: z.string().min(9),
  password: z.string().min(1),
});

// Helper: generate QR JWT signed with QR_SECRET
function generateQrPayload(driverId) {
  return jwt.sign({ driverId }, process.env.QR_SECRET, { expiresIn: '24h' });
}

// POST /auth/drivers/register
router.post('/drivers/register', validate(registerDriverSchema), async (req, res, next) => {
  try {
    const { fullName, phone, licensePlate, password } = req.body;
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await prisma.$transaction(async (tx) => {
      // Create driver with a placeholder qrPayload first to get the id
      const driver = await tx.driver.create({
        data: { fullName, phone, licensePlate, passwordHash, qrPayload: '' },
      });

      const qrPayload = generateQrPayload(driver.id);

      const updatedDriver = await tx.driver.update({
        where: { id: driver.id },
        data: { qrPayload },
      });

      await tx.wallet.create({
        data: { driverId: driver.id, balanceTrips: 0 },
      });

      return updatedDriver;
    });

    // Audit log (best-effort, outside transaction)
    await prisma.auditLog.create({
      data: {
        actorId: result.id,
        actorRole: 'DRIVER',
        actionType: 'DRIVER_REGISTERED',
        targetEntity: 'Driver',
        targetId: result.id,
        metadata: { phone: result.phone },
      },
    });

    return res.status(201).json({
      id: result.id,
      fullName: result.fullName,
      phone: result.phone,
      licensePlate: result.licensePlate,
      createdAt: result.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/drivers/login
router.post('/drivers/login', loginRateLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const driver = await prisma.driver.findUnique({ where: { phone } });

    if (!driver) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, driver.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Regenerate QR payload on each login (fresh 24h expiry)
    const qrPayload = generateQrPayload(driver.id);
    await prisma.driver.update({ where: { id: driver.id }, data: { qrPayload } });

    const accessToken = jwt.sign(
      { id: driver.id, role: 'DRIVER' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      accessToken,
      driver: { id: driver.id, fullName: driver.fullName, phone: driver.phone },
      qrPayload,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/facilitators/login
router.post('/facilitators/login', loginRateLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const facilitator = await prisma.facilitator.findUnique({
      where: { phone },
      include: { terminal: { select: { id: true, name: true } } },
    });

    if (!facilitator) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, facilitator.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = jwt.sign(
      { id: facilitator.id, role: 'FACILITATOR', terminalId: facilitator.terminalId },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      accessToken,
      facilitator: {
        id: facilitator.id,
        fullName: facilitator.fullName,
        phone: facilitator.phone,
        terminalId: facilitator.terminalId,
        terminalName: facilitator.terminal?.name ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/admins/login
router.post('/admins/login', loginRateLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const admin = await prisma.admin.findUnique({ where: { phone } });

    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = jwt.sign(
      { id: admin.id, role: 'ADMIN', adminRole: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      accessToken,
      admin: { id: admin.id, fullName: admin.fullName, phone: admin.phone, role: admin.role },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
