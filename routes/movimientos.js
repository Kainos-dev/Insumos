'use strict';

const { crearRouter } = require('../utils/router');
const router = crearRouter();
const { all } = require('../db/database');
const { registrarMovimientoManual } = require('../services/stockService');

router.get('/', async (req, res) => {
  const insumo_id = req.query.insumo_id ? Number(req.query.insumo_id) : null;
  let limit = Number(req.query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 1000);

  // m.tipo es el tipo de MOVIMIENTO. El tipo del insumo se expone como
  // insumo_tipo (antes "i.tipo" pisaba a "m.tipo" en el resultado).
  let sql = `
    SELECT m.*, i.nombre AS insumo_nombre, i.tipo AS insumo_tipo
    FROM movimientos_stock m
    JOIN insumos i ON i.id=m.insumo_id
  `;
  const params = [];
  if (insumo_id !== null) {
    if (!Number.isInteger(insumo_id)) return res.json([]);
    sql += ' WHERE m.insumo_id=?';
    params.push(insumo_id);
  }
  sql += ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?';
  params.push(limit);
  res.json(await all(sql, params));
});

// Movimiento rápido de stock desde el dashboard
router.post('/rapido', async (req, res) => {
  const { insumo_id, talle, cantidad, tipo } = req.body;
  res.json({ ok: true, ...(await registrarMovimientoManual({ insumo_id: Number(insumo_id), talle, cantidad, tipo })) });
});

module.exports = router;
