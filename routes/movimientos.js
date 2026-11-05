'use strict';

const express = require('express');
const router = express.Router();
const { all } = require('../db/database');
const { registrarMovimientoManual } = require('../services/stockService');

router.get('/', (req, res) => {
  const { insumo_id, limit = 50 } = req.query;
  let sql = `
    SELECT m.*, i.nombre AS insumo_nombre, i.tipo
    FROM movimientos_stock m
    JOIN insumos i ON i.id=m.insumo_id
  `;
  const params = [];
  if (insumo_id) {
    sql += ' WHERE m.insumo_id=?';
    params.push(insumo_id);
  }
  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(Number(limit));
  res.json(all(sql, params));
});

// Quick stock movement from dashboard
router.post('/rapido', (req, res) => {
  const { insumo_id, talle, cantidad, tipo } = req.body;
  res.json({ ok: true, ...registrarMovimientoManual({ insumo_id: Number(insumo_id), talle, cantidad, tipo }) });
});

module.exports = router;
