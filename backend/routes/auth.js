import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const CTX = 'Auth';
const JWT_SECRET = process.env.JWT_SECRET || 'quantum-safe-secret-2026';

/* ── POST /api/auth/register ── */
router.post('/register', async (req, res) => {
  const { username, password, publicKey } = req.body;
  logger.info(`Register attempt`, { username }, CTX);

  if (!username || !password || !publicKey) {
    logger.warn('Register: missing fields', { username }, CTX);
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({ username, password_hash: passwordHash, public_key: publicKey });
    await user.save();
    logger.info(`Registered new user`, { username, id: user._id }, CTX);

    const token = jwt.sign({ id: user._id, username }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username, publicKey } });
  } catch (error) {
    if (error.code === 11000) {
      logger.warn('Register: duplicate username', { username }, CTX);
      return res.status(400).json({ error: 'Username already exists' });
    }
    logger.error('Register: unexpected error', { message: error.message }, CTX);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/* ── POST /api/auth/login ── */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  logger.info(`Login attempt`, { username }, CTX);

  if (!username || !password) {
    logger.warn('Login: missing fields', null, CTX);
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      logger.warn(`Login: user not found`, { username }, CTX);
      return res.status(401).json({ error: 'No account found with that username' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn(`Login: wrong password`, { username }, CTX);
      return res.status(401).json({ error: 'Incorrect password' });
    }

    logger.info(`Login success`, { username, id: user._id }, CTX);
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username: user.username, publicKey: user.public_key } });
  } catch (error) {
    logger.error('Login: unexpected error', { message: error.message }, CTX);
    res.status(500).json({ error: 'Login failed' });
  }
});

/* ── POST /api/auth/update-key ── */
router.post('/update-key', authenticateToken, async (req, res) => {
  const { userId, publicKey } = req.body;
  logger.info('Update-key request', { userId }, CTX);

  // req.user.id is a Mongoose ObjectId — compare as strings
  if (String(req.user.id) !== String(userId)) {
    logger.warn('Update-key: unauthorized', { tokenUser: req.user.id, requested: userId }, CTX);
    return res.status(403).json({ error: 'Unauthorized to modify this user' });
  }

  try {
    await User.findByIdAndUpdate(userId, { public_key: publicKey });
    logger.info('Public key updated', { userId }, CTX);
    res.json({ success: true });
  } catch (error) {
    logger.error('Update-key: error', { message: error.message }, CTX);
    res.status(500).json({ error: 'Key update failed' });
  }
});

export default router;
