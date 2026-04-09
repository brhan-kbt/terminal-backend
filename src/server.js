require('dotenv').config();

const http = require('http');
const axios = require('axios');
const app = require('./app');
const { initSocket } = require('./events/gateway');
const { startAnomalyDetection } = require('./jobs/anomalyDetection');

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// Attach Socket.io
initSocket(server);

// Start anomaly detection cron
startAnomalyDetection();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Keep-alive ping for Render free tier (prevents spin-down)
// Pings itself every 14 minutes so the service stays warm
if (process.env.NODE_ENV === 'production' && process.env.BACKEND_URL) {
  setInterval(async () => {
    try {
      await axios.get(`${process.env.BACKEND_URL}/health`, { timeout: 5000 });
    } catch (_) {
      // Ignore errors — this is just a keep-alive
    }
  }, 14 * 60 * 1000); // every 14 minutes
}

module.exports = server;
