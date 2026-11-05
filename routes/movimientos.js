'use strict';

const express = require('express');
const router = express.Router();
const { all } = require('../db/database');
const { registrarMovimientoManual } = require('../services/stockService');

router.get('/', (req, res) => {
  const { insumo_id } = req.query;
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
  if (insumo_id) {
    sql += ' WHERE m.insumo_id=?';
    params.push(insumo_id);
  }
  sql += ' ORDER BY m.created_at DESC, m.id DESC LIMIT ?';
  params.push(limit);
  res.json(all(sql, params));
});

// Quick stock movement from dashboard
router.post('/rapido', (req, res) => {
  const { insumo_id, talle, cantidad, tipo } = req.body;
  res.json({ ok: true, ...registrarMovimientoManual({ insumo_id: Number(insumo_id), talle, cantidad, tipo }) });
});

module.exports = router;
