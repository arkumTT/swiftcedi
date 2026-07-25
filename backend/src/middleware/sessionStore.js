'use strict';

const { randomBytes } = require('crypto');

/**
 * Minimal in-memory session store so RBAC/audit endpoints have something
 * real to authenticate against for this milestone. This is a placeholder,
 * not the platform's final auth mechanism (no persistence across restarts,
 * no multi-instance sharing) — flagged in Decisions_Log.md under Open
 * Questions for a follow-up session to replace with JWT or a persisted
 * session store.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map();

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

module.exports = { createSession, getSession, destroySession };
