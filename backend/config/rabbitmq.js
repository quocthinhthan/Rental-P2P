// backend/config/rabbitmq.js
const amqp = require('amqplib');

const QUEUE_NAME = 'notification_queue';
// Local development can run without the notification broker.
const isEnabled = () => process.env.RABBITMQ_ENABLED === 'true';

let channel = null;
let connecting = null;
let retryTimer = null;
let failedAttempts = 0;

const scheduleRetry = () => {
  if (retryTimer) return;
  const delay = Math.min(5000 * 2 ** Math.min(failedAttempts - 1, 3), 30000);
  console.warn(`[BACKEND] Retrying RabbitMQ in ${delay / 1000}s. Notifications are unavailable until it reconnects.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectRabbitMQ();
  }, delay);
};

const connectRabbitMQ = () => {
  if (!isEnabled()) return Promise.resolve();
  if (channel || connecting) return connecting || Promise.resolve();

  connecting = (async () => {
    let connection;
    try {
      console.log('[BACKEND] Attempting to connect to RabbitMQ...');
      connection = await amqp.connect(process.env.RABBITMQ_URI || 'amqp://127.0.0.1');
      const nextChannel = await connection.createChannel();
      await nextChannel.assertQueue(QUEUE_NAME, { durable: true });
      channel = nextChannel;
      failedAttempts = 0;
      console.log('[BACKEND] RabbitMQ connected successfully.');

      connection.on('error', (err) => {
        console.error('[BACKEND] RabbitMQ connection error:', err.message);
      });
      connection.on('close', () => {
        console.error('[BACKEND] RabbitMQ connection closed.');
        channel = null;
        failedAttempts++;
        scheduleRetry();
      });
    } catch (error) {
      channel = null;
      if (connection) await connection.close().catch(() => {});
      failedAttempts++;
      console.error(`[BACKEND] RabbitMQ connection failed: ${error.message}`);
      scheduleRetry();
    } finally {
      connecting = null;
    }
  })();

  return connecting;
};

// Hàm publish, bây giờ sẽ kiểm tra channel trước khi gửi
const publishToQueue = (data) => {
  if (!isEnabled()) return false;
  if (channel) {
    try {
      channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(data)), { persistent: true });
      return true;
    } catch (err) {
      console.error('[BACKEND] Failed to publish to RabbitMQ:', err.message);
      return false;
    }
  } else {
    // Không ném lỗi để API không bị crash khi RabbitMQ tạm thời không có
    console.warn('[BACKEND] RabbitMQ channel is not available. Skipping publish.');
    return false;
  }
};

module.exports = { connectRabbitMQ, publishToQueue };
