'use strict';

const { get, all, run, transaction } = require('../db/database');
const { AppError } = require('../utils/errores');

// ------------------------------------------------------------------
// STOCK SIN TALLE (cierres, hebillas)
//
// En PostgreSQL la restricción UNIQUE NULLS NOT DISTINCT (insumo_id, talle)
// impide que existan dos filas de stock general para el mismo insumo.
// Las filas duplicadas de la época SQLite se conciliaron al migrar.
// Las lecturas siguen usando la fila de menor id por compatibilidad.
// ------------------------------------------------------------------

/** '' / undefined → null; números → texto ('38'). */
function normalizarTalle(talle) {
  if (talle === undefined || talle === null) return null;
  const t = String(talle).trim();
  return t === '' ? null : t;
}

/**
 * Fila de stock vigente para insumo+talle (o undefined si no existe).
 * bloquear = true la reserva hasta el fin de la transacción (FOR UPDATE).
 */
function getStockRow(insumo_id, talle = null, { bloquear = false } = {}) {
  const t = normalizarTalle(talle);
  const lock = bloquear ? ' FOR UPDATE' : '';
  return t === null
    ? get(`SELECT * FROM insumo_stock WHERE insumo_id = ? AND talle IS NULL ORDER BY id LIMIT 1${lock}`, [insumo_id])
    : get(`SELECT * FROM insumo_stock WHERE insumo_id = ? AND talle = ? ORDER BY id LIMIT 1${lock}`, [insumo_id, t]);
}

/**
 * Stock de un insumo+talle. talle = null para cierres/hebillas.
 */
async function getStock(insumo_id, talle = null) {
  const row = await getStockRow(insumo_id, talle);
  return row ? row.stock : 0;
}

/**
 * Filas de stock vigentes de un insumo.
 */
function getStockRows(insumo_id) {
  return all(`
    SELECT * FROM insumo_stock s
    WHERE s.insumo_id = ?
      AND (s.talle IS NOT NULL
           OR s.id = (SELECT MIN(x.id) FROM insumo_stock x WHERE x.insumo_id = s.insumo_id AND x.talle IS NULL))
    ORDER BY s.talle`, [insumo_id]);
}

/** Cantidad de filas duplicadas (talle NULL) pendientes de conciliar. */
async function contarFilasDuplicadas(insumo_id) {
  const r = await get('SELECT COUNT(*) AS n FROM insumo_stock WHERE insumo_id = ? AND talle IS NULL', [insumo_id]);
  return Math.max(0, (r ? r.n : 0) - 1);
}

/** Insumos con filas de stock general duplicadas. */
function insumosConDuplicados() {
  return all(`
    SELECT s.insumo_id, i.nombre, COUNT(*) - 1 AS filas_duplicadas
    FROM insumo_stock s JOIN insumos i ON i.id = s.insumo_id
    WHERE s.talle IS NULL
    GROUP BY s.insumo_id, i.nombre HAVING COUNT(*) > 1
    ORDER BY i.nombre`);
}

/**
 * Fija el stock de insumo+talle actualizando la fila vigente (o creándola si
 * no existe). Nunca crea una segunda fila. No registra movimiento: usar
 * adjustStock para cambios de inventario.
 */
async function setStock(insumo_id, talle, stock) {
  if (!Number.isInteger(stock)) throw new AppError('El stock debe ser un número entero');
  const t = normalizarTalle(talle);
  await run(`
    INSERT INTO insumo_stock (insumo_id, talle, stock) VALUES (?, ?, ?)
    ON CONFLICT (insumo_id, talle) DO UPDATE SET stock = excluded.stock`, [insumo_id, t, stock]);
}

const claveStock = (insumo_id, talle) => `${insumo_id}|${talle ?? ''}`;

/**
 * Stock vigente de varios insumo+talle en una sola consulta.
 * claves = [{ insumo_id, talle }] → Map claveStock → stock (0 si no hay fila).
 */
async function stockDeVarios(claves) {
  const mapa = new Map(claves.map(c => [claveStock(c.insumo_id, normalizarTalle(c.talle)), 0]));
  if (!claves.length) return mapa;
  const filas = await all(`
    SELECT DISTINCT ON (s.insumo_id, s.talle) s.insumo_id, s.talle, s.stock
    FROM insumo_stock s
    JOIN unnest(?::int[], ?::text[]) AS v(insumo_id, talle)
      ON v.insumo_id = s.insumo_id AND v.talle IS NOT DISTINCT FROM s.talle
    ORDER BY s.insumo_id, s.talle, s.id`,
  [claves.map(c => c.insumo_id), claves.map(c => normalizarTalle(c.talle))]);
  for (const f of filas) mapa.set(claveStock(f.insumo_id, f.talle), f.stock);
  return mapa;
}

/**
 * Aplica varios ajustes de stock y registra un movimiento por cada uno, en
 * una transacción y con pocas consultas (no una por ajuste).
 * ajustes = [{ insumo_id, talle, delta, tipo, referencia_tipo, referencia_id }]
 * tipo 'ajuste': delta es el valor final; el movimiento guarda la diferencia.
 * Permite stock negativo. Devuelve Map claveStock → stock final.
 */
async function ajustarVarios(ajustes) {
  for (const a of ajustes) {
    if (!Number.isInteger(a.delta)) throw new AppError('La cantidad debe ser un número entero');
    a.talle = normalizarTalle(a.talle);
  }
  const finales = new Map();
  if (!ajustes.length) return finales;
  const insumos = ajustes.map(a => a.insumo_id);
  const talles = ajustes.map(a => a.talle);

  await transaction(async () => {
    // Crea las filas que falten y bloquea todas (en orden de id, para que dos
    // operaciones simultáneas no se traben): los ajustes del mismo insumo+talle
    // se aplican uno después del otro, sin pisarse.
    await run(`
      INSERT INTO insumo_stock (insumo_id, talle, stock)
      SELECT DISTINCT v.insumo_id, v.talle, 0 FROM unnest(?::int[], ?::text[]) AS v(insumo_id, talle)
      ON CONFLICT (insumo_id, talle) DO NOTHING`, [insumos, talles]);
    const filas = await all(`
      SELECT s.id, s.insumo_id, s.talle, s.stock FROM insumo_stock s
      WHERE EXISTS (SELECT 1 FROM unnest(?::int[], ?::text[]) AS v(insumo_id, talle)
                    WHERE v.insumo_id = s.insumo_id AND v.talle IS NOT DISTINCT FROM s.talle)
      ORDER BY s.id
      FOR UPDATE`, [insumos, talles]);
    const porClave = new Map();
    for (const f of filas) if (!porClave.has(claveStock(f.insumo_id, f.talle))) porClave.set(claveStock(f.insumo_id, f.talle), f);

    const movimientos = [];
    for (const a of ajustes) {
      const fila = porClave.get(claveStock(a.insumo_id, a.talle));
      const nuevo = a.tipo === 'ajuste' ? a.delta : fila.stock + a.delta;
      movimientos.push({ ...a, cantidad: nuevo - fila.stock });
      fila.stock = nuevo;
    }
    const cambiadas = [...porClave.values()];
    await run(`
      UPDATE insumo_stock s SET stock = v.stock
      FROM unnest(?::int[], ?::int[]) AS v(id, stock) WHERE s.id = v.id`,
    [cambiadas.map(f => f.id), cambiadas.map(f => f.stock)]);
    await run(`
      INSERT INTO movimientos_stock (insumo_id, talle, tipo, cantidad, referencia_tipo, referencia_id)
      SELECT m.insumo_id, m.talle, m.tipo, m.cantidad, m.referencia_tipo, m.referencia_id
      FROM unnest(?::int[], ?::text[], ?::text[], ?::int[], ?::text[], ?::int[]) WITH ORDINALITY
           AS m(insumo_id, talle, tipo, cantidad, referencia_tipo, referencia_id, n)
      ORDER BY m.n`,
    [movimientos.map(m => m.insumo_id), movimientos.map(m => m.talle), movimientos.map(m => m.tipo),
      movimientos.map(m => m.cantidad), movimientos.map(m => m.referencia_tipo ?? null),
      movimientos.map(m => m.referencia_id ?? null)]);
    for (const f of cambiadas) finales.set(claveStock(f.insumo_id, f.talle), f.stock);
  });
  return finales;
}

/**
 * Ajusta el stock de un insumo+talle y registra el movimiento. Permite stock negativo.
 * tipo 'ajuste': delta es el valor final; el movimiento guarda la diferencia.
 * Devuelve el stock final.
 */
async function adjustStock(insumo_id, talle, delta, tipo, referencia_tipo = null, referencia_id = null) {
  const finales = await ajustarVarios([{ insumo_id, talle, delta, tipo, referencia_tipo, referencia_id }]);
  return finales.get(claveStock(insumo_id, normalizarTalle(talle)));
}

const TIPOS_CON_TALLE = ['plantilla', 'fondo'];
const TIPOS_MOVIMIENTO_MANUAL = ['ingreso', 'egreso', 'ajuste'];

function usaTalle(tipoInsumo) {
  return TIPOS_CON_TALLE.includes(tipoInsumo);
}

/**
 * Único punto de entrada para movimientos manuales de inventario
 * (ingreso, egreso o ajuste a un valor). Valida y siempre registra el movimiento.
 * - ingreso / egreso: cantidad entera > 0.
 * - ajuste: cantidad = valor final, entero >= 0 (permite fijar en 0).
 * - Plantillas y fondos requieren talle; cierres y hebillas no llevan talle.
 */
async function registrarMovimientoManual({ insumo_id, talle, cantidad, tipo, referencia_tipo = null, referencia_id = null }) {
  if (!TIPOS_MOVIMIENTO_MANUAL.includes(tipo)) {
    throw new AppError('Tipo de movimiento inválido (ingreso, egreso o ajuste)');
  }
  const n = typeof cantidad === 'string' && cantidad.trim() !== '' ? Number(cantidad) : cantidad;
  if (!Number.isInteger(n)) throw new AppError('La cantidad debe ser un número entero');
  if (tipo === 'ajuste' ? n < 0 : n <= 0) {
    throw new AppError(tipo === 'ajuste' ? 'El valor del ajuste no puede ser negativo' : 'La cantidad debe ser mayor que cero');
  }
  if (!Number.isInteger(insumo_id)) throw new AppError('Insumo no encontrado', 404);
  const insumo = await get('SELECT id, tipo FROM insumos WHERE id = ?', [insumo_id]);
  if (!insumo) throw new AppError('Insumo no encontrado', 404);
  const t = normalizarTalle(talle);
  if (usaTalle(insumo.tipo) && t === null) throw new AppError('Este insumo lleva stock por talle: indicá el talle');
  if (!usaTalle(insumo.tipo) && t !== null) throw new AppError('Este insumo no lleva talle');

  const delta = tipo === 'egreso' ? -n : n;
  const stock = await adjustStock(insumo.id, t, delta, tipo, referencia_tipo, referencia_id);
  return { insumo_id: insumo.id, talle: t, stock };
}

/** Productos (con plantilla y fondo) y accesorios de varios productos, en dos consultas. */
async function recetas(productoIds) {
  const ids = [...new Set(productoIds)];
  const [productos, accesorios] = await Promise.all([
    all(`
      SELECT p.id, p.nombre AS producto_nombre,
             p.plantilla_id, p.fondo_id,
             i1.nombre AS plantilla_nombre, i1.tipo AS plantilla_tipo,
             i2.nombre AS fondo_nombre,     i2.tipo AS fondo_tipo
      FROM productos p
      JOIN insumos i1 ON i1.id = p.plantilla_id
      JOIN insumos i2 ON i2.id = p.fondo_id
      WHERE p.id = ANY(?::int[])`, [ids]),
    all(`
      SELECT pa.*, i.nombre AS insumo_nombre, i.tipo AS insumo_tipo
      FROM producto_accesorios pa LEFT JOIN insumos i ON i.id = pa.insumo_id
      WHERE pa.producto_id = ANY(?::int[]) ORDER BY pa.id`, [ids]),
  ]);
  const accPorProducto = new Map(ids.map(id => [id, []]));
  for (const a of accesorios) accPorProducto.get(a.producto_id).push(a);
  return { productos: new Map(productos.map(p => [p.id, p])), accesorios: accPorProducto };
}

/**
 * Verificar stock para una orden — agrupado por PRODUCTO con consumo acumulado.
 *
 * - Se procesan los detalles en orden.
 * - Cada consumo descuenta del stock virtual (no del real).
 * - Si dos productos (o dos bloques del mismo) usan el mismo insumo,
 *   el segundo compara contra el stock RESTANTE después del primero.
 *
 * Retorna: [ { producto_id, producto_nombre, insumos: [...] } ]
 * donde cada insumo tiene: { insumo_id, nombre, tipo, talle, stock_actual, necesario, faltante }
 */
async function verificarStockOrden(detalles) {
  const { productos, accesorios } = await recetas(detalles.map(d => d.producto_id));

  // Todo el stock necesario en una sola consulta.
  const claves = [];
  for (const det of detalles) {
    const p = productos.get(det.producto_id);
    if (!p) continue;
    claves.push({ insumo_id: p.plantilla_id, talle: det.talle }, { insumo_id: p.fondo_id, talle: det.talle });
    for (const acc of accesorios.get(det.producto_id)) claves.push({ insumo_id: acc.insumo_id, talle: null });
  }
  const stockReal = await stockDeVarios(claves);
  const stockVirtual = new Map(stockReal);
  const real = (insumo_id, talle) => stockReal.get(claveStock(insumo_id, normalizarTalle(talle)));
  const virtual = (insumo_id, talle) => stockVirtual.get(claveStock(insumo_id, normalizarTalle(talle)));
  const consumirVirtual = (insumo_id, talle, cantidad) => {
    const k = claveStock(insumo_id, normalizarTalle(talle));
    stockVirtual.set(k, stockVirtual.get(k) - cantidad);
  };

  const resultadoPorProducto = [];

  for (const det of detalles) {
    const producto = productos.get(det.producto_id);
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
    const stockAntesPlantilla = virtual(producto.plantilla_id, det.talle);
    bloque.insumos.push({
      insumo_id:    producto.plantilla_id,
      nombre:       producto.plantilla_nombre,
      tipo:         'plantilla',
      talle:        det.talle,
      stock_actual: real(producto.plantilla_id, det.talle),  // stock real para mostrar
      stock_virtual: stockAntesPlantilla,                    // stock disponible en este momento
      necesario:    pares,
      faltante:     Math.max(0, pares - stockAntesPlantilla),
    });
    consumirVirtual(producto.plantilla_id, det.talle, pares);

    // — Fondo —
    const stockAntesFondo = virtual(producto.fondo_id, det.talle);
    bloque.insumos.push({
      insumo_id:    producto.fondo_id,
      nombre:       producto.fondo_nombre,
      tipo:         'fondo',
      talle:        det.talle,
      stock_actual: real(producto.fondo_id, det.talle),
      stock_virtual: stockAntesFondo,
      necesario:    pares,
      faltante:     Math.max(0, pares - stockAntesFondo),
    });
    consumirVirtual(producto.fondo_id, det.talle, pares);

    // — Accesorios —
    for (const acc of accesorios.get(det.producto_id)) {
      const necesario  = pares * acc.cantidad_por_par;
      const stockAntes = virtual(acc.insumo_id, null);
      bloque.insumos.push({
        insumo_id:    acc.insumo_id,
        nombre:       acc.insumo_nombre ?? '?',
        tipo:         acc.insumo_tipo ?? '?',
        talle:        null,
        stock_actual: real(acc.insumo_id, null),
        stock_virtual: stockAntes,
        necesario,
        faltante:     Math.max(0, necesario - stockAntes),
      });
      consumirVirtual(acc.insumo_id, null, necesario);
    }

    resultadoPorProducto.push(bloque);
  }

  return resultadoPorProducto;
}

/**
 * Descuenta el stock de una planilla confirmada (un movimiento por insumo de
 * cada línea, como siempre). Permite negativos.
 */
async function consumirStockOrden(orden_id, detalles) {
  const { productos, accesorios } = await recetas(detalles.map(d => d.producto_id));
  const ajustes = [];
  for (const det of detalles) {
    const producto = productos.get(det.producto_id);
    if (!producto) continue;
    const pares = det.cantidad;
    const consumo = (insumo_id, talle, cantidad) =>
      ajustes.push({ insumo_id, talle, delta: -cantidad, tipo: 'consumo_orden', referencia_tipo: 'orden', referencia_id: orden_id });
    consumo(producto.plantilla_id, det.talle, pares);
    consumo(producto.fondo_id, det.talle, pares);
    for (const acc of accesorios.get(det.producto_id)) consumo(acc.insumo_id, null, pares * acc.cantidad_por_par);
  }
  await ajustarVarios(ajustes);
}

// ------------------------------------------------------------------
// CLASIFICACIÓN DE STOCK — regla única para toda la aplicación
//   · faltante:   stock < 0
//   · sin_stock:  stock = 0
//   · stock_bajo: 0 < stock <= mínimo, solo cuando el mínimo es > 0
//   · ok:         el resto
//
// ALERTAS DE INVENTARIO
//   · Un faltante (negativo) se muestra SIEMPRE, aunque el talle no esté
//     habilitado: un negativo nunca se oculta.
//   · Sin stock y stock bajo solo cuentan en talles habilitados o en
//     stock general (cierres / hebillas).
// ------------------------------------------------------------------

const PRIORIDAD_ESTADO = { faltante: 0, sin_stock: 1, stock_bajo: 2, ok: 3 };

/** 'faltante' | 'sin_stock' | 'stock_bajo' | 'ok' */
function clasificarStock(stock, minimo) {
  if (stock < 0) return 'faltante';
  if (stock === 0) return 'sin_stock';
  if (minimo > 0 && stock <= minimo) return 'stock_bajo';
  return 'ok';
}

/** Alerta para una fila: 'faltante' | 'sin_stock' | 'stock_bajo' | null. */
function clasificarFila(stock, minimo, habilitado) {
  const c = clasificarStock(stock, minimo);
  if (c === 'faltante') return c;
  if (!habilitado || c === 'ok') return null;
  return c;
}

/**
 * Estado resumido de un insumo (el peor de sus filas relevantes):
 * 'faltante' | 'sin_stock' | 'stock_bajo' | 'ok'.
 */
function estadoStock(insumo, filas, tallesHabilitados) {
  const habilitados = new Set((tallesHabilitados || []).map(String));
  let estado = 'ok';
  for (const f of filas) {
    const habilitado = f.talle === null || habilitados.has(String(f.talle));
    const c = clasificarFila(f.stock, insumo.stock_minimo, habilitado) || 'ok';
    if (PRIORIDAD_ESTADO[c] < PRIORIDAD_ESTADO[estado]) estado = c;
  }
  return estado;
}

/** Alertas de inventario (faltantes y stock bajo), sin duplicados. */
async function getAlertasStock() {
  const rows = await all(`
    SELECT i.id, i.nombre, i.tipo, i.stock_minimo, i.proveedor_id,
           p.nombre AS proveedor_nombre,
           s.id AS stock_id, s.talle, s.stock,
           CASE WHEN s.talle IS NULL THEN 1
                WHEN EXISTS (SELECT 1 FROM insumo_talles t WHERE t.insumo_id = i.id AND t.talle = s.talle) THEN 1
                ELSE 0 END AS talle_habilitado,
           (SELECT COUNT(*) FROM insumo_stock d WHERE d.insumo_id = i.id AND d.talle IS NULL) AS filas_generales
    FROM insumo_stock s
    JOIN insumos i ON i.id = s.insumo_id
    LEFT JOIN proveedores p ON p.id = i.proveedor_id
    WHERE s.talle IS NOT NULL
       OR s.id = (SELECT MIN(x.id) FROM insumo_stock x WHERE x.insumo_id = s.insumo_id AND x.talle IS NULL)
  `);

  const alertas = [];
  for (const r of rows) {
    const tipo_alerta = clasificarFila(r.stock, r.stock_minimo, r.talle_habilitado === 1);
    if (!tipo_alerta) continue;
    const { filas_generales, ...resto } = r;
    alertas.push({
      ...resto,
      talle_habilitado: r.talle_habilitado === 1,
      conciliacion_pendiente: r.talle === null && filas_generales > 1,
      tipo_alerta,
    });
  }
  return alertas.sort((a, b) =>
    PRIORIDAD_ESTADO[a.tipo_alerta] - PRIORIDAD_ESTADO[b.tipo_alerta] ||
    a.stock - b.stock || a.nombre.localeCompare(b.nombre) || String(a.talle).localeCompare(String(b.talle)));
}

/**
 * Completa un insumo con talles habilitados, filas de stock vigentes,
 * total, duplicados pendientes y estado de stock.
 */
async function detalleInsumo(row) {
  await detallesInsumos([row]);
  return row;
}

/** Igual que detalleInsumo, para varios insumos con solo dos consultas en total. */
async function detallesInsumos(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const [talles, stock] = await Promise.all([
    all('SELECT insumo_id, talle FROM insumo_talles WHERE insumo_id = ANY(?::int[]) ORDER BY talle', [ids]),
    all('SELECT * FROM insumo_stock WHERE insumo_id = ANY(?::int[]) ORDER BY talle NULLS FIRST, id', [ids]),
  ]);
  const tallesDe = new Map(ids.map(id => [id, []]));
  for (const t of talles) tallesDe.get(t.insumo_id).push(t.talle);
  const stockDe = new Map(ids.map(id => [id, { filas: [], generales: 0 }]));
  for (const f of stock) {
    const s = stockDe.get(f.insumo_id);
    if (f.talle === null && s.generales++ > 0) continue;   // fila vigente: la de menor id
    s.filas.push(f);
  }
  for (const row of rows) {
    const s = stockDe.get(row.id);
    row.talles = tallesDe.get(row.id);
    row.stock_rows = s.filas;
    row.stock_total = s.filas.reduce((t, r) => t + r.stock, 0);
    row.stock_duplicados = Math.max(0, s.generales - 1);
    row.estado_stock = estadoStock(row, row.stock_rows, row.talles);   // 'faltante' | 'sin_stock' | 'stock_bajo' | 'ok'
    row.sin_talles_habilitados = usaTalle(row.tipo) && row.talles.length === 0;
  }
  return rows;
}

/** Plantillas y fondos sin talles habilitados: no pueden generar alertas de stock bajo. */
function insumosSinTallesHabilitados() {
  return all(`
    SELECT i.id, i.nombre, i.tipo FROM insumos i
    WHERE i.tipo IN ('plantilla','fondo')
      AND NOT EXISTS (SELECT 1 FROM insumo_talles t WHERE t.insumo_id = i.id)
    ORDER BY i.nombre`);
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
  ajustarVarios,
  stockDeVarios,
  claveStock,
  usaTalle,
  registrarMovimientoManual,
  TIPOS_CON_TALLE,
  verificarStockOrden,
  consumirStockOrden,
  getAlertasStock,
  clasificarStock,
  clasificarFila,
  estadoStock,
  detalleInsumo,
  detallesInsumos,
  insumosSinTallesHabilitados,
};
