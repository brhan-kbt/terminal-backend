const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let _io = null;

/**
 * Initialize Socket.io on the given HTTP server.
 * Configures the /events namespace with JWT auth via ?token= query param.
 */
function initSocket(server) {
  _io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const eventsNs = _io.of('/events');

  // Authenticate connections via ?token=<jwt> query param
  eventsNs.use((socket, next) => {
    const token = socket.handshake.query.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = payload;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  eventsNs.on('connection', (socket) => {
    console.log(`[gateway] client connected: ${socket.id} role=${socket.user?.role}`);
    socket.on('disconnect', () => {
      console.log(`[gateway] client disconnected: ${socket.id}`);
    });
  });
}

/**
 * Emit a scan event (scan.approved or scan.rejected) to the /events namespace.
 */
function emitScanEvent(eventName, payload) {
  if (_io) {
    _io.of('/events').emit(eventName, payload);
  }
}

/**
 * Emit a payment.confirmed event to the /events namespace.
 */
function emitPaymentEvent(payload) {
  if (_io) {
    _io.of('/events').emit('payment.confirmed', payload);
  }
}

module.exports = { initSocket, emitScanEvent, emitPaymentEvent };
