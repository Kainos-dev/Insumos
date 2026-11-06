'use strict';

const { get, all, run, insert, transaction } = require('../db/database');
const { ajustarVarios, getAlertasStock } = require('./stockService');
const { AppError } = require('../utils/errores');
const responsables = require('./responsablesService');

/**
 * Insumos que necesitan reposición:
 * - stock <= stock_minimo (stock bajo)
 * - stock < 0 (faltante real)
 */
async function detectarFaltantes() {
  // Mismas reglas que las alertas del dashboard (sin duplicados).
  return (await getAlertasStock())
    .map(r => ({
      insumo_id: r.id,
      nombre: r.nombre,
      tipo: r.tipo,
      stock_minimo: r.stock_minimo,
      proveedor_id: r.proveedor_id,
      proveedor_nombre: r.proveedor_nombre,
      talle: r.talle,
      stock: r.stock,
      talle_habilitado: r.talle_habilitado,
      sugerido: r.stock < 0
        ? r.stock_minimo + Math.abs(r.stock)
        : r.stock_minimo - r.stock + Math.ceil(r.stock_minimo * 0.2),
      tipo_alerta: r.tipo_alerta,
    }))
    .sort((a, b) => (a.proveedor_id ?? 0) - (b.proveedor_id ?? 0) || a.nombre.localeCompare(b.nombre)
      || String(a.talle).localeCompare(String(b.talle)));
}

/**
 * Devuelve todos los insumos con su stock actual, agrupados por tipo.
 * Usado por el frontend para mostrar stock al armar un pedido.
 */
function getInsumosConStock() {
  return all(`
    SELECT i.id AS insumo_id, i.nombre, i.tipo, i.color,
           i.stock_minimo, i.proveedor_id,
           p.nombre AS proveedor_nombre,
           s.talle, s.stock
    FROM insumos i
    JOIN insumo_stock s ON s.insumo_id = i.id
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    ORDER BY i.tipo, i.nombre, s.talle NULLS FIRST
  `);
}

/**
 * Crea un pedido en borrador.
 * lineas = [{insumo_id, talle, cantidad}]
 *
 * Responsable (reglas definitivas, validadas en el servidor):
 * · Todo pedido nuevo tiene responsable obligatorio (responsableEsperado).
 * · Todos sus insumos deben tener responsable y ser de ese mismo responsable.
 * · No se aceptan insumos sin asignar ni mezclas.
 * · Los pedidos históricos sin responsable no se modifican.
 */
async function crearPedido(proveedor_id, lineas, responsableEsperado) {
  if (!Number.isInteger(proveedor_id) || !(await get('SELECT id FROM proveedores WHERE id=?', [proveedor_id]))) {
    throw new AppError('Proveedor inexistente');
  }
  if (!Array.isArray(lineas) || !lineas.length) throw new AppError('El pedido necesita al menos una línea');
  for (const l of lineas) {
    const c = Number(l.cantidad);
    if (!Number.isInteger(c) || c <= 0) throw new AppError('Cada línea debe tener una cantidad entera mayor que cero');
    const insumoId = Number(l.insumo_id);
    if (!Number.isInteger(insumoId)) throw new AppError('Insumo inexistente en el pedido');
    l.insumo_id = insumoId;
    l.cantidad = c;
  }
  const existentes = new Set((await all('SELECT id FROM insumos WHERE id = ANY(?::int[])',
    [lineas.map(l => l.insumo_id)])).map(r => r.id));
  if (lineas.some(l => !existentes.has(l.insumo_id))) throw new AppError('Insumo inexistente en el pedido');
  const responsableId = await responsables.responsableDeLineas(lineas);
  if (responsableEsperado === undefined || responsableEsperado === null || responsableEsperado === '') {
    throw new AppError('Indicá el responsable del pedido');
  }
  if (Number(responsableEsperado) !== responsableId) {
    throw new AppError('Los insumos del pedido no corresponden al responsable elegido');
  }
  return transaction(async () => {
    const pedidoId = await insert('INSERT INTO pedidos_proveedor (proveedor_id) VALUES (?)', [proveedor_id]);
    await responsables.asignarPedido(pedidoId, responsableId);
    await run(`
      INSERT INTO detalle_pedido_proveedor (pedido_id, insumo_id, talle, cantidad)
      SELECT ?::int, l.insumo_id, l.talle, l.cantidad
      FROM unnest(?::int[], ?::text[], ?::int[]) WITH ORDINALITY AS l(insumo_id, talle, cantidad, n)
      ORDER BY l.n`,
    [pedidoId, lineas.map(l => l.insumo_id), lineas.map(l => (l.talle ? String(l.talle) : null)), lineas.map(l => l.cantidad)]);
    const msg = await generarMensajeWA(pedidoId);
    await run('UPDATE pedidos_proveedor SET mensaje_whatsapp=? WHERE id=?', [msg, pedidoId]);
    return pedidoId;
  });
}

/**
 * Genera el mensaje de WhatsApp desglosado por talle (siempre).
 */
async function generarMensajeWA(pedidoId) {
  const pedido = await get(
    'SELECT pp.*, pr.nombre AS proveedor_nombre FROM pedidos_proveedor pp JOIN proveedores pr ON pr.id=pp.proveedor_id WHERE pp.id=?',
    [pedidoId]
  );
  const detalles = await all(`
    SELECT d.*, i.nombre AS insumo_nombre, i.tipo
    FROM detalle_pedido_proveedor d
    JOIN insumos i ON i.id = d.insumo_id
    WHERE d.pedido_id = ?
    ORDER BY i.nombre, d.talle NULLS FIRST
  `, [pedidoId]);

  let msg = `Hola ${pedido.proveedor_nombre}, necesitamos los siguientes insumos:\n\n`;
  for (const d of detalles) {
    const talleStr = d.talle ? ` (talle ${d.talle})` : '';
    msg += `• ${d.insumo_nombre}${talleStr}: ${d.cantidad} unidades\n`;
  }
  msg += `\nFecha: ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
  return msg;
}

/** Columnas de responsable (null si la base no tiene las tablas). */
async function columnasResponsable() {
  return (await responsables.disponible())
    ? { select: ', r.id AS responsable_id, r.slug AS responsable_slug, r.nombre AS responsable_nombre',
        join: 'LEFT JOIN pedido_responsable x ON x.pedido_id = pp.id LEFT JOIN responsables r ON r.id = x.responsable_id',
        group: ', r.id' }
    : { select: ', NULL AS responsable_id, NULL AS responsable_slug, NULL AS responsable_nombre', join: '', group: '' };
}

async function listarPedidos() {
  const c = await columnasResponsable();
  return all(`
    SELECT pp.*, pr.nombre AS proveedor_nombre,
           COUNT(d.id) AS lineas,
           SUM(d.cantidad) AS total_unidades
           ${c.select}
    FROM pedidos_proveedor pp
    JOIN proveedores pr ON pr.id = pp.proveedor_id
    ${c.join}
    LEFT JOIN detalle_pedido_proveedor d ON d.pedido_id = pp.id
    GROUP BY pp.id, pr.id${c.group}
    ORDER BY pp.created_at DESC, pp.id DESC
  `);
}

async function getPedido(id) {
  if (!Number.isInteger(id)) return null;
  const c = await columnasResponsable();
  const pedido = await get(
    `SELECT pp.*, pr.nombre AS proveedor_nombre ${c.select}
     FROM pedidos_proveedor pp JOIN proveedores pr ON pr.id=pp.proveedor_id ${c.join} WHERE pp.id=?`,
    [id]
  );
  if (!pedido) return null;
  pedido.detalles = await all(`
    SELECT d.*, i.nombre AS insumo_nombre, i.tipo, i.color
    FROM detalle_pedido_proveedor d
    JOIN insumos i ON i.id = d.insumo_id
    WHERE d.pedido_id = ?
    ORDER BY i.nombre, d.talle NULLS FIRST
  `, [id]);
  return pedido;
}

/**
 * Transiciones permitidas. 'recibido' y 'cancelado' son estados finales:
 * un pedido recibido no puede volver atrás ni recibirse de nuevo.
 */
const TRANSICIONES = {
  borrador:  ['enviado', 'cancelado'],
  enviado:   ['recibido', 'cancelado'],
  recibido:  [],
  cancelado: [],
};

/**
 * Cambia el estado de un pedido. Al pasar a 'recibido' suma el stock
 * (respetando talles) en la MISMA transacción que el cambio de estado.
 */
async function actualizarEstado(id, estado) {
  if (!Object.prototype.hasOwnProperty.call(TRANSICIONES, estado)) {
    throw new AppError('Estado inválido');
  }
  await transaction(async () => {
    const pedido = Number.isInteger(id) ? await get('SELECT * FROM pedidos_proveedor WHERE id=?', [id]) : null;
    if (!pedido) throw new AppError('Pedido no encontrado', 404);
    if (!TRANSICIONES[pedido.estado].includes(estado)) {
      throw new AppError(mensajeTransicion(pedido.estado, estado), 409);
    }

    // Cambio condicional: si otro proceso ya cambió el estado, no afecta filas.
    const r = await run(
      `UPDATE pedidos_proveedor
         SET estado = ?, recibido_at = CASE WHEN ? = 'recibido' THEN now() ELSE recibido_at END
       WHERE id = ? AND estado = ?`,
      [estado, estado, id, pedido.estado]
    );
    if (r.changes !== 1) throw new AppError('El pedido cambió de estado mientras se procesaba. Volvé a intentarlo.', 409);

    if (estado === 'recibido') {
      // Defensa adicional: un pedido solo puede generar ingresos una vez.
      const previos = (await get(`SELECT COUNT(*) AS n FROM movimientos_stock
                           WHERE referencia_tipo = 'pedido' AND referencia_id = ?`, [id])).n;
      if (previos) throw new AppError('Este pedido ya registró ingresos de stock', 409);
      const detalles = await all('SELECT * FROM detalle_pedido_proveedor WHERE pedido_id=? ORDER BY id', [id]);
      // talle puede ser NULL (cierres, hebillas) o un valor (plantillas, fondos)
      await ajustarVarios(detalles.map(d => ({
        insumo_id: d.insumo_id, talle: d.talle || null, delta: d.cantidad, tipo: 'ingreso_pedido',
        referencia_tipo: 'pedido', referencia_id: id,
      })));
    }
  });
}

function mensajeTransicion(desde, hacia) {
  if (desde === 'recibido') return 'El pedido ya fue recibido: no puede cambiar de estado ni recibirse de nuevo';
  if (desde === 'cancelado') return 'El pedido está cancelado: no puede cambiar de estado';
  if (desde === hacia) return `El pedido ya está en estado "${desde}"`;
  return `No se puede pasar un pedido de "${desde}" a "${hacia}"`;
}

module.exports = {
  detectarFaltantes,
  getInsumosConStock,
  crearPedido,
  listarPedidos,
  getPedido,
  actualizarEstado,
  generarMensajeWA,
};
