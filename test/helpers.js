'use strict';
// ============================================================
// Utilidades de prueba.
//
// SEGURIDAD: cada archivo de prueba levanta su propio PostgreSQL en memoria
// (PGlite, dentro del mismo proceso) y la app lo usa en lugar de abrir una
// conexión. Las pruebas nunca usan la base de Supabase:
//   · la app recibe la base de prueba antes de su primera consulta;
//   · DATABASE_URL se fija a una dirección local inexistente (el .env no
//     pisa variables ya definidas), por si algo intentara conectarse;
//   · db/postgres/conexion.js rechaza bases remotas durante node --test;
//   · iniciar() verifica que la base sea PGlite antes de seguir.
//
// Uso:
//   const h = require('./helpers');
//   const srv = h.iniciar();          // promesa: base + esquema + servidor HTTP
//   before(() => srv);
//   after(() => h.cerrar());
// ============================================================

const fs = require('fs');
const path = require('path');
const { PoolPGlite } = require('./pglite-pool');

const RAIZ = path.join(__dirname, '..');

// Antes de cargar cualquier módulo de la app: ninguna conexión remota posible.
process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:1/postgres';

let _estado = null;

async function iniciar() {
  if (_estado) return _estado.srv;
  const { PGlite, types } = await import('@electric-sql/pglite');
  // Mismos tipos que entrega db/postgres/conexion.js con "pg": COUNT/SUM como Number.
  const pglite = await PGlite.create({
    parsers: { [types.INT8]: v => Number(v), [types.NUMERIC]: v => Number(v) },
  });
  const { version } = (await pglite.query('SELECT version() AS version')).rows[0];
  if (!/PGlite/.test(version)) throw new Error(`La base de pruebas no es PGlite: ${version}`);
  await pglite.exec(fs.readFileSync(path.join(RAIZ, 'db', 'postgres', 'esquema.sql'), 'utf8'));

  const database = require('../db/database');
  database.usarPool(new PoolPGlite(pglite));

  const srv = await iniciarServidor();
  _estado = { pglite, database, srv };
  return srv;
}

async function cerrar() {
  if (!_estado) return;
  const { pglite, database, srv } = _estado;
  _estado = null;
  await srv.cerrar();
  await database.cerrar();
  await pglite.close();
}

function db() {
  if (!_estado) throw new Error('Llamar primero a iniciar()');
  return _estado.database;
}

// ——— Consultas directas a la base de prueba (sin pasar por la lógica) ———

const q = (sql, params) => db().all(sql, params);
const uno = (sql, params) => db().get(sql, params);
const ejecutar = (sql, params) => db().run(sql, params);

/** Vacía todas las tablas de datos. Conserva los responsables (y deja a todos activos). */
async function resetear() {
  await ejecutar(`
    TRUNCATE pedido_responsable, insumo_responsable, movimientos_stock, detalle_pedido_proveedor,
             pedidos_proveedor, detalle_orden, ordenes_produccion, producto_accesorios,
             producto_talles, productos, insumo_talles, insumo_stock, insumos, proveedores
    RESTART IDENTITY`);
  await ejecutar('UPDATE responsables SET activo = 1');
}

function crearProveedor(nombre = 'Proveedor prueba') {
  return db().insert('INSERT INTO proveedores (nombre) VALUES (?)', [nombre]);
}

async function crearInsumo({ nombre = 'Insumo', tipo, stock_minimo = 0, proveedor_id = null, talles = [], stock = {} }) {
  const id = await db().insert('INSERT INTO insumos (nombre, tipo, stock_minimo, proveedor_id) VALUES (?,?,?,?)',
    [nombre, tipo, stock_minimo, proveedor_id]);
  for (const t of talles) await ejecutar('INSERT INTO insumo_talles (insumo_id, talle) VALUES (?,?)', [id, t]);
  for (const [talle, valor] of Object.entries(stock)) {
    await insertarFilaStock(id, talle === 'general' ? null : talle, valor);
  }
  return id;
}

/** Inserta una fila de stock tal cual. */
function insertarFilaStock(insumo_id, talle, valor) {
  return db().insert('INSERT INTO insumo_stock (insumo_id, talle, stock) VALUES (?,?,?)', [insumo_id, talle, valor]);
}

async function crearProducto({ nombre = 'Producto', plantilla_id, fondo_id, talles = [], accesorios = [] }) {
  const id = await db().insert('INSERT INTO productos (nombre, plantilla_id, fondo_id) VALUES (?,?,?)',
    [nombre, plantilla_id, fondo_id]);
  for (const t of talles) await ejecutar('INSERT INTO producto_talles (producto_id, talle) VALUES (?,?)', [id, t]);
  for (const a of accesorios) {
    await ejecutar('INSERT INTO producto_accesorios (producto_id, insumo_id, cantidad_por_par) VALUES (?,?,?)',
      [id, a.insumo_id, a.cantidad_por_par]);
  }
  return id;
}

async function responsableId(slug) {
  return (await uno('SELECT id FROM responsables WHERE slug = ?', [slug])).id;
}

async function asignarDirecto(insumo_id, slug) {
  await ejecutar(`INSERT INTO insumo_responsable (insumo_id, responsable_id) VALUES (?, ?)
                  ON CONFLICT (insumo_id) DO UPDATE SET responsable_id = excluded.responsable_id`,
  [insumo_id, await responsableId(slug)]);
}

function filasStock(insumo_id) {
  return q('SELECT * FROM insumo_stock WHERE insumo_id=? ORDER BY id', [insumo_id]);
}

function movimientos(where = '1=1', params = []) {
  return q(`SELECT * FROM movimientos_stock WHERE ${where} ORDER BY id`, params);
}

/** Huella del inventario: stock, movimientos, pedidos y planillas (para verificar que nada cambió). */
async function huella() {
  const tablas = ['insumos', 'insumo_stock', 'insumo_talles', 'movimientos_stock', 'pedidos_proveedor',
    'detalle_pedido_proveedor', 'ordenes_produccion', 'detalle_orden'];
  const r = {};
  for (const t of tablas) r[t] = JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`));
  return r;
}

/**
 * Escenario típico: proveedor, plantilla y fondo por talle (38 y 39 habilitados),
 * un cierre general y un producto que usa 2 cierres por par.
 */
async function escenarioBase({ stockPlantilla = 10, stockFondo = 10, stockCierre = 50 } = {}) {
  await resetear();
  const prov = await crearProveedor('Proveedor A');
  const plantilla = await crearInsumo({ nombre: 'Plantilla T', tipo: 'plantilla', stock_minimo: 3, proveedor_id: prov,
    talles: ['38', '39'], stock: { 38: stockPlantilla, 39: stockPlantilla } });
  const fondo = await crearInsumo({ nombre: 'Fondo T', tipo: 'fondo', stock_minimo: 3, proveedor_id: prov,
    talles: ['38', '39'], stock: { 38: stockFondo, 39: stockFondo } });
  const cierre = await crearInsumo({ nombre: 'Cierre G', tipo: 'cierre', stock_minimo: 5, proveedor_id: prov,
    stock: { general: stockCierre } });
  const producto = await crearProducto({ nombre: 'Bota', plantilla_id: plantilla, fondo_id: fondo, talles: ['38', '39'],
    accesorios: [{ insumo_id: cierre, cantidad_por_par: 2 }] });
  return { prov, plantilla, fondo, cierre, producto };
}

// ——— Servidor HTTP efímero para probar las rutas ———

async function iniciarServidor() {
  const app = require('../app');
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { base, req, cerrar: () => new Promise(res => server.close(res)) };
}

module.exports = {
  iniciar, cerrar, db, q, uno, ejecutar, resetear,
  crearProveedor, crearInsumo, insertarFilaStock, crearProducto, responsableId, asignarDirecto,
  filasStock, movimientos, huella, escenarioBase,
};
