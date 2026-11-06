'use strict';

const { get, all, run, transaction, getDb } = require('../db/database');
const { verificarStockOrden, consumirStockOrden, adjustStock } = require('./stockService');
const { AppError } = require('../utils/errores');

// ——— Validaciones comunes ———

function getOrdenOrFail(orden_id) {
  const orden = get('SELECT * FROM ordenes_produccion WHERE id=?', [orden_id]);
  if (!orden) throw new AppError('Planilla no encontrada', 404);
  return orden;
}

/** Solo las planillas en borrador admiten cambios en sus líneas. */
function assertBorrador(orden) {
  if (orden.estado !== 'borrador') {
    throw new AppError(`La planilla #${orden.id} está ${orden.estado}: sus líneas no se pueden modificar`, 409);
  }
}

function validarCantidad(cantidad) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('La cantidad debe ser un entero mayor que cero');
  return n;
}

function validarProductoTalle(producto_id, talle) {
  if (!get('SELECT id FROM productos WHERE id=?', [producto_id])) throw new AppError('Producto inexistente');
  const t = String(talle ?? '').trim();
  if (!get('SELECT 1 FROM producto_talles WHERE producto_id=? AND talle=?', [producto_id, t])) {
    throw new AppError(`El producto no tiene habilitado el talle ${t || '(vacío)'}`);
  }
  return t;
}

function crearOrden(descripcion) {
  const r = run('INSERT INTO ordenes_produccion (descripcion) VALUES (?)', [descripcion || null]);
  return r.lastInsertRowid;
}

/**
 * Calcula el próximo numero_pedido dentro de la orden.
 * Es incremental por orden, independiente de producto/talle.
 * Cada llamada a agregarDetalle o agregarDetallesBulk consume uno o más números.
 */
function proximoNumeroPedido(orden_id) {
  const row = get(
    'SELECT COALESCE(MAX(numero_pedido), 0) AS max_np FROM detalle_orden WHERE orden_id = ?',
    [orden_id]
  );
  return (row ? row.max_np : 0) + 1;
}

/**
 * Agrega UNA línea individual.
 * Genera siempre una fila nueva — NUNCA fusiona con líneas existentes,
 * aunque el producto_id y el talle sean iguales.
 */
function agregarDetalle(orden_id, producto_id, talle, cantidad) {
  transaction(() => {
    assertBorrador(getOrdenOrFail(orden_id));
    const t = validarProductoTalle(producto_id, talle);
    const c = validarCantidad(cantidad);
    const np = proximoNumeroPedido(orden_id);
    run(
      'INSERT INTO detalle_orden (orden_id, producto_id, talle, cantidad, numero_pedido) VALUES (?,?,?,?,?)',
      [orden_id, producto_id, t, c, np]
    );
  });
}

/**
 * Agrega múltiples talles de un producto en una transacción.
 * lineas = [{talle, cantidad}] — solo los que tienen cantidad > 0.
 *
 * Todos los talles de una misma llamada comparten el mismo numero_pedido
 * (un "bloque" p.N). NO consolida ni fusiona: si llamás dos veces con el
 * mismo producto+talle, obtenés filas independientes en bloques distintos.
 */
function agregarDetallesBulk(orden_id, producto_id, lineas, numero_pedido = null) {
  const db = getDb();

  db.transaction(() => {
    assertBorrador(getOrdenOrFail(orden_id));
    for (const l of lineas) {
      l.talle = validarProductoTalle(producto_id, l.talle);
      l.cantidad = validarCantidad(l.cantidad);
    }
    if (numero_pedido !== null && numero_pedido !== undefined) {
      numero_pedido = Number(numero_pedido);
      if (!Number.isInteger(numero_pedido) || numero_pedido <= 0) {
        throw new AppError('El número de pedido debe ser un entero mayor que cero');
      }
    }
    if (numero_pedido) {
      const existe = get(
        'SELECT id FROM detalle_orden WHERE orden_id = ? AND numero_pedido = ? LIMIT 1',
        [orden_id, numero_pedido]
      );

      if (existe) {
        throw new AppError('Ese número de pedido ya existe en esta planilla', 409);
      }
    }
    const np = numero_pedido || proximoNumeroPedido(orden_id);

    for (const l of lineas) {
      db.prepare(
        'INSERT INTO detalle_orden (orden_id, producto_id, talle, cantidad, numero_pedido) VALUES (?,?,?,?,?)'
      ).run(orden_id, producto_id, l.talle, Number(l.cantidad), np);
    }
  })();
}

/**
 * Lee los detalles de la orden ordenados por numero_pedido.
 * Incluye numero_pedido en cada fila para uso en frontend y PDF.
 * ORDER BY numero_pedido garantiza procesamiento secuencial correcto
 * en la verificación de stock acumulado.
 */
function getDetalles(orden_id) {
  return all(`
    SELECT d.id, d.orden_id, d.producto_id, d.talle, d.cantidad, d.numero_pedido,
           p.nombre AS producto_nombre, p.plantilla_id, p.fondo_id,
           i1.nombre AS plantilla_nombre, i1.color AS plantilla_color,
           i2.nombre AS fondo_nombre,     i2.color AS fondo_color
    FROM detalle_orden d
    JOIN productos p  ON p.id  = d.producto_id
    JOIN insumos i1   ON i1.id = p.plantilla_id
    JOIN insumos i2   ON i2.id = p.fondo_id
    WHERE d.orden_id = ?
    ORDER BY d.numero_pedido ASC
  `, [orden_id]);
}

function getOrden(id) {
  const orden = get('SELECT * FROM ordenes_produccion WHERE id=?', [id]);
  if (!orden) return null;
  orden.detalles = getDetalles(id);
  return orden;
}

function listarOrdenes() {
  return all(`
    SELECT o.*,
           COUNT(d.id)    AS lineas,
           SUM(d.cantidad) AS total_pares
    FROM ordenes_produccion o
    LEFT JOIN detalle_orden d ON d.orden_id = o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `);
}

/**
 * Verificación: pasa los detalles ya ordenados por numero_pedido al service
 * de stock para que el descuento virtual sea secuencial línea a línea.
 */
function verificar(orden_id) {
  const detalles = getDetalles(orden_id);
  // detalles ya vienen ORDER BY numero_pedido ASC — el stockService los
  // procesa en ese orden, descontando virtualmente de manera acumulada.
  return verificarStockOrden(detalles);
}

/**
 * Confirma una planilla y descuenta el stock UNA sola vez.
 * El stock puede quedar negativo: la falta de existencias nunca bloquea.
 */
function confirmarOrden(orden_id) {
  transaction(() => {
    const orden = getOrdenOrFail(orden_id);
    if (orden.estado !== 'borrador') throw new AppError('Solo se pueden confirmar planillas en borrador', 409);
    const detalles = getDetalles(orden_id);
    if (!detalles.length) throw new AppError('La planilla no tiene líneas para confirmar');

    // Cambio de estado condicional: una segunda confirmación no afecta filas.
    const r = run(
      `UPDATE ordenes_produccion SET estado='confirmada', confirmed_at=datetime('now','localtime')
       WHERE id=? AND estado='borrador'`,
      [orden_id]
    );
    if (r.changes !== 1) throw new AppError('La planilla cambió de estado mientras se procesaba', 409);

    // Defensa adicional: una planilla solo puede generar consumos una vez.
    const previos = get(`SELECT COUNT(*) AS n FROM movimientos_stock
                         WHERE referencia_tipo='orden' AND referencia_id=? AND tipo='consumo_orden'`, [orden_id]).n;
    if (previos) throw new AppError('Esta planilla ya registró consumos de stock', 409);

    consumirStockOrden(orden_id, detalles);
  });
}

/**
 * Cancela una planilla.
 * - Borrador: solo cambia el estado.
 * - Confirmada: devuelve al stock exactamente lo consumido según los
 *   movimientos registrados (no recalcula con la receta actual). Cada
 *   devolución queda como movimiento 'ingreso' con referencia
 *   'anulacion_orden' y el número de planilla.
 */
function cancelarOrden(orden_id) {
  let resumen;
  transaction(() => {
    const orden = getOrdenOrFail(orden_id);
    if (orden.estado === 'cancelada') throw new AppError('La planilla ya está cancelada', 409);

    const r = run(`UPDATE ordenes_produccion SET estado='cancelada' WHERE id=? AND estado=?`, [orden_id, orden.estado]);
    if (r.changes !== 1) throw new AppError('La planilla cambió de estado mientras se procesaba', 409);

    if (orden.estado !== 'confirmada') {
      resumen = { revertido: false, movimientos: 0 };
      return;
    }

    const yaRevertida = get(`SELECT COUNT(*) AS n FROM movimientos_stock
                             WHERE referencia_tipo='anulacion_orden' AND referencia_id=?`, [orden_id]).n;
    if (yaRevertida) throw new AppError('Esta planilla ya tiene una devolución de stock registrada', 409);

    const consumos = all(`
      SELECT insumo_id, talle, SUM(cantidad) AS total
      FROM movimientos_stock
      WHERE referencia_tipo='orden' AND referencia_id=? AND tipo='consumo_orden'
      GROUP BY insumo_id, talle`, [orden_id]);

    let n = 0;
    for (const c of consumos) {
      if (c.total === 0) continue;
      adjustStock(c.insumo_id, c.talle, -c.total, 'ingreso', 'anulacion_orden', orden_id);
      n++;
    }
    resumen = { revertido: true, movimientos: n };
  });
  return resumen;
}

function getDetalleConOrden(detalle_id) {
  const det = get('SELECT * FROM detalle_orden WHERE id=?', [detalle_id]);
  if (!det) throw new AppError('Línea no encontrada', 404);
  assertBorrador(getOrdenOrFail(det.orden_id));
  return det;
}

function eliminarDetalle(detalle_id) {
  transaction(() => {
    getDetalleConOrden(detalle_id);
    run('DELETE FROM detalle_orden WHERE id=?', [detalle_id]);
  });
}

function actualizarDetalle(detalle_id, cantidad) {
  transaction(() => {
    getDetalleConOrden(detalle_id);
    run('UPDATE detalle_orden SET cantidad=? WHERE id=?', [validarCantidad(cantidad), detalle_id]);
  });
}

module.exports = {
  crearOrden,
  agregarDetalle,
  agregarDetallesBulk,
  getOrden,
  getDetalles,
  listarOrdenes,
  verificar,
  confirmarOrden,
  cancelarOrden,
  eliminarDetalle,
  actualizarDetalle,
};
