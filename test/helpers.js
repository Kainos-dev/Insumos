'use strict';
// ============================================================
// Utilidades de prueba.
//
// SEGURIDAD: cada archivo de prueba trabaja sobre una base SQLite NUEVA en
// una carpeta temporal, marcada como base de pruebas. Las pruebas nunca
// abren la base de trabajo configurada en .env ni ./calzado.db.
//
// Uso (antes de requerir cualquier módulo de la app):
//   const h = require('./helpers');
//   const base = h.prepararBaseDePruebas();
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const TEST_DB_MARKER = 0x44435954; // igual a db/database.js

/** Rutas que las pruebas jamás deben tocar. */
function rutasProtegidas() {
  const rutas = [path.join(RAIZ, 'calzado.db')];
  const env = path.join(RAIZ, '.env');
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, 'utf8').match(/^\s*DB_PATH\s*=\s*(.+?)\s*$/m);
    if (m) rutas.push(path.resolve(m[1].replace(/^["']|["']$/g, '')));
  }
  return rutas.map(r => r.toLowerCase());
}

let _estado = null;

/**
 * opciones.migrar (por defecto true): aplica las migraciones versionadas a la
 * base de prueba. Con false se obtiene una base "como la real antes de E4".
 */
function prepararBaseDePruebas({ migrar = true } = {}) {
  if (_estado) return _estado;
  if (require.cache[require.resolve('../db/database')]) {
    throw new Error('prepararBaseDePruebas() debe llamarse antes de cargar db/database.js');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darc-pruebas-'));
  const dbPath = path.join(dir, 'pruebas.db');
  if (rutasProtegidas().includes(dbPath.toLowerCase())) throw new Error('Ruta de prueba coincide con una base protegida');

  const db = new Database(dbPath);
  db.pragma(`application_id = ${TEST_DB_MARKER}`);
  db.close();

  process.env.DB_PATH = dbPath;
  const database = require('../db/database');
  if (database.DB_PATH.toLowerCase() !== dbPath.toLowerCase()) {
    throw new Error(`La app no usa la base de prueba (usa ${database.DB_PATH})`);
  }
  if (!database.esBaseDePruebas(database.getDb())) throw new Error('La base abierta no está marcada como de pruebas');
  if (migrar) require('../db/migraciones').aplicarPendientes(database.getDb());

  _estado = {
    dbPath,
    db: database.getDb(),
    cerrar() {
      try { database.getDb().close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return _estado;
}

function db() {
  if (!_estado) throw new Error('Llamar primero a prepararBaseDePruebas()');
  const d = _estado.db;
  if (d.pragma('application_id', { simple: true }) !== TEST_DB_MARKER) throw new Error('Base sin marca de pruebas');
  return d;
}

/** Vacía todas las tablas de datos (solo bases de prueba). Conserva los responsables. */
function resetear() {
  for (const t of ['pedido_responsable', 'insumo_responsable']) {
    if (db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) db().exec(`DELETE FROM ${t}`);
  }
  db().exec(`
    DELETE FROM movimientos_stock; DELETE FROM detalle_pedido_proveedor; DELETE FROM pedidos_proveedor;
    DELETE FROM detalle_orden; DELETE FROM ordenes_produccion; DELETE FROM producto_accesorios;
    DELETE FROM producto_talles; DELETE FROM productos; DELETE FROM insumo_talles;
    DELETE FROM insumo_stock; DELETE FROM insumos; DELETE FROM proveedores;
  `);
}

// ——— Datos de prueba (inserción directa, sin pasar por la lógica) ———

function crearProveedor(nombre = 'Proveedor prueba') {
  return Number(db().prepare('INSERT INTO proveedores (nombre) VALUES (?)').run(nombre).lastInsertRowid);
}

function crearInsumo({ nombre = 'Insumo', tipo, stock_minimo = 0, proveedor_id = null, talles = [], stock = {} }) {
  const id = Number(db().prepare('INSERT INTO insumos (nombre, tipo, stock_minimo, proveedor_id) VALUES (?,?,?,?)')
    .run(nombre, tipo, stock_minimo, proveedor_id).lastInsertRowid);
  for (const t of talles) db().prepare('INSERT INTO insumo_talles (insumo_id, talle) VALUES (?,?)').run(id, t);
  for (const [talle, valor] of Object.entries(stock)) {
    insertarFilaStock(id, talle === 'general' ? null : talle, valor);
  }
  return id;
}

/** Inserta una fila de stock tal cual (sirve para simular duplicados históricos). */
function insertarFilaStock(insumo_id, talle, valor) {
  return Number(db().prepare('INSERT INTO insumo_stock (insumo_id, talle, stock) VALUES (?,?,?)')
    .run(insumo_id, talle, valor).lastInsertRowid);
}

function crearProducto({ nombre = 'Producto', plantilla_id, fondo_id, talles = [], accesorios = [] }) {
  const id = Number(db().prepare('INSERT INTO productos (nombre, plantilla_id, fondo_id) VALUES (?,?,?)')
    .run(nombre, plantilla_id, fondo_id).lastInsertRowid);
  for (const t of talles) db().prepare('INSERT INTO producto_talles (producto_id, talle) VALUES (?,?)').run(id, t);
  for (const a of accesorios) {
    db().prepare('INSERT INTO producto_accesorios (producto_id, insumo_id, cantidad_por_par) VALUES (?,?,?)')
      .run(id, a.insumo_id, a.cantidad_por_par);
  }
  return id;
}

function responsableId(slug) {
  return db().prepare('SELECT id FROM responsables WHERE slug = ?').get(slug).id;
}

function asignarDirecto(insumo_id, slug) {
  db().prepare('INSERT OR REPLACE INTO insumo_responsable (insumo_id, responsable_id) VALUES (?, ?)').run(insumo_id, responsableId(slug));
}

function filasStock(insumo_id) {
  return db().prepare('SELECT * FROM insumo_stock WHERE insumo_id=? ORDER BY id').all(insumo_id);
}

function movimientos(where = '1=1', params = []) {
  return db().prepare(`SELECT * FROM movimientos_stock WHERE ${where} ORDER BY id`).all(...params);
}

/**
 * Escenario típico: proveedor, plantilla y fondo por talle (38 y 39 habilitados),
 * un cierre general y un producto que usa 2 cierres por par.
 */
function escenarioBase({ stockPlantilla = 10, stockFondo = 10, stockCierre = 50 } = {}) {
  resetear();
  const prov = crearProveedor('Proveedor A');
  const plantilla = crearInsumo({ nombre: 'Plantilla T', tipo: 'plantilla', stock_minimo: 3, proveedor_id: prov,
    talles: ['38', '39'], stock: { 38: stockPlantilla, 39: stockPlantilla } });
  const fondo = crearInsumo({ nombre: 'Fondo T', tipo: 'fondo', stock_minimo: 3, proveedor_id: prov,
    talles: ['38', '39'], stock: { 38: stockFondo, 39: stockFondo } });
  const cierre = crearInsumo({ nombre: 'Cierre G', tipo: 'cierre', stock_minimo: 5, proveedor_id: prov,
    stock: { general: stockCierre } });
  const producto = crearProducto({ nombre: 'Bota', plantilla_id: plantilla, fondo_id: fondo, talles: ['38', '39'],
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
  prepararBaseDePruebas, db, resetear, rutasProtegidas,
  crearProveedor, crearInsumo, insertarFilaStock, crearProducto, responsableId, asignarDirecto,
  filasStock, movimientos, escenarioBase, iniciarServidor,
  TEST_DB_MARKER,
};
