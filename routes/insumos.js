'use strict';

const express = require('express');
const router = express.Router();
const { all, get, run, transaction } = require('../db/database');
const { getStockRows, setStock, adjustStock, contarFilasDuplicadas } = require('../services/stockService');

/** Agrega talles, filas de stock vigentes, total y duplicados pendientes. */
function completarInsumo(row) {
  row.talles = all('SELECT talle FROM insumo_talles WHERE insumo_id=? ORDER BY talle', [row.id]).map(t => t.talle);
  row.stock_rows = getStockRows(row.id);
  row.stock_total = row.stock_rows.reduce((s, r) => s + r.stock, 0);
  row.stock_duplicados = contarFilasDuplicadas(row.id);
  return row;
}

router.get('/', (req, res) => {
  const rows = all(`
    SELECT i.*, p.nombre AS proveedor_nombre
    FROM insumos i
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    ORDER BY i.tipo, i.nombre
  `);
  res.json(rows.map(completarInsumo));
});

router.get('/:id', (req, res) => {
  const row = get(`
    SELECT i.*, p.nombre AS proveedor_nombre
    FROM insumos i
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    WHERE i.id=?
  `, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Insumo no encontrado' });
  res.json(completarInsumo(row));
});

router.post('/', (req, res) => {
  const { nombre, tipo, color, stock_minimo, proveedor_id, talles, stock_rows } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'nombre y tipo son requeridos' });

  let newId;
  transaction(() => {
    const r = run(
      'INSERT INTO insumos (nombre, tipo, color, stock_minimo, proveedor_id) VALUES (?,?,?,?,?)',
      [nombre, tipo, color || null, stock_minimo || 0, proveedor_id || null]
    );
    newId = r.lastInsertRowid;

    if (talles && Array.isArray(talles)) {
      for (const talle of talles) {
        run(
          'INSERT INTO insumo_talles (insumo_id, talle) VALUES (?, ?)',
          [newId, talle]
        );
      }
    }

    if (stock_rows && Array.isArray(stock_rows)) {
      for (const sr of stock_rows) {
        setStock(newId, sr.talle || null, sr.stock || 0);
      }
    } else {
      // Default: single general stock row for cierres/hebillas
      if (tipo === 'cierre' || tipo === 'hebilla') {
        setStock(newId, null, 0);
      }
    }
  });

  res.json({ id: newId });
});

router.put('/:id', (req, res) => {
  const { nombre, tipo, color, stock_minimo, proveedor_id, talles, stock_rows } = req.body;

  transaction(() => {
    // actualiza datos del insumo
    run(
      'UPDATE insumos SET nombre=?, tipo=?, color=?, stock_minimo=?, proveedor_id=? WHERE id=?',
      [nombre, tipo, color || null, stock_minimo || 0, proveedor_id || null, req.params.id]
    );

    // borrar talles anteriores
    run(
      'DELETE FROM insumo_talles WHERE insumo_id=?',
      [req.params.id]
    );

    // guardar talles nuevos
    if (talles && Array.isArray(talles)) {
      for (const talle of talles) {
        run(
          'INSERT INTO insumo_talles (insumo_id, talle) VALUES (?, ?)',
          [req.params.id, talle]
        );
      }
    }

    // actualizar stock
    if (stock_rows && Array.isArray(stock_rows)) {
      for (const sr of stock_rows) {
        setStock(Number(req.params.id), sr.talle || null, sr.stock || 0);
      }
    }
  });

  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  run('DELETE FROM insumos WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// Adjust stock manually (ingreso / egreso)
router.post('/:id/stock/ajuste', (req, res) => {
  const { talle, cantidad, tipo } = req.body;
  // tipo: 'ingreso' | 'egreso' | 'ajuste'
  if (!cantidad || !tipo) return res.status(400).json({ error: 'cantidad y tipo son requeridos' });
  const delta = tipo === 'egreso' ? -Math.abs(cantidad) : Math.abs(cantidad);
  adjustStock(Number(req.params.id), talle || null, delta, tipo);
  res.json({ ok: true });
});

// Set absolute stock for a talle
router.put('/:id/stock', (req, res) => {
  const { talle, stock } = req.body;
  setStock(Number(req.params.id), talle || null, stock);
  res.json({ ok: true });
});

module.exports = router;
