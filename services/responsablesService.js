'use strict';
// ============================================================
// Responsables de reposición (E4)
//
// · Cada insumo tiene como máximo un responsable (insumo_id es clave
//   primaria de insumo_responsable).
// · Asignar o cambiar un responsable NUNCA modifica stock, movimientos ni
//   historiales.
// · Si la base todavía no tiene la migración aplicada, las operaciones de
//   responsables responden 503 y el resto del sistema funciona igual.
// · Los espacios individuales son vistas de trabajo, no controles de acceso.
// ============================================================

const { get, all, run, transaction, getDb } = require('../db/database');
const { existeTabla, pendientes } = require('../db/migraciones');
const { AppError } = require('../utils/errores');
const { getAlertasStock, detalleInsumo } = require('./stockService');

const TABLAS = ['responsables', 'insumo_responsable', 'pedido_responsable'];

/** true si la base tiene las tablas de responsables. */
function disponible() {
  const db = getDb();
  return TABLAS.every(t => existeTabla(db, t));
}

function assertDisponible() {
  if (!disponible()) {
    throw new AppError('La gestión de responsables no está habilitada en esta base: falta aplicar la migración (npm run migrar).', 503);
  }
}

function estadoModulo() {
  return {
    disponible: disponible(),
    migraciones_pendientes: pendientes(getDb()).map(m => ({ id: m.id, descripcion: m.descripcion })),
  };
}

// ——— Consultas ———

function getResponsable(id) {
  return get('SELECT * FROM responsables WHERE id = ?', [id]);
}

function getPorSlug(slug) {
  assertDisponible();
  const r = get('SELECT * FROM responsables WHERE slug = ?', [String(slug)]);
  if (!r) throw new AppError('Responsable no encontrado', 404);
  return r;
}

/** Map insumo_id → { responsable_id, slug, nombre, asignado_at } (vacío si no hay migración). */
function mapaAsignaciones() {
  if (!disponible()) return new Map();
  const filas = all(`
    SELECT ir.insumo_id, ir.responsable_id, ir.asignado_at, r.slug, r.nombre
    FROM insumo_responsable ir JOIN responsables r ON r.id = ir.responsable_id`);
  return new Map(filas.map(f => [f.insumo_id, f]));
}

/** Responsable asignado a un insumo (o null). */
function responsableDeInsumo(insumo_id) {
  if (!disponible()) return null;
  const r = get('SELECT responsable_id FROM insumo_responsable WHERE insumo_id = ?', [insumo_id]);
  return r ? r.responsable_id : null;
}

/** Insumos sin responsable asignado. */
function insumosSinAsignar() {
  if (!disponible()) return null;
  return all(`
    SELECT i.id, i.nombre, i.tipo FROM insumos i
    WHERE NOT EXISTS (SELECT 1 FROM insumo_responsable ir WHERE ir.insumo_id = i.id)
    ORDER BY i.tipo, i.nombre`);
}

/** Resumen por responsable: asignados, alertas por categoría y pedidos pendientes. */
function listar() {
  assertDisponible();
  const responsables = all('SELECT * FROM responsables ORDER BY id');
  const asign = mapaAsignaciones();
  const alertas = getAlertasStock();
  return responsables.map(r => {
    const ids = new Set([...asign.values()].filter(a => a.responsable_id === r.id).map(a => a.insumo_id));
    const propias = alertas.filter(a => ids.has(a.id));
    return {
      ...r,
      insumos_asignados: ids.size,
      faltantes: propias.filter(a => a.tipo_alerta === 'faltante').length,
      sin_stock: propias.filter(a => a.tipo_alerta === 'sin_stock').length,
      stock_bajo: propias.filter(a => a.tipo_alerta === 'stock_bajo').length,
      pedidos_pendientes: get(`
        SELECT COUNT(*) AS n FROM pedido_responsable pr
        JOIN pedidos_proveedor p ON p.id = pr.pedido_id
        WHERE pr.responsable_id = ? AND p.estado IN ('borrador','enviado')`, [r.id]).n,
    };
  });
}

/** Datos del espacio de trabajo de un responsable: solo sus insumos y pedidos. */
function panel(slug) {
  const r = getPorSlug(slug);
  const insumos = all(`
    SELECT i.*, p.nombre AS proveedor_nombre, ir.asignado_at
    FROM insumo_responsable ir
    JOIN insumos i ON i.id = ir.insumo_id
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    WHERE ir.responsable_id = ?
    ORDER BY i.tipo, i.nombre`, [r.id]).map(detalleInsumo);
  const ids = new Set(insumos.map(i => i.id));
  const alertas = getAlertasStock().filter(a => ids.has(a.id));
  const pedidos = all(`
    SELECT pp.*, pr.nombre AS proveedor_nombre,
           COUNT(d.id) AS lineas, SUM(d.cantidad) AS total_unidades
    FROM pedido_responsable x
    JOIN pedidos_proveedor pp ON pp.id = x.pedido_id
    JOIN proveedores pr ON pr.id = pp.proveedor_id
    LEFT JOIN detalle_pedido_proveedor d ON d.pedido_id = pp.id
    WHERE x.responsable_id = ?
    GROUP BY pp.id
    ORDER BY pp.created_at DESC, pp.id DESC
    LIMIT 30`, [r.id]);
  return {
    responsable: r,
    insumos,
    alertas,
    pedidos,
    resumen: {
      insumos_asignados: insumos.length,
      faltantes: alertas.filter(a => a.tipo_alerta === 'faltante').length,
      sin_stock: alertas.filter(a => a.tipo_alerta === 'sin_stock').length,
      stock_bajo: alertas.filter(a => a.tipo_alerta === 'stock_bajo').length,
      pedidos_pendientes: pedidos.filter(p => p.estado === 'borrador' || p.estado === 'enviado').length,
    },
  };
}

// ——— Asignación ———

function validarResponsable(responsable_id) {
  if (responsable_id === null || responsable_id === undefined || responsable_id === '') return null;
  const id = Number(responsable_id);
  const r = Number.isInteger(id) ? getResponsable(id) : null;
  if (!r) throw new AppError('Responsable inexistente');
  if (!r.activo) throw new AppError(`${r.nombre} no está activo como responsable`);
  return r.id;
}

/**
 * Asigna, cambia o quita (responsable_id = null) el responsable de un insumo.
 * No toca stock, movimientos ni historiales.
 */
function asignar(insumo_id, responsable_id) {
  assertDisponible();
  let resultado;
  transaction(() => {
    if (!get('SELECT id FROM insumos WHERE id = ?', [insumo_id])) throw new AppError('Insumo no encontrado', 404);
    const rid = validarResponsable(responsable_id);
    if (rid === null) {
      run('DELETE FROM insumo_responsable WHERE insumo_id = ?', [insumo_id]);
    } else {
      run(`INSERT INTO insumo_responsable (insumo_id, responsable_id) VALUES (?, ?)
           ON CONFLICT(insumo_id) DO UPDATE SET responsable_id = excluded.responsable_id,
                                                asignado_at = datetime('now','localtime')
           WHERE insumo_responsable.responsable_id <> excluded.responsable_id`, [insumo_id, rid]);
    }
    resultado = { insumo_id, responsable_id: rid };
  });
  return resultado;
}

/** Varias asignaciones en una sola transacción: si una falla, no se aplica ninguna. */
function asignarVarios(asignaciones) {
  assertDisponible();
  if (!Array.isArray(asignaciones) || !asignaciones.length) throw new AppError('No hay asignaciones para aplicar');
  const resultados = [];
  transaction(() => {
    for (const a of asignaciones) resultados.push(asignar(Number(a.insumo_id), a.responsable_id));
  });
  return resultados;
}

// ——— Pedidos ———

/**
 * Responsable de un conjunto de líneas de pedido.
 * Devuelve el responsable común (o null si todos los insumos están sin
 * asignar). Rechaza mezclas: distintos responsables, o asignados con
 * no asignados.
 */
function responsableDeLineas(lineas) {
  if (!disponible()) return null;
  const grupos = new Map();
  for (const l of lineas) {
    const rid = responsableDeInsumo(l.insumo_id);
    if (!grupos.has(rid)) grupos.set(rid, []);
    grupos.get(rid).push(l.insumo_id);
  }
  if (grupos.size > 1) {
    const nombres = [...grupos.keys()].map(id => (id === null ? 'sin responsable' : getResponsable(id).nombre));
    throw new AppError(`Todos los insumos de un pedido deben pertenecer al mismo responsable. Este pedido mezcla: ${nombres.join(', ')}.`);
  }
  return [...grupos.keys()][0] ?? null;
}

function asignarPedido(pedido_id, responsable_id) {
  if (responsable_id === null || !disponible()) return;
  run('INSERT INTO pedido_responsable (pedido_id, responsable_id) VALUES (?, ?)', [pedido_id, responsable_id]);
}

/**
 * Diagnóstico de pedidos frente a las reglas nuevas (solo lectura).
 * · mezcla: sus insumos pertenecen hoy a más de un responsable (o mezclan
 *   asignados y sin asignar).
 * · desalineado: el pedido tiene responsable pero algún insumo hoy
 *   pertenece a otro (por una reasignación posterior).
 * · sin_responsable: pedidos (históricos o sin asignar) sin responsable.
 */
function diagnosticoPedidos() {
  assertDisponible();
  const filas = all(`
    SELECT p.id, p.estado, p.created_at, pv.nombre AS proveedor_nombre,
           x.responsable_id AS responsable_pedido,
           GROUP_CONCAT(DISTINCT COALESCE(ir.responsable_id, 0)) AS responsables_insumos
    FROM pedidos_proveedor p
    JOIN proveedores pv ON pv.id = p.proveedor_id
    LEFT JOIN pedido_responsable x ON x.pedido_id = p.id
    LEFT JOIN detalle_pedido_proveedor d ON d.pedido_id = p.id
    LEFT JOIN insumo_responsable ir ON ir.insumo_id = d.insumo_id
    GROUP BY p.id
    ORDER BY p.id`);
  const nombres = new Map(all('SELECT id, nombre FROM responsables').map(r => [r.id, r.nombre]));
  const res = { mezcla: [], desalineado: [], sin_responsable: 0 };
  for (const f of filas) {
    const ids = (f.responsables_insumos || '0').split(',').map(Number);
    const etiqueta = ids.map(id => (id === 0 ? 'sin responsable' : nombres.get(id)));
    if (!f.responsable_pedido) res.sin_responsable++;
    if (ids.length > 1) {
      res.mezcla.push({ id: f.id, estado: f.estado, proveedor_nombre: f.proveedor_nombre, responsables: etiqueta });
    } else if (f.responsable_pedido && ids[0] !== f.responsable_pedido) {
      res.desalineado.push({ id: f.id, estado: f.estado, proveedor_nombre: f.proveedor_nombre,
        responsable_pedido: nombres.get(f.responsable_pedido), responsables: etiqueta });
    }
  }
  return res;
}

module.exports = {
  disponible, assertDisponible, estadoModulo,
  getPorSlug, mapaAsignaciones, responsableDeInsumo, insumosSinAsignar,
  listar, panel, asignar, asignarVarios,
  responsableDeLineas, asignarPedido, diagnosticoPedidos,
};
