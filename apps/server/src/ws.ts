import { WebSocketServer } from "ws";
import { verifyToken } from "./auth";
import { db } from "./store";

export type SocketClient = {
  userId: string;
  socket: import("ws").WebSocket;
};

const clients = new Map<string, SocketClient>();

const broadcastPresence = (userId: string, isOnline: boolean) => {
  const payload = JSON.stringify({
    type: "presence",
    payload: { userId, isOnline }
  });
  for (const client of clients.values()) {
    client.socket.send(payload);
  }
};

export const attachWebSocket = (server: import("http").Server) => {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    const userId = token ? verifyToken(token) : null;
    if (!userId) {
      socket.close();
      return;
    }

    clients.set(userId, { userId, socket });
    broadcastPresence(userId, true);

    socket.on("message", (raw) => {
      try {
        const { type, payload } = JSON.parse(raw.toString());
        if (type === "message.send") {
          const deliveredAt = clients.get(payload.to)
            ? new Date().toISOString()
            : undefined;
          const message = {
            ...payload,
            from: userId,
            deliveredAt
          };
          db.saveMessage(message);
          const target = clients.get(payload.to);
          if (target) {
            target.socket.send(
              JSON.stringify({ type: "message.receive", payload: message })
            );
          }
          if (deliveredAt) {
            const sender = clients.get(userId);
            if (sender) {
              sender.socket.send(
                JSON.stringify({
                  type: "message.delivered",
                  payload: { id: payload.id, deliveredAt }
                })
              );
            }
          }
        }

        if (
          type === "call.offer" ||
          type === "call.answer" ||
          type === "call.ice" ||
          type === "call.end"
        ) {
          const target = clients.get(payload.to);
          if (target) {
            target.socket.send(
              JSON.stringify({ type, payload: { ...payload, from: userId } })
            );
          }
        }

        if (type === "status.update") {
          const user = db.findUserById(userId);
          if (user) {
            user.status = payload.status;
            db.saveUser(user);
          }
        }
        if (type === "message.read") {
          const ids = payload.ids as string[];
          if (Array.isArray(ids) && ids.length > 0) {
            const readAt = new Date().toISOString();
            db.updateMessages(ids, { readAt, deliveredAt: readAt });
            const target = clients.get(payload.peerId);
            if (target) {
              target.socket.send(
                JSON.stringify({
                  type: "message.read",
                  payload: { ids, readAt }
                })
              );
            }
          }
        }
      } catch {
        // ignore malformed packets
      }
    });

    socket.on("close", () => {
      clients.delete(userId);
      broadcastPresence(userId, false);
    });
  });
};
