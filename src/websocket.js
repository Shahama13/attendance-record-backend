const { Server } = require("socket.io");
const { verifyToken } = require("./utils/jwt");

let io = null;

// Attaches Socket.IO to the existing HTTP server. Portal clients connect
// with their JWT in the handshake and are dropped into a room per campus
// (plus an "all" room for admin/HR) so events only reach relevant screens.
function initWebsocket(httpServer, corsOrigin) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = verifyToken(token);
      socket.user = { id: payload.sub, role: payload.role, campusId: payload.campusId };
      next();
    } catch {
      next(new Error("Unauthorized socket connection"));
    }
  });

  io.on("connection", (socket) => {
    if (["admin", "hr"].includes(socket.user.role)) {
      socket.join("all-campuses");
    } else if (socket.user.campusId) {
      socket.join(`campus:${socket.user.campusId}`);
    }
  });

  return io;
}

// Broadcast helpers used by controllers after a write succeeds.
function emitSheetSubmitted(sheet) {
  io?.to("all-campuses").to(`campus:${sheet.campus_id}`).emit("attendance:submitted", sheet);
}

function emitSheetVerified(sheet) {
  io?.to("all-campuses").to(`campus:${sheet.campus_id}`).emit("attendance:verified", sheet);
}

module.exports = { initWebsocket, emitSheetSubmitted, emitSheetVerified };
