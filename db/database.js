'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Configuración local opcional: si existe un archivo .env en la raíz del
// proyecto (no versionado), se cargan sus variables. Las variables ya
// definidas en la sesión tienen prioridad sobre las del archivo.
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(ENV_FILE);
}

// Ruta de la base SQLite. Si DB_PATH no está definida, se usa la ubicación histórica.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'calzado.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  // Si se indicó DB_PATH, la base debe existir: evita crear en silencio una
  // base vacía cuando la ruta está mal escrita.
  _db = new Database(DB_PATH, { fileMustExist: Boolean(process.env.DB_PATH) });
  console.log(`Base de datos: ${DB_PATH}`);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT    NOT NULL,
      contacto   TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS insumos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre       TEXT    NOT NULL,
      tipo         TEXT    NOT NULL CHECK(tipo IN ('plantilla','fondo','cierre','hebilla')),
      color        TEXT,
      stock_minimo INTEGER NOT NULL DEFAULT 0,
      proveedor_id INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS insumo_stock (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
      talle     TEXT,
      stock     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(insumo_id, talle)
    );

    CREATE TABLE IF NOT EXISTS insumo_talles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      insumo_id   INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
      talle       TEXT NOT NULL,
      UNIQUE(insumo_id, talle)
    );

    CREATE TABLE IF NOT EXISTS productos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre       TEXT    NOT NULL,
      plantilla_id INTEGER NOT NULL REFERENCES insumos(id),
      fondo_id     INTEGER NOT NULL REFERENCES insumos(id),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS producto_talles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      talle       TEXT    NOT NULL,
      UNIQUE(producto_id, talle)
    );

    CREATE TABLE IF NOT EXISTS producto_accesorios (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id      INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      insumo_id        INTEGER NOT NULL REFERENCES insumos(id),
      cantidad_por_par INTEGER NOT NULL DEFAULT 1,
      UNIQUE(producto_id, insumo_id)
    );

    CREATE TABLE IF NOT EXISTS ordenes_produccion (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      descripcion  TEXT,
      estado       TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','confirmada','cancelada')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      confirmed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS detalle_orden (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id      INTEGER NOT NULL REFERENCES ordenes_produccion(id) ON DELETE CASCADE,
      producto_id   INTEGER NOT NULL REFERENCES productos(id),
      talle         TEXT    NOT NULL,
      cantidad      INTEGER NOT NULL DEFAULT 1,
      numero_pedido INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pedidos_proveedor (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor_id      INTEGER NOT NULL REFERENCES proveedores(id),
      estado            TEXT    NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','enviado','recibido','cancelado')),
      mensaje_whatsapp  TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      recibido_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS detalle_pedido_proveedor (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos_proveedor(id) ON DELETE CASCADE,
      insumo_id INTEGER NOT NULL REFERENCES insumos(id),
      talle     TEXT,
      cantidad  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS movimientos_stock (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      insumo_id       INTEGER NOT NULL REFERENCES insumos(id),
      talle           TEXT,
      tipo            TEXT NOT NULL CHECK(tipo IN ('ingreso','egreso','ajuste','consumo_orden','ingreso_pedido')),
      cantidad        INTEGER NOT NULL,
      referencia_tipo TEXT,
      referencia_id   INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  // Migración segura: agregar numero_pedido si la DB ya existía sin esa columna.
  // Usamos PRAGMA table_info para verificar antes de alterar.
  const cols = db.prepare("PRAGMA table_info(detalle_orden)").all();
  const tieneNumeroPedido = cols.some(c => c.name === 'numero_pedido');
  if (!tieneNumeroPedido) {
    db.exec(`ALTER TABLE detalle_orden ADD COLUMN numero_pedido INTEGER NOT NULL DEFAULT 1`);
  }
}

// Generic query helpers — portable to PostgreSQL later.
// On migration: replace ? with $1,$2,... and use pg equivalents.
function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

function transaction(fn) {
  return getDb().transaction(fn)();
}

module.exports = { getDb, run, get, all, transaction };
