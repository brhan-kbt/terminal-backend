require('dotenv').config();

const http = require('http');
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

module.exports = server;
