// server.js
// Candela Obscura shared dice roller with GM, hidden rolls, history & sessions

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
});

// Serve static client
app.use(express.static(path.join(__dirname, "public")));

// sessions: Map<sessionId, {
//   users: Map<socketId, { name, clientId }>
//   gmClientId: string | null
//   gmSocketId: string | null
//   history: Roll[]
//   cleanupTimer: NodeJS.Timeout | null
// }>
const sessions = new Map();
const EMPTY_SESSION_GRACE_MS = 60 * 60 * 1000;

function normalizeSessionId(id) {
  if (!id) return null;
  return id.trim().toUpperCase();
}

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      users: new Map(),
      gmClientId: null,
      gmSocketId: null,
      history: [],
      cleanupTimer: null,
    });
  }
  return sessions.get(sessionId);
}

function makeRoll({ by, sessionId, dice, hidden, clientId }) {
  return {
    id: Date.now().toString(36) + "-" + Math.random().toString(16).slice(2),
    by,
    sessionId,
    dice, // [{value,gilded}]
    hidden: !!hidden,
    timestamp: new Date().toISOString(),
    clientId,
  };
}

function buildUsersPayload(session, includeClientIds) {
  const users = [];
  for (const [socketId, info] of session.users.entries()) {
    const entry = {
      id: socketId,
      name: info.name,
      isGM: info.clientId === session.gmClientId,
    };
    if (includeClientIds) {
      entry.clientId = info.clientId;
    }
    users.push(entry);
  }
  return users;
}

function buildHistoryForClient(session, clientId) {
  const isGM = clientId && clientId === session.gmClientId;
  if (isGM) return session.history.slice();
  return session.history.filter((r) => !r.hidden);
}

function cleanupSessionIfEmpty(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.users.size > 0) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    return;
  }

  if (session.cleanupTimer) return;

  session.cleanupTimer = setTimeout(() => {
    const current = sessions.get(sessionId);
    if (!current) return;
    if (current.users.size === 0 && current.history.length === 0) {
      sessions.delete(sessionId);
      return;
    }
    current.cleanupTimer = null;
  }, EMPTY_SESSION_GRACE_MS);
}

io.on("connection", (socket) => {
  socket.data.sessionId = null;
  socket.data.name = null;
  socket.data.clientId = null;

  // Join/create a session
  socket.on("joinSession", ({ sessionId, name, clientId }) => {
    const normalized = normalizeSessionId(sessionId);
    const safeName = (name || "Anonymous").trim().substring(0, 24) || "Anonymous";
    const safeClientId =
      (clientId || "").toString().substring(0, 64) || "c-" + Math.random().toString(36).slice(2);

    if (!normalized) {
      socket.emit("errorMessage", "Invalid session ID.");
      return;
    }

    const session = getOrCreateSession(normalized);
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    socket.data.sessionId = normalized;
    socket.data.name = safeName;
    socket.data.clientId = safeClientId;

    socket.join(normalized);

    // register user
    session.users.set(socket.id, { name: safeName, clientId: safeClientId });

    // decide GM – first clientId wins, persists across reconnect
    if (!session.gmClientId) {
      session.gmClientId = safeClientId;
    }
    if (safeClientId === session.gmClientId) {
      session.gmSocketId = socket.id;
    }

    const isGM = safeClientId === session.gmClientId;
    const usersPayload = buildUsersPayload(session, isGM);
    const historyForClient = buildHistoryForClient(session, safeClientId);

    socket.emit("sessionJoined", {
      sessionId: normalized,
      isGM,
      users: usersPayload,
      history: historyForClient,
    });

    const publicUsersPayload = buildUsersPayload(session, false);
    const gmSocketId = session.gmSocketId;
    const gmConnected = gmSocketId && session.users.has(gmSocketId);

    let broadcast = socket.to(normalized);
    if (gmConnected) {
      broadcast = broadcast.except(gmSocketId);
    }
    broadcast.emit("userJoined", { users: publicUsersPayload });

    if (gmConnected && gmSocketId !== socket.id) {
      io.to(gmSocketId).emit("userJoined", {
        users: buildUsersPayload(session, true),
      });
    }
  });

  // Soft refresh of session state
  socket.on("refreshSession", () => {
    const sessionId = socket.data.sessionId;
    const clientId = socket.data.clientId;
    if (!sessionId || !sessions.has(sessionId)) {
      socket.emit("errorMessage", "Not in a session.");
      return;
    }

    const session = sessions.get(sessionId);
    const isGM = clientId && clientId === session.gmClientId;
    const usersPayload = buildUsersPayload(session, isGM);
    const historyForClient = buildHistoryForClient(session, clientId);

    socket.emit("sessionState", {
      sessionId,
      isGM,
      users: usersPayload,
      history: historyForClient,
    });
  });

  // Roll dice (normal or hidden)
  socket.on("rollDice", ({ numDice, numGilded, hidden }) => {
    const sessionId = socket.data.sessionId;
    const clientId = socket.data.clientId;
    const name = socket.data.name || "Anonymous";

    if (!sessionId || !sessions.has(sessionId)) {
      socket.emit("errorMessage", "You must join a session first.");
      return;
    }

    const session = sessions.get(sessionId);

    let nd = Number(numDice);
    let ng = Number(numGilded);
    if (!Number.isFinite(nd)) nd = 1;
    if (!Number.isFinite(ng)) ng = 0;

    nd = Math.max(1, Math.min(6, nd));
    ng = Math.max(0, Math.min(nd, ng));

    const dice = [];
    for (let i = 0; i < nd; i++) {
      const value = Math.floor(Math.random() * 6) + 1;
      const gilded = i < ng;
      dice.push({ value, gilded });
    }

    const roll = makeRoll({
      by: name,
      sessionId,
      dice,
      hidden: !!hidden,
      clientId,
    });

    session.history.push(roll);
    if (session.history.length > 100) {
      session.history.shift();
    }

    if (roll.hidden) {
      // Hidden: only GM sees it
      if (session.gmSocketId && io.sockets.sockets.get(session.gmSocketId)) {
        io.to(session.gmSocketId).emit("diceRolled", roll);
      } else {
        socket.emit("errorMessage", "Hidden roll: GM not currently connected.");
      }
    } else {
      io.to(sessionId).emit("diceRolled", roll);
    }
  });

  // Clear history – GM only
  socket.on("clearHistory", () => {
    const sessionId = socket.data.sessionId;
    const clientId = socket.data.clientId;

    if (!sessionId || !sessions.has(sessionId)) {
      socket.emit("errorMessage", "You must join a session first.");
      return;
    }

    const session = sessions.get(sessionId);
    if (!clientId || clientId !== session.gmClientId) {
      socket.emit("errorMessage", "Only the GM can clear history.");
      return;
    }

    session.history = [];
    io.to(sessionId).emit("historyCleared");
  });

  // Leave session explicitly
  socket.on("leaveSession", () => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) {
      socket.data.sessionId = null;
      return;
    }

    const session = sessions.get(sessionId);
    session.users.delete(socket.id);
    socket.leave(sessionId);
    socket.data.sessionId = null;

    const publicUsersPayload = buildUsersPayload(session, false);
    const gmSocketId = session.gmSocketId;
    const gmConnected = gmSocketId && session.users.has(gmSocketId);

    let broadcast = socket.to(sessionId);
    if (gmConnected) {
      broadcast = broadcast.except(gmSocketId);
    }
    broadcast.emit("userLeft", { users: publicUsersPayload });

    if (gmConnected && gmSocketId !== socket.id) {
      io.to(gmSocketId).emit("userLeft", {
        users: buildUsersPayload(session, true),
      });
    }

    cleanupSessionIfEmpty(sessionId);
  });

  // Disconnect
  socket.on("disconnect", () => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;

    const session = sessions.get(sessionId);
    session.users.delete(socket.id);

    if (session.gmSocketId === socket.id) {
      session.gmSocketId = null; // keep gmClientId for reconnect
    }

    const publicUsersPayload = buildUsersPayload(session, false);
    const gmSocketId = session.gmSocketId;
    const gmConnected = gmSocketId && session.users.has(gmSocketId);

    let broadcast = socket.to(sessionId);
    if (gmConnected) {
      broadcast = broadcast.except(gmSocketId);
    }
    broadcast.emit("userLeft", { users: publicUsersPayload });

    if (gmConnected) {
      io.to(gmSocketId).emit("userLeft", {
        users: buildUsersPayload(session, true),
      });
    }

    cleanupSessionIfEmpty(sessionId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Candela Dice server running at http://localhost:${PORT}`);
});
