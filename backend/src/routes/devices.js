const express = require("express");
const { getDb } = require("../db/database");
const { authMiddleware } = require("../auth/middleware");
const { clients } = require("../ws/wsHandler");

const router = express.Router();

// All device routes require auth
router.use(authMiddleware);

/**
 * GET /api/devices — list user's devices
 */
router.get("/", (req, res) => {
  const db = getDb();
  const devices = db.prepare(`
    SELECT id, name, type, platform, last_seen, is_online, created_at
    FROM devices WHERE user_id = ?
    ORDER BY last_seen DESC
  `).all(req.user.userId);

  const enriched = devices.map((d) => ({
    ...d,
    is_online: clients.has(d.id) ? true : false,
  }));

  res.json({ devices: enriched });
});

/**
 * DELETE /api/devices/:id — remove a device
 */
router.delete("/:id", (req, res) => {
  const db = getDb();
  const device = db.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  db.prepare("DELETE FROM devices WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM device_pairs WHERE device_a = ? OR device_b = ?").run(req.params.id, req.params.id);

  res.json({ message: "Device removed" });
});

/**
 * GET /api/devices/:id/pairs — list device pairs
 */
router.get("/:id/pairs", (req, res) => {
  const db = getDb();
  const device = db.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  const pairs = db.prepare(`
    SELECT dp.*, 
      CASE WHEN dp.device_a = ? THEN dp.device_b ELSE dp.device_a END as paired_device_id
    FROM device_pairs dp
    WHERE dp.device_a = ? OR dp.device_b = ?
  `).all(req.params.id, req.params.id, req.params.id);

  const enriched = pairs.map((p) => {
    const pairedDevice = db.prepare("SELECT id, name, type, platform FROM devices WHERE id = ?").get(p.paired_device_id);
    return {
      ...p,
      paired_device: pairedDevice,
      paired_online: clients.has(p.paired_device_id),
    };
  });

  res.json({ pairs: enriched });
});

/**
 * POST /api/devices/:id/unpair/:targetId — unpair two devices
 */
router.post("/:id/unpair/:targetId", (req, res) => {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM device_pairs 
    WHERE (device_a = ? AND device_b = ?) OR (device_a = ? AND device_b = ?)
  `).run(req.params.id, req.params.targetId, req.params.targetId, req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Pair not found" });
  }

  res.json({ message: "Devices unpaired" });
});

module.exports = router;
