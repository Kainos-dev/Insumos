'use strict';

const { get, all, run, transaction, getDb } = require('../db/database');
const { AppError } = require('../utils/errores');

// ------------------------------------------------------------------
// STOCK SIN TALLE (cierres, hebillas)
//
// SQLite trata cada NULL como distinto dentro de UNIQUE(insumo_id, talle),
// por lo que el antiguo "INSERT ... ON CONFLICT" nunca detectaba la fila
// existente con talle NULL e insertaba una nueva en cada movimiento.
//
// Ahora toda lectura y escritura usa UNA fila determinista: la de menor id
// (la misma que el sistema ya leía). Las filas duplicadas históricas no se
// modifican ni se borran: quedan para conciliación manual
// (ver scripts/conciliacion-stock.js).
// ------------------------------------------------------------------

/** '' / undefined → null; números → texto ('38'). */
function normalizarTalle(talle) {
  if (talle === undefined || talle === null) return null;
  const t = String(talle).trim();
  return t === '' ? null : t;
}

/** Fila de stock vigente para insumo+talle (o undefined si no existe). */
function getStockRow(insumo_id, talle = null) {
  const t = normalizarTalle(talle);
  return t === null
    ? get('SELECT * FROM insumo_stock WHERE insumo_id = ? AND talle IS NULL ORDER BY id LIMIT 1', [insumo_id])
    : get('SELECT * FROM insumo_stock WHERE insumo_id = ? AND talle = ? ORDER BY id LIMIT 1', [insumo_id, t]);
}

/**
 * Stock de un insumo+talle. talle = null para cierres/hebillas.
 */
function getStock(insumo_id, talle = null) {
  const row = getStockRow(insumo_id, talle);
  return row ? row.stock : 0;
}

/**
 * Filas de stock vigentes de un insumo (sin las duplicadas históricas).
 */
function getStockRows(insumo_id) {
  return all(`
    SELECT * FROM insumo_stock s
    WHERE s.insumo_id = ?
      AND (s.talle IS NOT NULL
           OR s.id = (SELECT MIN(x.id) FROM insumo_stock x WHERE x.insumo_id = s.insumo_id AND x.talle IS NULL))
    ORDER BY s.talle`, [insumo_id]);
}

/** Cantidad de filas duplicadas históricas (talle NULL) pendientes de conciliar. */
function contarFilasDuplicadas(insumo_id) {
  const r = get('SELECT COUNT(*) AS n FROM insumo_stock WHERE insumo_id = ? AND talle IS NULL', [insumo_id]);
  return Math.max(0, (r ? r.n : 0) - 1);
}

/** Insumos con filas de stock general duplicadas. */
function insumosConDuplicados() {
  return all(`
    SELECT s.insumo_id, i.nombre, COUNT(*) - 1 AS filas_duplicadas
    FROM insumo_stock s JOIN insumos i ON i.id = s.insumo_id
    WHERE s.talle IS NULL
    GROUP BY s.insumo_id HAVING COUNT(*) > 1
    ORDER BY i.nombre`);
}

/**
 * Fija el stock de insumo+talle actualizando la fila vigente (o creándola si
 * no existe). Nunca crea una segunda fila. No registra movimiento: usar
 * adjustStock para cambios de inventario.
 */
function setStock(insumo_id, talle, stock) {
  if (!Number.isInteger(stock)) throw new AppError('El stock debe ser un número entero');
  const t = normalizarTalle(talle);
  const row = getStockRow(insumo_id, t);
  if (row) {
    run('UPDATE insumo_stock SET stock = ? WHERE id = ?', [stock, row.id]);
  } else {
    run('INSERT INTO insumo_stock (insumo_id, talle, stock) VALUES (?, ?, ?)', [insumo_id, t, stock]);
  }
}

/**
 * Ajusta el stock y registra el movimiento. Permite stock negativo.
 * tipo 'ajuste': delta es el valor final; el movimiento guarda la diferencia.
 */
function adjustStock(insumo_id, talle, delta, tipo, referencia_tipo = null, referencia_id = null) {
  if (!Number.isInteger(delta)) throw new AppError('La cantidad debe ser un número entero');
  talle = normalizarTalle(talle);
  transaction(() => {
    const current = getStock(insumo_id, talle);

    let newStock;
    let movimientoCantidad;

    if (tipo === 'ajuste') {
      // ajuste = fijar stock exacto
      newStock = delta;

      // guardamos cuánto cambió realmente para historial
      movimientoCantidad = delta - current;
    } else {
      // ingreso / egreso / consumo_orden
      newStock = current + delta;
      movimientoCantidad = delta;
    }

    setStock(insumo_id, talle, newStock);

    run(
      `INSERT INTO movimientos_stock (insumo_id, talle, tipo, cantidad, referencia_tipo, referencia_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [insumo_id, talle, tipo, movimientoCantidad, referencia_tipo, referencia_id]
    );
  });
}

/**
 * Verificar stock para una orden — agrupado por PRODUCTO con consumo acumulado.
 *
 * LÓGICA CORRECTA:
 * - Se procesan los detalles en orden.
 * - Cada consumo descuenta del stock virtual (no del real).
 * - Si dos productos (o dos bloques del mismo) usan el mismo insumo,
 *   el segundo compara contra el stock RESTANTE después del primero.
 *
 * Retorna: [ { producto_id, producto_nombre, insumos: [...] } ]
 * donde cada insumo tiene: { insumo_id, nombre, tipo, talle, stock_actual, necesario, faltante }
 */
function verificarStockOrden(detalles) {
  const db = getDb();

  // Stock virtual: copia mutable del stock real, se va decrementando
  // key: `${insumo_id}|${talle ?? 'null'}`
  const stockVirtual = {};

  function getVirtual(insumo_id, talle) {
    const key = `${insumo_id}|${talle ?? 'null'}`;
    if (!(key in stockVirtual)) {
      stockVirtual[key] = getStock(insumo_id, talle);
    }
    return stockVirtual[key];
  }

  function consumirVirtual(insumo_id, talle, cantidad) {
    const key = `${insumo_id}|${talle ?? 'null'}`;
    if (!(key in stockVirtual)) {
      stockVirtual[key] = getStock(insumo_id, talle);
    }
    stockVirtual[key] -= cantidad;
  }

  const resultadoPorProducto = [];

  for (const det of detalles) {
    const producto = db.prepare(`
      SELECT p.id, p.nombre AS producto_nombre,
             p.plantilla_id, p.fondo_id,
             i1.nombre AS plantilla_nombre, i1.tipo AS plantilla_tipo,
             i2.nombre AS fondo_nombre,     i2.tipo AS fondo_tipo
      FROM productos p
      JOIN insumos i1 ON i1.id = p.plantilla_id
      JOIN insumos i2 ON i2.id = p.fondo_id
      WHERE p.id = ?
    `).get(det.producto_id);
    if (!producto) continue;

    const pares = det.cantidad;
    const bloque = {
      producto_id:     det.producto_id,
      producto_nombre: producto.producto_nombre,
      numero_pedido:   det.numero_pedido || 1,
      talle_orden:     det.talle,
      cantidad_pares:  pares,
      insumos: [],
    };

    // — Plantilla —
    const stockAntesPlantilla = getVirtual(producto.plantilla_id, det.talle);
    const faltantePlantilla   = Math.max(0, pares - stockAntesPlantilla);
    bloque.insumos.push({
      insumo_id:    producto.plantilla_id,
      nombre:       producto.plantilla_nombre,
      tipo:         'plantilla',
      talle:        det.talle,
      stock_actual: getStock(producto.plantilla_id, det.talle),  // stock real para mostrar
      stock_virtual: stockAntesPlantilla,                        // stock disponible en este momento
      necesario:    pares,
      faltante:     faltantePlantilla,
    });
    consumirVirtual(producto.plantilla_id, det.talle, pares);

    // — Fondo —
    const stockAntesFondo = getVirtual(producto.fondo_id, det.talle);
    const faltanteFondo   = Math.max(0, pares - stockAntesFondo);
    bloque.insumos.push({
      insumo_id:    producto.fondo_id,
      nombre:       producto.fondo_nombre,
      tipo:         'fondo',
      talle:        det.talle,
      stock_actual: getStock(producto.fondo_id, det.talle),
      stock_virtual: stockAntesFondo,
      necesario:    pares,
      faltante:     faltanteFondo,
    });
    consumirVirtual(producto.fondo_id, det.talle, pares);

    // — Accesorios —
    const accs = db.prepare('SELECT * FROM producto_accesorios WHERE producto_id=?').all(det.producto_id);
    for (const acc of accs) {
      const insumo      = db.prepare('SELECT * FROM insumos WHERE id=?').get(acc.insumo_id);
      const necesario   = pares * acc.cantidad_por_par;
      const stockAntes  = getVirtual(acc.insumo_id, null);
      const faltante    = Math.max(0, necesario - stockAntes);
      bloque.insumos.push({
        insumo_id:    acc.insumo_id,
        nombre:       insumo ? insumo.nombre : '?',
        tipo:         insumo ? insumo.tipo : '?',
        talle:        null,
        stock_actual: getStock(acc.insumo_id, null),
        stock_virtual: stockAntes,
        necesario,
        faltante,
      });
      consumirVirtual(acc.insumo_id, null, necesario);
    }

    resultadoPorProducto.push(bloque);
  }

  return resultadoPorProducto;
}

/**
 * Deduct stock for confirmed order. Allows negatives.
 */
function consumirStockOrden(orden_id, detalles) {
  const db = getDb();
  transaction(() => {
    for (const det of detalles) {
      const producto = db.prepare('SELECT * FROM productos WHERE id=?').get(det.producto_id);
      if (!producto) continue;

      const pares = det.cantidad;

      adjustStock(producto.plantilla_id, det.talle, -pares, 'consumo_orden', 'orden', orden_id);
      adjustStock(producto.fondo_id, det.talle, -pares, 'consumo_orden', 'orden', orden_id);

      const accs = db.prepare('SELECT * FROM producto_accesorios WHERE producto_id=?').all(det.producto_id);
      for (const acc of accs) {
        adjustStock(acc.insumo_id, null, -(pares * acc.cantidad_por_par), 'consumo_orden', 'orden', orden_id);
      }
    }
  });
}

/**
 * Insumos con stock bajo (stock <= stock_minimo) o faltantes (stock < 0).
 */
function getAlertasStock() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      i.id,
      i.nombre,
      i.tipo,
      i.stock_minimo,
      i.proveedor_id,
      s.talle,
      COALESCE(s.stock,0) AS stock,
      p.nombre AS proveedor_nombre
    FROM insumos i
    LEFT JOIN insumo_stock s
      ON s.insumo_id = i.id
    LEFT JOIN insumo_talles it
      ON it.insumo_id = i.id
      AND it.talle = s.talle
    LEFT JOIN proveedores p
      ON p.id = i.proveedor_id
    WHERE
      (
        i.tipo IN ('plantilla','fondo')
        AND it.talle IS NOT NULL
        AND COALESCE(s.stock,0) <= i.stock_minimo
      )
      OR
      (
        i.tipo IN ('cierre','hebilla')
        AND COALESCE(s.stock,0) <= i.stock_minimo
      )
    ORDER BY stock ASC
  `).all();
  return rows;
}

module.exports = {
  normalizarTalle,
  getStockRow,
  getStock,
  getStockRows,
  contarFilasDuplicadas,
  insumosConDuplicados,
  setStock,
  adjustStock,
  verificarStockOrden,
  consumirStockOrden,
  getAlertasStock,
};
