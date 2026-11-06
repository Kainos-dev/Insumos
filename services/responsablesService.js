'use strict';
// ============================================================
// Responsables de reposición (E4)
//
// · Cada insumo tiene como máximo un responsable (insumo_id es clave
//   primaria de insumo_responsable).
// · Asignar o cambiar un responsable NUNCA modifica stock, movimientos ni
//   historiales.
// · Si la base no tiene las tablas de responsables, las operaciones de
//   responsables responden 503 y el resto del sistema funciona igual.
// · Los espacios individuales son vistas de trabajo, no controles de acceso.
// ============================================================

const { get, all, run, transaction } = require('../db/database');
const { AppError } = require('../utils/errores');
const { getAlertasStock, detallesInsumos } = require('./stockService');

const TABLAS = ['responsables', 'insumo_responsable', 'pedido_responsable'];

// Migraciones de E4. En PostgreSQL forman parte de db/postgres/esquema.sql
// y quedan registradas en la tabla schema_migraciones.
const MIGRACIONES_E4 = [
  { id: '001_responsables', descripcion: 'Responsables de reposición y asignación de insumos (máximo uno por insumo)' },
  { id: '002_pedido_responsable', descripcion: 'Responsable de cada pedido nuevo (los pedidos históricos quedan sin asignar)' },
  { id: '003_reglas_responsables', descripcion: 'Reglas en la base: no reasignar insumos con pedidos abiertos de otro responsable; responsable del pedido inmutable' },
];

// Una vez que las tablas existen no desaparecen: se recuerda para no consultar en cada operación.
let _disponible = false;

/** true si la base tiene las tablas de responsables. */
async function disponible() {
  if (_disponible) return true;
  const r = await get(
    `SELECT ${TABLAS.map(() => 'to_regclass(?) IS NOT NULL').join(' AND ')} AS ok`,
    TABLAS.map(t => `public.${t}`));
  _disponible = Boolean(r && r.ok);
  return _disponible;
}

async function assertDisponible() {
  if (!(await disponible())) {
    throw new AppError('La gestión de responsables no está habilitada en esta base: faltan sus tablas (node scripts/pg-esquema.js).', 503);
  }
}

async function estadoModulo() {
  const hay = await disponible();
  let aplicadas = [];
  if ((await get("SELECT to_regclass('public.schema_migraciones') IS NOT NULL AS ok")).ok) {
    aplicadas = (await all('SELECT id FROM schema_migraciones')).map(m => m.id);
  }
  return {
    disponible: hay,
    migraciones_pendientes: MIGRACIONES_E4.filter(m => !aplicadas.includes(m.id)),
  };
}

// ——— Consultas ———

async function getPorSlug(slug) {
  await assertDisponible();
  const r = await get('SELECT * FROM responsables WHERE slug = ?', [String(slug)]);
  if (!r) throw new AppError('Responsable no encontrado', 404);
  return r;
}

/** Map insumo_id → { responsable_id, slug, nombre, asignado_at } (vacío si no hay tablas). */
async function mapaAsignaciones() {
  if (!(await disponible())) return new Map();
  const filas = await all(`
    SELECT ir.insumo_id, ir.responsable_id, ir.asignado_at, r.slug, r.nombre
    FROM insumo_responsable ir JOIN responsables r ON r.id = ir.responsable_id`);
  return new Map(filas.map(f => [f.insumo_id, f]));
}

/** Responsable asignado a un insumo (o null). */
async function responsableDeInsumo(insumo_id) {
  if (!(await disponible())) return null;
  const r = await get('SELECT responsable_id FROM insumo_responsable WHERE insumo_id = ?', [insumo_id]);
  return r ? r.responsable_id : null;
}

/** Insumos sin responsable asignado. */
async function insumosSinAsignar() {
  if (!(await disponible())) return null;
  return all(`
    SELECT i.id, i.nombre, i.tipo FROM insumos i
    WHERE NOT EXISTS (SELECT 1 FROM insumo_responsable ir WHERE ir.insumo_id = i.id)
    ORDER BY i.tipo, i.nombre`);
}

/** Resumen por responsable: asignados, alertas por categoría y pedidos pendientes. */
async function listar() {
  await assertDisponible();
  const [responsables, asign, alertas, filasPendientes] = await Promise.all([
    all('SELECT * FROM responsables ORDER BY id'),
    mapaAsignaciones(),
    getAlertasStock(),
    all(`
    SELECT pr.responsable_id, COUNT(*) AS n FROM pedido_responsable pr
    JOIN pedidos_proveedor p ON p.id = pr.pedido_id
    WHERE p.estado IN ('borrador','enviado')
    GROUP BY pr.responsable_id`),
  ]);
  const pendientes = new Map(filasPendientes.map(f => [f.responsable_id, f.n]));
  return responsables.map(r => {
    const ids = new Set([...asign.values()].filter(a => a.responsable_id === r.id).map(a => a.insumo_id));
    const propias = alertas.filter(a => ids.has(a.id));
    return {
      ...r,
      insumos_asignados: ids.size,
      faltantes: propias.filter(a => a.tipo_alerta === 'faltante').length,
      sin_stock: propias.filter(a => a.tipo_alerta === 'sin_stock').length,
      stock_bajo: propias.filter(a => a.tipo_alerta === 'stock_bajo').length,
      pedidos_pendientes: pendientes.get(r.id) || 0,
    };
  });
}

/** Datos del espacio de trabajo de un responsable: solo sus insumos y pedidos. */
async function panel(slug) {
  const r = await getPorSlug(slug);
  const [filas, todasLasAlertas, pedidos] = await Promise.all([all(`
    SELECT i.*, p.nombre AS proveedor_nombre, ir.asignado_at
    FROM insumo_responsable ir
    JOIN insumos i ON i.id = ir.insumo_id
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    WHERE ir.responsable_id = ?
    ORDER BY i.tipo, i.nombre`, [r.id]),
  getAlertasStock(),
  all(`
    SELECT pp.*, pr.nombre AS proveedor_nombre,
           COUNT(d.id) AS lineas, SUM(d.cantidad) AS total_unidades
    FROM pedido_responsable x
    JOIN pedidos_proveedor pp ON pp.id = x.pedido_id
    JOIN proveedores pr ON pr.id = pp.proveedor_id
    LEFT JOIN detalle_pedido_proveedor d ON d.pedido_id = pp.id
    WHERE x.responsable_id = ?
    GROUP BY pp.id, pr.id
    ORDER BY pp.created_at DESC, pp.id DESC
    LIMIT 30`, [r.id]),
  ]);
  const insumos = await detallesInsumos(filas);
  const ids = new Set(insumos.map(i => i.id));
  const alertas = todasLasAlertas.filter(a => ids.has(a.id));
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

/**
 * Asigna, cambia o quita (responsable_id = null) el responsable de varios
 * insumos, en orden y en una sola transacción: si una falla, no se aplica
 * ninguna. Cada cambio se bloquea si deja incompatible algún pedido ABIERTO
 * (borrador o enviado) con responsable que contenga el insumo; los pedidos
 * históricos sin responsable no cuentan. No toca stock, movimientos ni historiales.
 * Hace pocas consultas en total, sin importar cuántas asignaciones sean.
 */
async function aplicarAsignaciones(asignaciones) {
  await assertDisponible();
  return transaction(async () => {
    const pedidos = asignaciones.map(a => ({ insumo_id: Number(a.insumo_id), responsable_id: a.responsable_id }));
    const ids = [...new Set(pedidos.map(p => p.insumo_id).filter(Number.isInteger))];
    const insumos = new Map((await all('SELECT id, nombre FROM insumos WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE', [ids]))
      .map(i => [i.id, i]));
    const [responsables, actuales, abiertos] = await Promise.all([
      all('SELECT * FROM responsables'),
      all('SELECT insumo_id, responsable_id FROM insumo_responsable WHERE insumo_id = ANY(?::int[])', [ids]),
      all(`
        SELECT DISTINCT d.insumo_id, p.id, p.estado, pr.responsable_id, r.nombre AS responsable_nombre
        FROM detalle_pedido_proveedor d
        JOIN pedidos_proveedor p ON p.id = d.pedido_id AND p.estado IN ('borrador','enviado')
        JOIN pedido_responsable pr ON pr.pedido_id = p.id
        JOIN responsables r ON r.id = pr.responsable_id
        WHERE d.insumo_id = ANY(?::int[])
        ORDER BY p.id`, [ids]),
    ]);
    const porId = new Map(responsables.map(r => [r.id, r]));
    const estado = new Map(actuales.map(a => [a.insumo_id, a.responsable_id]));
    const original = new Map(estado);

    const resultados = [];
    for (const p of pedidos) {
      const insumo = insumos.get(p.insumo_id);
      if (!insumo) throw new AppError('Insumo no encontrado', 404);
      let rid = null;
      if (p.responsable_id !== null && p.responsable_id !== undefined && p.responsable_id !== '') {
        const r = porId.get(Number(p.responsable_id));
        if (!r) throw new AppError('Responsable inexistente');
        if (!r.activo) throw new AppError(`${r.nombre} no está activo como responsable`);
        rid = r.id;
      }
      if ((estado.get(insumo.id) ?? null) !== rid) {
        const conflictos = abiertos.filter(o => o.insumo_id === insumo.id && (rid === null || o.responsable_id !== rid));
        if (conflictos.length) {
          const lista = conflictos.map(c => `#${c.id} de ${c.responsable_nombre} (${c.estado})`).join(', ');
          throw new AppError(
            `No se puede ${rid === null ? 'quitar' : 'cambiar'} el responsable de «${insumo.nombre}»: ` +
            `está en pedidos abiertos de otro responsable: ${lista}. Recibí o cancelá esos pedidos primero.`, 409);
        }
      }
      estado.set(insumo.id, rid);
      resultados.push({ insumo_id: insumo.id, responsable_id: rid });
    }

    // Aplica el estado final de cada insumo que cambió.
    const quitar = [];
    const poner = [];
    for (const [insumoId, rid] of estado) {
      if ((original.get(insumoId) ?? null) === rid) continue;
      if (rid === null) quitar.push(insumoId); else poner.push([insumoId, rid]);
    }
    if (quitar.length) await run('DELETE FROM insumo_responsable WHERE insumo_id = ANY(?::int[])', [quitar]);
    if (poner.length) {
      await run(`
        INSERT INTO insumo_responsable (insumo_id, responsable_id)
        SELECT a.insumo_id, a.responsable_id FROM unnest(?::int[], ?::int[]) AS a(insumo_id, responsable_id)
        ON CONFLICT (insumo_id) DO UPDATE SET responsable_id = excluded.responsable_id, asignado_at = now()
        WHERE insumo_responsable.responsable_id <> excluded.responsable_id`,
      [poner.map(x => x[0]), poner.map(x => x[1])]);
    }
    return resultados;
  });
}

/** Asigna, cambia o quita (responsable_id = null) el responsable de un insumo. */
async function asignar(insumo_id, responsable_id) {
  return (await aplicarAsignaciones([{ insumo_id, responsable_id }]))[0];
}

/** Varias asignaciones en una sola transacción: si una falla, no se aplica ninguna. */
async function asignarVarios(asignaciones) {
  await assertDisponible();
  if (!Array.isArray(asignaciones) || !asignaciones.length) throw new AppError('No hay asignaciones para aplicar');
  return aplicarAsignaciones(asignaciones);
}

// ——— Pedidos ———

/**
 * Responsable de las líneas de un pedido NUEVO (reglas definitivas):
 * · todos los insumos deben tener responsable asignado;
 * · todos deben pertenecer al mismo responsable.
 * Devuelve el id del responsable común.
 */
async function responsableDeLineas(lineas) {
  await assertDisponible();
  const ids = [...new Set(lineas.map(l => Number(l.insumo_id)))];
  const filas = await all(`
    SELECT i.id, i.nombre, ir.responsable_id, r.nombre AS responsable_nombre
    FROM insumos i
    LEFT JOIN insumo_responsable ir ON ir.insumo_id = i.id
    LEFT JOIN responsables r ON r.id = ir.responsable_id
    WHERE i.id = ANY(?::int[])`, [ids]);
  const porInsumo = new Map(filas.map(f => [f.id, f]));
  const grupos = new Map();
  for (const l of lineas) {
    const f = porInsumo.get(Number(l.insumo_id));
    const rid = f ? f.responsable_id : null;
    if (!grupos.has(rid)) grupos.set(rid, { nombres: new Map(), responsable: f && f.responsable_nombre });
    grupos.get(rid).nombres.set(Number(l.insumo_id), f ? f.nombre : String(l.insumo_id));
  }
  if (grupos.has(null)) {
    const nombres = [...grupos.get(null).nombres.values()];
    throw new AppError(`Estos insumos no tienen responsable asignado: ${nombres.join(', ')}. Asignalos desde Fábrica antes de pedirlos.`);
  }
  if (grupos.size > 1) {
    const nombres = [...grupos.values()].map(g => g.responsable);
    throw new AppError(`Todos los insumos de un pedido deben pertenecer al mismo responsable. Este pedido mezcla: ${nombres.join(', ')}.`);
  }
  return [...grupos.keys()][0];
}

async function asignarPedido(pedido_id, responsable_id) {
  if (!Number.isInteger(responsable_id)) throw new AppError('El pedido necesita un responsable');
  await run('INSERT INTO pedido_responsable (pedido_id, responsable_id) VALUES (?, ?)', [pedido_id, responsable_id]);
}

/**
 * Diagnóstico de pedidos frente a las reglas nuevas (solo lectura).
 * · mezcla: sus insumos pertenecen hoy a más de un responsable (o mezclan
 *   asignados y sin asignar).
 * · desalineado: pedido ABIERTO con responsable cuyo insumo hoy pertenece
 *   a otro. Las reglas de reasignación lo impiden; solo podría aparecer
 *   por cambios hechos fuera de la aplicación. En pedidos cerrados
 *   (recibidos o cancelados) una reasignación posterior es normal.
 * · sin_responsable: pedidos (históricos o sin asignar) sin responsable.
 */
async function diagnosticoPedidos() {
  await assertDisponible();
  const filas = await all(`
    SELECT p.id, p.estado, p.created_at, pv.nombre AS proveedor_nombre,
           x.responsable_id AS responsable_pedido,
           string_agg(DISTINCT COALESCE(ir.responsable_id, 0)::text, ',') AS responsables_insumos
    FROM pedidos_proveedor p
    JOIN proveedores pv ON pv.id = p.proveedor_id
    LEFT JOIN pedido_responsable x ON x.pedido_id = p.id
    LEFT JOIN detalle_pedido_proveedor d ON d.pedido_id = p.id
    LEFT JOIN insumo_responsable ir ON ir.insumo_id = d.insumo_id
    GROUP BY p.id, pv.id, x.pedido_id
    ORDER BY p.id`);
  const nombres = new Map((await all('SELECT id, nombre FROM responsables')).map(r => [r.id, r.nombre]));
  const res = { mezcla: [], desalineado: [], sin_responsable: 0 };
  for (const f of filas) {
    const ids = (f.responsables_insumos || '0').split(',').map(Number);
    const etiqueta = ids.map(id => (id === 0 ? 'sin responsable' : nombres.get(id)));
    if (!f.responsable_pedido) res.sin_responsable++;
    if (ids.length > 1) {
      res.mezcla.push({ id: f.id, estado: f.estado, proveedor_nombre: f.proveedor_nombre, responsables: etiqueta });
    } else if (f.responsable_pedido && ids[0] !== f.responsable_pedido && (f.estado === 'borrador' || f.estado === 'enviado')) {
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
