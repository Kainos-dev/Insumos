'use strict';

const express = require('express');
const router = express.Router();
const { all, get, run, transaction } = require('../db/database');
const { AppError } = require('../utils/errores');
const {
  getStockRows, setStock, adjustStock, contarFilasDuplicadas,
  usaTalle, registrarMovimientoManual, normalizarTalle, estadoStock,
} = require('../services/stockService');

const TIPOS = ['plantilla', 'fondo', 'cierre', 'hebilla'];

/** Agrega talles, filas de stock vigentes, total y duplicados pendientes. */
function completarInsumo(row) {
  row.talles = all('SELECT talle FROM insumo_talles WHERE insumo_id=? ORDER BY talle', [row.id]).map(t => t.talle);
  row.stock_rows = getStockRows(row.id);
  row.stock_total = row.stock_rows.reduce((s, r) => s + r.stock, 0);
  row.stock_duplicados = contarFilasDuplicadas(row.id);
  row.estado_stock = estadoStock(row, row.stock_rows, row.talles);   // 'faltante' | 'bajo' | 'ok'
  row.sin_talles_habilitados = usaTalle(row.tipo) && row.talles.length === 0;
  return row;
}

/** Valida y normaliza los datos generales (no incluye existencias). */
function datosGenerales(body) {
  const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
  if (!nombre) throw new AppError('El nombre es requerido');
  if (!TIPOS.includes(body.tipo)) throw new AppError('Tipo de insumo inválido');
  const stock_minimo = body.stock_minimo === undefined || body.stock_minimo === null || body.stock_minimo === ''
    ? 0 : Number(body.stock_minimo);
  if (!Number.isInteger(stock_minimo) || stock_minimo < 0) throw new AppError('El stock mínimo debe ser un entero mayor o igual a 0');
  const proveedor_id = body.proveedor_id ? Number(body.proveedor_id) : null;
  if (proveedor_id && !get('SELECT id FROM proveedores WHERE id=?', [proveedor_id])) throw new AppError('Proveedor inexistente');
  const talles = usaTalle(body.tipo) && Array.isArray(body.talles)
    ? [...new Set(body.talles.map(normalizarTalle).filter(Boolean))]
    : [];
  const color = typeof body.color === 'string' && body.color.trim() ? body.color.trim() : null;
  return { nombre, tipo: body.tipo, color, stock_minimo, proveedor_id, talles };
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

/**
 * Alta de insumo. El stock inicial (opcional) se registra como movimiento
 * 'ajuste' con referencia 'alta_insumo', para que quede trazado.
 */
router.post('/', (req, res) => {
  const d = datosGenerales(req.body);
  const filasIniciales = Array.isArray(req.body.stock_rows) ? req.body.stock_rows : [];

  let newId;
  transaction(() => {
    newId = Number(run(
      'INSERT INTO insumos (nombre, tipo, color, stock_minimo, proveedor_id) VALUES (?,?,?,?,?)',
      [d.nombre, d.tipo, d.color, d.stock_minimo, d.proveedor_id]
    ).lastInsertRowid);
    for (const t of d.talles) run('INSERT INTO insumo_talles (insumo_id, talle) VALUES (?, ?)', [newId, t]);

    const filas = usaTalle(d.tipo)
      ? filasIniciales.filter(f => normalizarTalle(f.talle) !== null)
      : [{ talle: null, stock: (filasIniciales.find(f => normalizarTalle(f.talle) === null) || {}).stock || 0 }];
    for (const f of filas) {
      const valor = Number(f.stock || 0);
      if (!Number.isInteger(valor) || valor < 0) throw new AppError('El stock inicial debe ser un entero mayor o igual a 0');
      setStock(newId, f.talle, 0);
      if (valor !== 0) adjustStock(newId, f.talle, valor, 'ajuste', 'alta_insumo', newId);
    }
  });

  res.json({ id: newId });
});

/**
 * Edición de datos generales. NUNCA modifica existencias: si llegan
 * stock_rows se ignoran (las existencias se cambian con movimientos).
 */
router.put('/:id', (req, res) => {
  const actual = get('SELECT * FROM insumos WHERE id=?', [req.params.id]);
  if (!actual) throw new AppError('Insumo no encontrado', 404);
  const d = datosGenerales(req.body);

  if (usaTalle(actual.tipo) !== usaTalle(d.tipo)) {
    const conStock = get('SELECT COUNT(*) AS n FROM insumo_stock WHERE insumo_id=? AND stock<>0', [actual.id]).n;
    const conMovs = get('SELECT COUNT(*) AS n FROM movimientos_stock WHERE insumo_id=?', [actual.id]).n;
    if (conStock || conMovs) {
      throw new AppError('No se puede cambiar entre un tipo con talles y uno sin talles porque el insumo ya tiene stock o movimientos', 409);
    }
  }

  transaction(() => {
    run('UPDATE insumos SET nombre=?, tipo=?, color=?, stock_minimo=?, proveedor_id=? WHERE id=?',
      [d.nombre, d.tipo, d.color, d.stock_minimo, d.proveedor_id, actual.id]);
    run('DELETE FROM insumo_talles WHERE insumo_id=?', [actual.id]);
    for (const t of d.talles) run('INSERT INTO insumo_talles (insumo_id, talle) VALUES (?, ?)', [actual.id, t]);
  });

  res.json({ ok: true, stock_ignorado: Array.isArray(req.body.stock_rows) });
});

router.delete('/:id', (req, res) => {
  const r = run('DELETE FROM insumos WHERE id=?', [req.params.id]);
  if (!r.changes) throw new AppError('Insumo no encontrado', 404);
  res.json({ ok: true });
});

// Movimiento manual de stock (ingreso / egreso / ajuste)
router.post('/:id/stock/ajuste', (req, res) => {
  const { talle, cantidad, tipo } = req.body;
  res.json({ ok: true, ...registrarMovimientoManual({ insumo_id: Number(req.params.id), talle, cantidad, tipo }) });
});

// Fijar el stock de un talle: se registra como ajuste (queda en Movimientos)
router.put('/:id/stock', (req, res) => {
  const { talle, stock } = req.body;
  res.json({ ok: true, ...registrarMovimientoManual({ insumo_id: Number(req.params.id), talle, cantidad: stock, tipo: 'ajuste' }) });
});

module.exports = router;
