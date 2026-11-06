'use strict';

const { crearRouter, idDe } = require('../utils/router');
const router = crearRouter();
const { all, get, run, insert, transaction } = require('../db/database');
const { AppError } = require('../utils/errores');
const {
  ajustarVarios, usaTalle, registrarMovimientoManual, normalizarTalle, detallesInsumos,
} = require('../services/stockService');
const responsables = require('../services/responsablesService');

const TIPOS = ['plantilla', 'fondo', 'cierre', 'hebilla'];

/**
 * Detalle de los insumos + responsable asignado (null si no tiene o si la base
 * todavía no tiene las tablas de responsables).
 */
async function completarInsumos(rows) {
  const [, asignaciones] = await Promise.all([detallesInsumos(rows), responsables.mapaAsignaciones()]);
  for (const row of rows) {
    const a = asignaciones.get(row.id);
    row.responsable = a ? { id: a.responsable_id, slug: a.slug, nombre: a.nombre, asignado_at: a.asignado_at } : null;
  }
  return rows;
}

/** Talles habilitados de un insumo, en una sola consulta. */
function insertarTalles(insumoId, talles) {
  if (!talles.length) return;
  return run('INSERT INTO insumo_talles (insumo_id, talle) SELECT ?::int, t FROM unnest(?::text[]) AS t', [insumoId, talles]);
}

/** Valida y normaliza los datos generales (no incluye existencias). */
async function datosGenerales(body) {
  const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
  if (!nombre) throw new AppError('El nombre es requerido');
  if (!TIPOS.includes(body.tipo)) throw new AppError('Tipo de insumo inválido');
  const stock_minimo = body.stock_minimo === undefined || body.stock_minimo === null || body.stock_minimo === ''
    ? 0 : Number(body.stock_minimo);
  if (!Number.isInteger(stock_minimo) || stock_minimo < 0) throw new AppError('El stock mínimo debe ser un entero mayor o igual a 0');
  const proveedor_id = body.proveedor_id ? Number(body.proveedor_id) : null;
  if (proveedor_id && (!Number.isInteger(proveedor_id) || !(await get('SELECT id FROM proveedores WHERE id=?', [proveedor_id])))) {
    throw new AppError('Proveedor inexistente');
  }
  const talles = usaTalle(body.tipo) && Array.isArray(body.talles)
    ? [...new Set(body.talles.map(normalizarTalle).filter(Boolean))]
    : [];
  const color = typeof body.color === 'string' && body.color.trim() ? body.color.trim() : null;
  return { nombre, tipo: body.tipo, color, stock_minimo, proveedor_id, talles };
}

router.get('/', async (req, res) => {
  const rows = await all(`
    SELECT i.*, p.nombre AS proveedor_nombre
    FROM insumos i
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    ORDER BY i.tipo, i.nombre
  `);
  res.json(await completarInsumos(rows));
});

router.get('/:id', async (req, res) => {
  const row = await get(`
    SELECT i.*, p.nombre AS proveedor_nombre
    FROM insumos i
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    WHERE i.id=?
  `, [idDe(req.params.id, 'Insumo no encontrado')]);
  if (!row) return res.status(404).json({ error: 'Insumo no encontrado' });
  res.json((await completarInsumos([row]))[0]);
});

/**
 * Alta de insumo. El stock inicial (opcional) se registra como movimiento
 * 'ajuste' con referencia 'alta_insumo', para que quede trazado.
 */
router.post('/', async (req, res) => {
  const d = await datosGenerales(req.body);
  const filasIniciales = Array.isArray(req.body.stock_rows) ? req.body.stock_rows : [];

  const newId = await transaction(async () => {
    const id = await insert(
      'INSERT INTO insumos (nombre, tipo, color, stock_minimo, proveedor_id) VALUES (?,?,?,?,?)',
      [d.nombre, d.tipo, d.color, d.stock_minimo, d.proveedor_id]
    );
    await insertarTalles(id, d.talles);

    const filas = usaTalle(d.tipo)
      ? filasIniciales.filter(f => normalizarTalle(f.talle) !== null)
      : [{ talle: null, stock: (filasIniciales.find(f => normalizarTalle(f.talle) === null) || {}).stock || 0 }];
    const iniciales = filas.map(f => ({ talle: normalizarTalle(f.talle), valor: Number(f.stock || 0) }));
    for (const f of iniciales) {
      if (!Number.isInteger(f.valor) || f.valor < 0) throw new AppError('El stock inicial debe ser un entero mayor o igual a 0');
    }
    // Todas las filas de stock en 0 (una por talle) y el stock inicial como ajuste trazable.
    if (iniciales.length) {
      await run(`INSERT INTO insumo_stock (insumo_id, talle, stock)
                 SELECT DISTINCT ?::int, t, 0 FROM unnest(?::text[]) AS t
                 ON CONFLICT (insumo_id, talle) DO NOTHING`, [id, iniciales.map(f => f.talle)]);
    }
    await ajustarVarios(iniciales.filter(f => f.valor !== 0).map(f => ({
      insumo_id: id, talle: f.talle, delta: f.valor, tipo: 'ajuste', referencia_tipo: 'alta_insumo', referencia_id: id,
    })));
    return id;
  });

  res.json({ id: newId });
});

/**
 * Edición de datos generales. NUNCA modifica existencias: si llegan
 * stock_rows se ignoran (las existencias se cambian con movimientos).
 */
router.put('/:id', async (req, res) => {
  const actual = await get('SELECT * FROM insumos WHERE id=?', [idDe(req.params.id, 'Insumo no encontrado')]);
  if (!actual) throw new AppError('Insumo no encontrado', 404);
  const d = await datosGenerales(req.body);

  if (usaTalle(actual.tipo) !== usaTalle(d.tipo)) {
    const { con_stock: conStock, con_movs: conMovs } = await get(`
      SELECT (SELECT COUNT(*) FROM insumo_stock WHERE insumo_id = ? AND stock <> 0) AS con_stock,
             (SELECT COUNT(*) FROM movimientos_stock WHERE insumo_id = ?) AS con_movs`, [actual.id, actual.id]);
    if (conStock || conMovs) {
      throw new AppError('No se puede cambiar entre un tipo con talles y uno sin talles porque el insumo ya tiene stock o movimientos', 409);
    }
  }

  await transaction(async () => {
    await run('UPDATE insumos SET nombre=?, tipo=?, color=?, stock_minimo=?, proveedor_id=? WHERE id=?',
      [d.nombre, d.tipo, d.color, d.stock_minimo, d.proveedor_id, actual.id]);
    await run('DELETE FROM insumo_talles WHERE insumo_id=?', [actual.id]);
    await insertarTalles(actual.id, d.talles);
  });

  res.json({ ok: true, stock_ignorado: Array.isArray(req.body.stock_rows) });
});

router.delete('/:id', async (req, res) => {
  const r = await run('DELETE FROM insumos WHERE id=?', [idDe(req.params.id, 'Insumo no encontrado')]);
  if (!r.changes) throw new AppError('Insumo no encontrado', 404);
  res.json({ ok: true });
});

// Asignar, cambiar o quitar (responsable_id: null) el responsable de reposición.
// No modifica stock, movimientos ni historiales.
router.put('/:id/responsable', async (req, res) => {
  res.json({ ok: true, ...(await responsables.asignar(Number(req.params.id), req.body.responsable_id)) });
});

// Movimiento manual de stock (ingreso / egreso / ajuste)
router.post('/:id/stock/ajuste', async (req, res) => {
  const { talle, cantidad, tipo } = req.body;
  res.json({ ok: true, ...(await registrarMovimientoManual({ insumo_id: Number(req.params.id), talle, cantidad, tipo })) });
});

// Fijar el stock de un talle: se registra como ajuste (queda en Movimientos)
router.put('/:id/stock', async (req, res) => {
  const { talle, stock } = req.body;
  res.json({ ok: true, ...(await registrarMovimientoManual({ insumo_id: Number(req.params.id), talle, cantidad: stock, tipo: 'ajuste' })) });
});

module.exports = router;
