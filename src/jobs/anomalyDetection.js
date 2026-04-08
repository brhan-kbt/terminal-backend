const cron = require('node-cron');
const prisma = require('../lib/prisma');

// In-memory store: Map<terminalId, { terminalId, terminalName, flaggedAt, tripCount }>
const anomalyMap = new Map();

// EAT is UTC+3
function isOperatingHours() {
  const now = new Date();
  const eatHour = (now.getUTCHours() + 3) % 24;
  return eatHour >= 6 && eatHour < 22;
}

async function runAnomalyCheck() {
  if (!isOperatingHours()) return;

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Get all active terminals
    const activeTerminals = await prisma.terminal.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
    });

    // Get trip counts per terminal in last 60 min
    const recentScans = await prisma.scanTransaction.groupBy({
      by: ['terminalId'],
      where: {
        status: 'APPROVED',
        createdAt: { gte: oneHourAgo },
      },
      _count: { id: true },
    });

    const scanCountMap = new Map(recentScans.map((s) => [s.terminalId, s._count.id]));

    for (const terminal of activeTerminals) {
      const tripCount = scanCountMap.get(terminal.id) || 0;
      if (tripCount < 5) {
        if (!anomalyMap.has(terminal.id)) {
          anomalyMap.set(terminal.id, {
            terminalId: terminal.id,
            terminalName: terminal.name,
            flaggedAt: new Date().toISOString(),
            tripCount,
          });
        }
      } else {
        anomalyMap.delete(terminal.id);
      }
    }
  } catch (err) {
    console.error('[anomaly] Check failed:', err.message);
  }
}

function startAnomalyDetection() {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', runAnomalyCheck);
  console.log('[anomaly] Detection cron started (every 15 min)');
}

function getAnomalies() {
  return Array.from(anomalyMap.values());
}

module.exports = { startAnomalyDetection, getAnomalies };
