'use strict';

const { get, all, run, transaction, getDb } = require('../db/database');
const { verificarStockOrden, consumirStockOrden } = require('./stockService');

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
  const np = proximoNumeroPedido(orden_id);
  run(
    'INSERT INTO detalle_orden (orden_id, producto_id, talle, cantidad, numero_pedido) VALUES (?,?,?,?,?)',
    [orden_id, producto_id, talle, cantidad, np]
  );
}

/**
 * Agrega múltiples talles de un producto en una transacción.
 * lineas = [{talle, cantidad}] — solo los que tienen cantidad > 0.
 *
 * Cada talle genera su propia fila con su propio numero_pedido incremental.
 * NO consolida ni fusiona: si llamás dos veces con el mismo producto+talle,
 * obtenés dos filas independientes.
 */
function agregarDetallesBulk(orden_id, producto_id, lineas, numero_pedido = null) {
  const db = getDb();

  db.transaction(() => {
    if (numero_pedido) {
      const existe = get(
        'SELECT id FROM detalle_orden WHERE orden_id = ? AND numero_pedido = ? LIMIT 1',
        [orden_id, numero_pedido]
      );

      if (existe) {
        throw new Error('Ese número de pedido ya existe en esta planilla');
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

function confirmarOrden(orden_id) {
  const orden = get('SELECT * FROM ordenes_produccion WHERE id=?', [orden_id]);
  if (!orden) throw new Error('Planilla no encontrada');
  if (orden.estado !== 'borrador') throw new Error('Solo se pueden confirmar planillas en borrador');

  const detalles = getDetalles(orden_id);
  transaction(() => {
    consumirStockOrden(orden_id, detalles);
    run(
      `UPDATE ordenes_produccion SET estado='confirmada', confirmed_at=datetime('now','localtime') WHERE id=?`,
      [orden_id]
    );
  });
}

function cancelarOrden(orden_id) {
  run(`UPDATE ordenes_produccion SET estado='cancelada' WHERE id=?`, [orden_id]);
}

function eliminarDetalle(detalle_id) {
  run('DELETE FROM detalle_orden WHERE id=?', [detalle_id]);
}

function actualizarDetalle(detalle_id, cantidad) {
  run('UPDATE detalle_orden SET cantidad=? WHERE id=?', [cantidad, detalle_id]);
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
