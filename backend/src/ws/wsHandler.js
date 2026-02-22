const { v4: uuidv4 } = require("uuid");
const { verifyToken } = require("../auth/middleware");
const { getDb } = require("../db/database");

/**
 * Connected clients map: deviceId -> { ws, userId, deviceId, deviceName }
 */
const clients = new Map();

/**
 * Remote control command types that can be sent between paired devices.
 */
const COMMANDS = {
  // Mouse
  MOUSE_MOVE: "mouse_move",         // { dx, dy }
  MOUSE_CLICK: "mouse_click",       // { button: 'left'|'right'|'middle' }
  MOUSE_SCROLL: "mouse_scroll",     // { dx, dy }
  MOUSE_DOWN: "mouse_down",         // { button }
  MOUSE_UP: "mouse_up",             // { button }

  // Keyboard
  KEY_PRESS: "key_press",           // { key, modifiers[] }
  KEY_DOWN: "key_down",             // { key }
  KEY_UP: "key_up",                 // { key }
  KEY_TYPE: "key_type",             // { text }

  // Clipboard
  CLIPBOARD_SYNC: "clipboard_sync", // { content }
  CLIPBOARD_GET: "clipboard_get",   // {}

  // File transfer
  FILE_OFFER: "file_offer",         // { fileName, fileSize, fileId }
  FILE_ACCEPT: "file_accept",       // { fileId }
  FILE_REJECT: "file_reject",       // { fileId }
  FILE_CHUNK: "file_chunk",         // { fileId, data (base64), offset, total }
  FILE_COMPLETE: "file_complete",   // { fileId }

  // Notifications
  NOTIFICATION: "notification",     // { title, body, app }
  NOTIFICATION_DISMISS: "notification_dismiss", // { id }

  // System
  RING: "ring",                     // ring the device
  PING: "ping",                     // keepalive
  PONG: "pong",                     // keepalive response

  // Device info
  DEVICE_INFO: "device_info",       // { name, type, platform, battery }
  BATTERY_UPDATE: "battery_update", // { level, charging }

  // Media control
  MEDIA_PLAY: "media_play",
  MEDIA_PAUSE: "media_pause",
  MEDIA_NEXT: "media_next",
  MEDIA_PREV: "media_prev",
  MEDIA_VOLUME: "media_volume",     // { level }
};

/**
 * Send JSON message to a WebSocket client.
 */
function send(ws, type, payload = {}) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...payload, ts: Date.now() }));
  }
}

/**
 * Send error message.
 */
function sendError(ws, message) {
  send(ws, "error", { message });
}

/**
 * Authenticate the WebSocket connection.
 * First message must be: { type: "auth", token, deviceId, deviceName, deviceType, platform }
 */
function handleAuth(ws, data) {
  try {
    const decoded = verifyToken(data.token);
    const db = getDb();

    const deviceId = data.deviceId || uuidv4();
    const deviceName = data.deviceName || "Unknown Device";
    const deviceType = data.deviceType || "unknown";
    const platform = data.platform || "unknown";

    // Upsert device
    db.prepare(`
      INSERT INTO devices (id, user_id, name, type, platform, last_seen, is_online)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        platform = excluded.platform,
        last_seen = CURRENT_TIMESTAMP,
        is_online = 1
    `).run(deviceId, decoded.userId, deviceName, deviceType, platform);

    const clientInfo = {
      ws,
      userId: decoded.userId,
      deviceId,
      deviceName,
      deviceType,
      platform,
    };

    clients.set(deviceId, clientInfo);

    // Notify other devices of this user that a new device came online
    broadcastToUser(decoded.userId, "device_online", {
      deviceId,
      deviceName,
      deviceType,
      platform,
    }, deviceId);

    send(ws, "auth_success", {
      deviceId,
      userId: decoded.userId,
      username: decoded.username,
    });

    return clientInfo;
  } catch (err) {
    sendError(ws, "Authentication failed: " + err.message);
    ws.close(4001, "Auth failed");
    return null;
  }
}

/**
 * Broadcast a message to all online devices of a user (except excludeDeviceId).
 */
function broadcastToUser(userId, type, payload, excludeDeviceId) {
  for (const [id, client] of clients) {
    if (client.userId === userId && id !== excludeDeviceId) {
      send(client.ws, type, payload);
    }
  }
}

/**
 * Forward a remote control command to a target device.
 */
function handleCommand(clientInfo, data) {
  const { target, command, payload } = data;

  if (!target || !command) {
    return sendError(clientInfo.ws, "target and command are required");
  }

  const targetClient = clients.get(target);
  if (!targetClient) {
    return sendError(clientInfo.ws, "Target device is offline");
  }

  // Verify both devices belong to the same user
  if (targetClient.userId !== clientInfo.userId) {
    return sendError(clientInfo.ws, "Not authorized to control this device");
  }

  // Verify devices are paired
  const db = getDb();
  const pair = db.prepare(`
    SELECT * FROM device_pairs
    WHERE ((device_a = ? AND device_b = ?) OR (device_a = ? AND device_b = ?))
      AND status = 'accepted'
  `).get(clientInfo.deviceId, target, target, clientInfo.deviceId);

  if (!pair) {
    return sendError(clientInfo.ws, "Devices are not paired. Send a pair request first.");
  }

  // Forward the command
  send(targetClient.ws, "command", {
    from: clientInfo.deviceId,
    fromName: clientInfo.deviceName,
    command,
    payload: payload || {},
  });
}

/**
 * Handle pairing request.
 */
function handlePairRequest(clientInfo, data) {
  const { target } = data;
  const db = getDb();

  const targetClient = clients.get(target);
  if (!targetClient || targetClient.userId !== clientInfo.userId) {
    return sendError(clientInfo.ws, "Target device not found or not yours");
  }

  // Check if already paired
  const existing = db.prepare(`
    SELECT * FROM device_pairs
    WHERE (device_a = ? AND device_b = ?) OR (device_a = ? AND device_b = ?)
  `).get(clientInfo.deviceId, target, target, clientInfo.deviceId);

  if (existing && existing.status === "accepted") {
    return send(clientInfo.ws, "pair_already", { target });
  }

  if (existing) {
    db.prepare("UPDATE device_pairs SET status = 'pending' WHERE id = ?").run(existing.id);
  } else {
    db.prepare("INSERT INTO device_pairs (device_a, device_b, status) VALUES (?, ?, 'pending')").run(
      clientInfo.deviceId, target
    );
  }

  // Notify target device
  send(targetClient.ws, "pair_request", {
    from: clientInfo.deviceId,
    fromName: clientInfo.deviceName,
    fromType: clientInfo.deviceType,
  });

  send(clientInfo.ws, "pair_sent", { target });
}

/**
 * Handle pair response (accept/reject).
 */
function handlePairResponse(clientInfo, data) {
  const { from, accept } = data;
  const db = getDb();

  const pair = db.prepare(`
    SELECT * FROM device_pairs
    WHERE device_a = ? AND device_b = ? AND status = 'pending'
  `).get(from, clientInfo.deviceId);

  if (!pair) {
    return sendError(clientInfo.ws, "No pending pair request from this device");
  }

  const newStatus = accept ? "accepted" : "rejected";
  db.prepare("UPDATE device_pairs SET status = ? WHERE id = ?").run(newStatus, pair.id);

  const fromClient = clients.get(from);
  if (fromClient) {
    send(fromClient.ws, "pair_response", {
      from: clientInfo.deviceId,
      fromName: clientInfo.deviceName,
      accepted: accept,
    });
  }

  send(clientInfo.ws, "pair_updated", { device: from, status: newStatus });
}

/**
 * Handle device list request — return all user's devices and their online status.
 */
function handleDeviceList(clientInfo) {
  const db = getDb();
  const devices = db.prepare(`
    SELECT id, name, type, platform, last_seen, is_online, created_at
    FROM devices WHERE user_id = ?
  `).all(clientInfo.userId);

  // Update online status from live connections
  const enriched = devices.map((d) => ({
    ...d,
    is_online: clients.has(d.id) ? 1 : 0,
    is_self: d.id === clientInfo.deviceId,
  }));

  send(clientInfo.ws, "device_list", { devices: enriched });
}

/**
 * Handle disconnect — mark device offline and notify others.
 */
function handleDisconnect(clientInfo) {
  if (!clientInfo) return;

  const db = getDb();
  db.prepare("UPDATE devices SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(clientInfo.deviceId);
  clients.delete(clientInfo.deviceId);

  broadcastToUser(clientInfo.userId, "device_offline", {
    deviceId: clientInfo.deviceId,
    deviceName: clientInfo.deviceName,
  }, clientInfo.deviceId);
}

/**
 * Attach WebSocket handler to an HTTP server.
 */
function setupWebSocket(server) {
  const WebSocket = require("ws");
  const wss = new WebSocket.Server({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let clientInfo = null;
    let authTimeout = setTimeout(() => {
      if (!clientInfo) {
        sendError(ws, "Authentication timeout");
        ws.close(4000, "Auth timeout");
      }
    }, 10000);

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return sendError(ws, "Invalid JSON");
      }

      // First message must be auth
      if (!clientInfo) {
        if (data.type !== "auth") {
          return sendError(ws, "Must authenticate first");
        }
        clientInfo = handleAuth(ws, data);
        if (clientInfo) clearTimeout(authTimeout);
        return;
      }

      // Dispatch message
      switch (data.type) {
        case "command":
          handleCommand(clientInfo, data);
          break;
        case "pair_request":
          handlePairRequest(clientInfo, data);
          break;
        case "pair_response":
          handlePairResponse(clientInfo, data);
          break;
        case "device_list":
          handleDeviceList(clientInfo);
          break;
        case "ping":
          send(ws, "pong");
          break;
        case "device_info":
          broadcastToUser(clientInfo.userId, "device_info", {
            deviceId: clientInfo.deviceId,
            ...data.payload,
          }, clientInfo.deviceId);
          break;
        default:
          sendError(ws, `Unknown message type: ${data.type}`);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      handleDisconnect(clientInfo);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      handleDisconnect(clientInfo);
    });
  });

  // Heartbeat — ping all clients every 30s
  setInterval(() => {
    for (const [id, client] of clients) {
      if (client.ws.readyState === 1) {
        client.ws.ping();
      } else {
        handleDisconnect(client);
      }
    }
  }, 30000);

  console.log("WebSocket server ready on /ws");
  return wss;
}

module.exports = { setupWebSocket, clients, COMMANDS };
