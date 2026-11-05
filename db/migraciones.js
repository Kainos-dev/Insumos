'use strict';
// ============================================================
// Migraciones versionadas del esquema.
//
// - NUNCA se aplican automáticamente al iniciar el servidor: se aplican
//   con scripts/migrar.js (o en las bases de prueba).
// - Son idempotentes: cada paso usa IF NOT EXISTS / INSERT OR IGNORE y la
//   tabla schema_migraciones registra las ya aplicadas.
// - Solo AGREGAN tablas nuevas: no modifican tablas, filas ni cantidades
//   existentes (inventario, movimientos, pedidos o planillas).
// ============================================================

const MIGRACIONES = [
  {
    id: '001_responsables',
    descripcion: 'Responsables de reposición y asignación de insumos (máximo uno por insumo)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS responsables (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          slug       TEXT    NOT NULL UNIQUE,
          nombre     TEXT    NOT NULL,
          activo     INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
          created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        );

        -- insumo_id como clave primaria: un insumo tiene como máximo un responsable
        CREATE TABLE IF NOT EXISTS insumo_responsable (
          insumo_id      INTEGER PRIMARY KEY REFERENCES insumos(id) ON DELETE CASCADE,
          responsable_id INTEGER NOT NULL REFERENCES responsables(id),
          asignado_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS ix_insumo_responsable_responsable ON insumo_responsable(responsable_id);

        -- Responsables iniciales. Ningún insumo queda asignado.
        INSERT OR IGNORE INTO responsables (slug, nombre) VALUES
          ('ruben', 'Rubén'), ('dani', 'Dani'), ('jorge', 'Jorge');
      `);
    },
  },
  {
    id: '002_pedido_responsable',
    descripcion: 'Responsable de cada pedido nuevo (los pedidos históricos quedan sin asignar)',
    up(db) {
      // Tabla separada (no se altera pedidos_proveedor): reversible borrando la tabla.
      db.exec(`
        CREATE TABLE IF NOT EXISTS pedido_responsable (
          pedido_id      INTEGER PRIMARY KEY REFERENCES pedidos_proveedor(id) ON DELETE CASCADE,
          responsable_id INTEGER NOT NULL REFERENCES responsables(id),
          asignado_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS ix_pedido_responsable_responsable ON pedido_responsable(responsable_id);
      `);
    },
  },
];

const TABLA_CONTROL = 'schema_migraciones';

/** SQL para revertir por completo las migraciones de E4 (plan de recuperación). */
const SQL_REVERSION = `
  DROP TABLE IF EXISTS pedido_responsable;
  DROP TABLE IF EXISTS insumo_responsable;
  DROP TABLE IF EXISTS responsables;
  DELETE FROM ${TABLA_CONTROL} WHERE id IN ('001_responsables', '002_pedido_responsable');
`;

function existeTabla(db, nombre) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nombre);
}

/** Migraciones aplicadas (sin crear nada si la tabla de control no existe). */
function aplicadas(db) {
  if (!existeTabla(db, TABLA_CONTROL)) return [];
  return db.prepare(`SELECT id, aplicada_at FROM ${TABLA_CONTROL} ORDER BY id`).all();
}

/** Migraciones pendientes. Solo lectura. */
function pendientes(db) {
  const hechas = new Set(aplicadas(db).map(m => m.id));
  return MIGRACIONES.filter(m => !hechas.has(m.id));
}

/** Aplica las pendientes en una sola transacción. Devuelve los ids aplicados. */
function aplicarPendientes(db) {
  const aplicar = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLA_CONTROL} (
      id          TEXT PRIMARY KEY,
      aplicada_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
    const ids = [];
    for (const m of pendientes(db)) {
      m.up(db);
      db.prepare(`INSERT INTO ${TABLA_CONTROL} (id) VALUES (?)`).run(m.id);
      ids.push(m.id);
    }
    return ids;
  });
  return aplicar();
}

module.exports = { MIGRACIONES, TABLA_CONTROL, SQL_REVERSION, aplicadas, pendientes, aplicarPendientes, existeTabla };
