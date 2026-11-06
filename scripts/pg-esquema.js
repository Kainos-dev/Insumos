'use strict';
// Crea (o completa) las tablas en PostgreSQL a partir de db/postgres/esquema.sql.
// Es idempotente y corre en una sola transacción: si algo falla, no queda nada a medias.
//
//   node scripts/pg-esquema.js

const fs = require('fs');
const path = require('path');
const { crearPool } = require('../db/postgres/conexion');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'postgres', 'esquema.sql'), 'utf8');
  const pool = crearPool({ max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    const { rows } = await c.query(`
      SELECT c.relname AS tabla, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
    const trg = await c.query(`
      SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`);
    console.log(`Esquema aplicado: ${rows.length} tablas`);
    for (const r of rows) console.log(`  ${r.tabla.padEnd(26)} RLS ${r.rls ? 'activado' : 'DESACTIVADO'}`);
    console.log(`Triggers: ${trg.rows.map(r => r.tgname).join(', ')}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
