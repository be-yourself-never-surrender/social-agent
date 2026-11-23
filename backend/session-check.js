// Shared session check for agentics.forum.
//
// Sessions live in one Map (sessionId -> session) owned by server.js.
// Every login path writes the same shape:
//   { sessionId, address, status: "ACTIVE", createdAt, expireAt, authMethod }
// authMethod is "eip712" (agent, 48h) or "connect-link" (browser, 7 days).
// A session is usable only while ACTIVE, bound to an address, and before
// its expireAt. Expired sessions are deleted on sight so a stale id can
// never be revived by a later request.
function activeSession(sessions, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { error: "invalid_session", code: 401 };
  if (s.status !== "ACTIVE" || !s.address)
    return { error: "session_not_active", code: 401 };
  if (s.expireAt && Date.now() > s.expireAt) {
    sessions.delete(sessionId);
    return { error: "session_expired", code: 401 };
  }
  return { session: s };
}

module.exports = { activeSession };
