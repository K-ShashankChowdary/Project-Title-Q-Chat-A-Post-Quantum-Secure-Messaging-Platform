import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import { connectDB, User, Message } from './db/database.js';
import authRoutes from './routes/auth.js';
import messageRoutes from './routes/messages.js';
import { authenticateToken } from './middleware/auth.js';
import { logger } from './utils/logger.js';

dotenv.config();

// ── Connect to MongoDB ──
connectDB();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST'] }
});

// ── HTTP request logger (Morgan → our logger) ──
app.use((req, _res, next) => { req._startTime = Date.now(); next(); });
app.use(morgan((tokens, req, res) => {
  const ms     = Date.now() - (req._startTime || Date.now());
  const status = parseInt(tokens.status(req, res)) || 0;
  logger.http(req, status, ms);
  return null; // morgan itself writes nothing; we handle output
}));

app.use(cors());
app.use(express.json());

// ── Routes ──
app.use('/api/auth',     authRoutes);
app.use('/api/messages', messageRoutes);

// ── Users endpoint ──
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } }).select('username public_key');
    const formatted = users.map(u => ({ id: u._id, username: u.username, public_key: u.public_key }));
    logger.info(`Users listed`, { count: formatted.length, requestor: req.user.username }, 'Users');
    res.json(formatted);
  } catch (error) {
    logger.error('Failed to fetch users', { message: error.message }, 'Users');
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── Socket.io ──
const onlineUsers = new Map(); // userId → socketId

io.on('connection', (socket) => {
  logger.event(`Socket connected`, { socketId: socket.id }, 'Socket');

  socket.on('register_socket', async (userId) => {
    socket.userId = String(userId); // store for O(1) disconnect cleanup
    onlineUsers.set(String(userId), socket.id);
    logger.event('User registered socket', { userId, socketId: socket.id, online: onlineUsers.size }, 'Socket');
    io.emit('user_status', { userId, status: 'online' });

    // ── Deliver any messages that arrived while this user was offline ──
    try {
      const pending = await Message.find({
        to_user_id: userId,
        delivered:  false
      }).sort({ timestamp: 1 });

      if (pending.length > 0) {
        logger.info(`Delivering ${pending.length} offline message(s)`, { userId }, 'Socket');
        for (const msg of pending) {
          socket.emit('new_message', {
            id:       msg._id,
            fromId:   msg.from_user_id,
            payload:  msg.payload,
            timestamp: msg.timestamp
          });
        }
        // Mark all as delivered
        await Message.updateMany(
          { _id: { $in: pending.map(m => m._id) } },
          { $set: { delivered: true } }
        );
      }
    } catch (err) {
      logger.error('Offline delivery failed', { message: err.message }, 'Socket');
    }
  });

  socket.on('send_message', async ({ toId, fromId, payload, senderPayload }) => {
    logger.event('Relay message', { fromId, toId }, 'Socket');
    try {
      // Check if recipient is currently connected
      const toSocket = onlineUsers.get(String(toId));
      
      // Save message, mark as delivered immediately if they are online
      const msg = new Message({
        from_user_id:   fromId,
        to_user_id:     toId,
        payload,
        sender_payload: senderPayload || null,
        delivered:      !!toSocket 
      });
      await msg.save();
      logger.info('Message saved', { id: msg._id, fromId, toId }, 'Socket');

      if (toSocket) {
        io.to(toSocket).emit('new_message', {
          id: msg._id, fromId, payload, timestamp: msg.timestamp
        });
        logger.event('Message delivered', { toId, socketId: toSocket }, 'Socket');
      } else {
        logger.warn('Recipient offline — message persisted for delivery on reconnect', { toId }, 'Socket');
      }
    } catch (error) {
      logger.error('send_message failed', { message: error.message }, 'Socket');
    }
  });

  socket.on('disconnect', (reason) => {
    if (socket.userId) {
      if (onlineUsers.get(socket.userId) === socket.id) {
        onlineUsers.delete(socket.userId);
      }
      logger.event('User disconnected', { userId: socket.userId, reason, remaining: onlineUsers.size }, 'Socket');
      io.emit('user_status', { userId: socket.userId, status: 'offline' });
    }
  });

  socket.on('connect_error', (err) => {
    logger.error('Socket connect_error', { message: err.message }, 'Socket');
  });
});

// ── Global error handler ──
app.use((err, req, res, _next) => {
  logger.error('Unhandled express error', { message: err.message, stack: err.stack }, 'Express');
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  logger.info(`QChat backend running`, { port: PORT, env: process.env.NODE_ENV || 'development' }, 'Server');
});
