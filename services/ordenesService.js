'use strict';

const { get, all, run, insert, transaction } = require('../db/database');
const { verificarStockOrden, consumirStockOrden, ajustarVarios } = require('./stockService');
const { AppError } = require('../utils/errores');

// ——— Validaciones comunes ———

async function getOrdenOrFail(orden_id) {
  const orden = Number.isInteger(orden_id) ? await get('SELECT * FROM ordenes_produccion WHERE id=?', [orden_id]) : null;
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

async function validarProductoTalle(producto_id, talle) {
  if (!Number.isInteger(producto_id) || !(await get('SELECT id FROM productos WHERE id=?', [producto_id]))) {
    throw new AppError('Producto inexistente');
  }
  const t = String(talle ?? '').trim();
  if (!(await get('SELECT 1 FROM producto_talles WHERE producto_id=? AND talle=?', [producto_id, t]))) {
    throw new AppError(`El producto no tiene habilitado el talle ${t || '(vacío)'}`);
  }
  return t;
}

function crearOrden(descripcion) {
  return insert('INSERT INTO ordenes_produccion (descripcion) VALUES (?)', [descripcion || null]);
}

/**
 * Calcula el próximo numero_pedido dentro de la orden.
 * Es incremental por orden, independiente de producto/talle.
 * Cada llamada a agregarDetalle o agregarDetallesBulk consume uno o más números.
 */
async function proximoNumeroPedido(orden_id) {
  const row = await get(
    'SELECT COALESCE(MAX(numero_pedido), 0) AS max_np FROM detalle_orden WHERE orden_id = ?',
    [orden_id]
  );
  return (row ? row.max_np : 0) + 1;
}

/**
 * Bloquea la planilla hasta el fin de la transacción: dos cambios simultáneos
 * sobre la misma planilla se aplican de a uno (numero_pedido consistente).
 */
async function getOrdenBloqueada(orden_id) {
  const orden = Number.isInteger(orden_id)
    ? await get('SELECT * FROM ordenes_produccion WHERE id=? FOR UPDATE', [orden_id]) : null;
  if (!orden) throw new AppError('Planilla no encontrada', 404);
  return orden;
}

/**
 * Agrega UNA línea individual.
 * Genera siempre una fila nueva — NUNCA fusiona con líneas existentes,
 * aunque el producto_id y el talle sean iguales.
 */
async function agregarDetalle(orden_id, producto_id, talle, cantidad) {
  await transaction(async () => {
    assertBorrador(await getOrdenBloqueada(orden_id));
    const t = await validarProductoTalle(producto_id, talle);
    const c = validarCantidad(cantidad);
    const np = await proximoNumeroPedido(orden_id);
    await run(
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
async function agregarDetallesBulk(orden_id, producto_id, lineas, numero_pedido = null) {
  await transaction(async () => {
    assertBorrador(await getOrdenBloqueada(orden_id));
    // Producto y talles habilitados en una sola consulta.
    const prod = Number.isInteger(producto_id) ? await get(`
      SELECT p.id, COALESCE(array_agg(pt.talle) FILTER (WHERE pt.talle IS NOT NULL), '{}') AS talles
      FROM productos p LEFT JOIN producto_talles pt ON pt.producto_id = p.id
      WHERE p.id = ? GROUP BY p.id`, [producto_id]) : null;
    if (!prod) throw new AppError('Producto inexistente');
    const habilitados = new Set(prod.talles);
    for (const l of lineas) {
      const t = String(l.talle ?? '').trim();
      if (!habilitados.has(t)) throw new AppError(`El producto no tiene habilitado el talle ${t || '(vacío)'}`);
      l.talle = t;
      l.cantidad = validarCantidad(l.cantidad);
    }
    if (numero_pedido !== null && numero_pedido !== undefined) {
      numero_pedido = Number(numero_pedido);
      if (!Number.isInteger(numero_pedido) || numero_pedido <= 0) {
        throw new AppError('El número de pedido debe ser un entero mayor que cero');
      }
    }
    if (numero_pedido) {
      const existe = await get(
        'SELECT id FROM detalle_orden WHERE orden_id = ? AND numero_pedido = ? LIMIT 1',
        [orden_id, numero_pedido]
      );
      if (existe) {
        throw new AppError('Ese número de pedido ya existe en esta planilla', 409);
      }
    }
    const np = numero_pedido || await proximoNumeroPedido(orden_id);

    await run(`
      INSERT INTO detalle_orden (orden_id, producto_id, talle, cantidad, numero_pedido)
      SELECT ?::int, ?::int, l.talle, l.cantidad, ?::int
      FROM unnest(?::text[], ?::int[]) WITH ORDINALITY AS l(talle, cantidad, n)
      ORDER BY l.n`,
    [orden_id, producto_id, np, lineas.map(l => l.talle), lineas.map(l => Number(l.cantidad))]);
  });
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
    ORDER BY d.numero_pedido ASC, d.id ASC
  `, [orden_id]);
}

async function getOrden(id) {
  if (!Number.isInteger(id)) return null;
  const orden = await get('SELECT * FROM ordenes_produccion WHERE id=?', [id]);
  if (!orden) return null;
  orden.detalles = await getDetalles(id);
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
async function verificar(orden_id) {
  return verificarStockOrden(await getDetalles(orden_id));
}

/**
 * Confirma una planilla y descuenta el stock UNA sola vez.
 * El stock puede quedar negativo: la falta de existencias nunca bloquea.
 */
async function confirmarOrden(orden_id) {
  await transaction(async () => {
    const orden = await getOrdenOrFail(orden_id);
    if (orden.estado !== 'borrador') throw new AppError('Solo se pueden confirmar planillas en borrador', 409);
    const detalles = await getDetalles(orden_id);
    if (!detalles.length) throw new AppError('La planilla no tiene líneas para confirmar');

    // Cambio de estado condicional: una segunda confirmación no afecta filas.
    const r = await run(
      `UPDATE ordenes_produccion SET estado='confirmada', confirmed_at=now()
       WHERE id=? AND estado='borrador'`,
      [orden_id]
    );
    if (r.changes !== 1) throw new AppError('La planilla cambió de estado mientras se procesaba', 409);

    // Defensa adicional: una planilla solo puede generar consumos una vez.
    const previos = (await get(`SELECT COUNT(*) AS n FROM movimientos_stock
                         WHERE referencia_tipo='orden' AND referencia_id=? AND tipo='consumo_orden'`, [orden_id])).n;
    if (previos) throw new AppError('Esta planilla ya registró consumos de stock', 409);

    await consumirStockOrden(orden_id, detalles);
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
async function cancelarOrden(orden_id) {
  return transaction(async () => {
    const orden = await getOrdenOrFail(orden_id);
    if (orden.estado === 'cancelada') throw new AppError('La planilla ya está cancelada', 409);

    const r = await run(`UPDATE ordenes_produccion SET estado='cancelada' WHERE id=? AND estado=?`, [orden_id, orden.estado]);
    if (r.changes !== 1) throw new AppError('La planilla cambió de estado mientras se procesaba', 409);

    if (orden.estado !== 'confirmada') return { revertido: false, movimientos: 0 };

    const yaRevertida = (await get(`SELECT COUNT(*) AS n FROM movimientos_stock
                             WHERE referencia_tipo='anulacion_orden' AND referencia_id=?`, [orden_id])).n;
    if (yaRevertida) throw new AppError('Esta planilla ya tiene una devolución de stock registrada', 409);

    const consumos = await all(`
      SELECT insumo_id, talle, SUM(cantidad) AS total
      FROM movimientos_stock
      WHERE referencia_tipo='orden' AND referencia_id=? AND tipo='consumo_orden'
      GROUP BY insumo_id, talle
      ORDER BY insumo_id, talle`, [orden_id]);

    const devoluciones = consumos.filter(c => c.total !== 0).map(c => ({
      insumo_id: c.insumo_id, talle: c.talle, delta: -c.total, tipo: 'ingreso',
      referencia_tipo: 'anulacion_orden', referencia_id: orden_id,
    }));
    await ajustarVarios(devoluciones);
    return { revertido: true, movimientos: devoluciones.length };
  });
}

async function getDetalleConOrden(detalle_id) {
  const det = Number.isInteger(detalle_id) ? await get('SELECT * FROM detalle_orden WHERE id=?', [detalle_id]) : null;
  if (!det) throw new AppError('Línea no encontrada', 404);
  assertBorrador(await getOrdenBloqueada(det.orden_id));
  return det;
}

async function eliminarDetalle(detalle_id) {
  await transaction(async () => {
    await getDetalleConOrden(detalle_id);
    await run('DELETE FROM detalle_orden WHERE id=?', [detalle_id]);
  });
}

async function actualizarDetalle(detalle_id, cantidad) {
  await transaction(async () => {
    await getDetalleConOrden(detalle_id);
    await run('UPDATE detalle_orden SET cantidad=? WHERE id=?', [validarCantidad(cantidad), detalle_id]);
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
