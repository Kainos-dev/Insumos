'use strict';
// ============================================================
// Acceso a la base de datos (PostgreSQL / Supabase).
//
// Funciones (todas devuelven promesas):
//   all(sql, params)   → todas las filas
//   get(sql, params)   → la primera fila (o undefined)
//   run(sql, params)   → { changes, rows }
//   insert(sql, params)→ id de la fila insertada (agrega RETURNING id)
//   transaction(fn)    → ejecuta fn dentro de una transacción
//
// Los parámetros se escriben con "?" (como antes) y se convierten a $1, $2…
//
// Transacciones: dentro de transaction(fn), todas las consultas (también
// las de funciones llamadas desde fn) usan la misma conexión. Una
// transacción dentro de otra se suma a la exterior: si algo falla, se
// revierte todo.
// ============================================================

const { AsyncLocalStorage } = require('async_hooks');

let _pool = null;
const contexto = new AsyncLocalStorage();

function getPool() {
  if (!_pool) {
    const { crearPool } = require('./postgres/conexion');
    _pool = crearPool();
    _pool.on('error', err => console.error('Error en conexión inactiva de la base:', err.message));
  }
  return _pool;
}

/**
 * Reemplaza la conexión (solo pruebas: una base PostgreSQL en memoria).
 * Debe llamarse antes de la primera consulta.
 */
function usarPool(pool) {
  if (_pool) throw new Error('La base ya estaba conectada');
  _pool = pool;
}

const cacheSql = new Map();
/** Convierte los "?" (fuera de textos entre comillas) a $1, $2… */
function aPostgres(sql) {
  let r = cacheSql.get(sql);
  if (r) return r;
  let n = 0;
  let enTexto = false;
  r = '';
  for (const ch of sql) {
    if (ch === "'") enTexto = !enTexto;
    r += ch === '?' && !enTexto ? `$${++n}` : ch;
  }
  cacheSql.set(sql, r);
  return r;
}

function query(sql, params = []) {
  const ejecutor = contexto.getStore() || getPool();
  return ejecutor.query(aPostgres(sql), params);
}

async function all(sql, params) {
  return (await query(sql, params)).rows;
}

async function get(sql, params) {
  return (await query(sql, params)).rows[0];
}

async function run(sql, params) {
  const r = await query(sql, params);
  return { changes: r.rowCount, rows: r.rows };
}

async function insert(sql, params) {
  const r = await query(`${sql} RETURNING id`, params);
  return r.rows[0].id;
}

async function transaction(fn) {
  if (contexto.getStore()) return fn();   // ya estamos dentro de una transacción
  const cliente = await getPool().connect();
  let falla = null;
  try {
    await cliente.query('BEGIN');
    const resultado = await contexto.run(cliente, fn);
    await cliente.query('COMMIT');
    return resultado;
  } catch (e) {
    // Si no se puede revertir, la conexión se descarta (PostgreSQL revierte al cerrarla).
    await cliente.query('ROLLBACK').catch(err => { falla = err; });
    throw e;
  } finally {
    cliente.release(falla || undefined);
  }
}

async function cerrar() {
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

module.exports = { all, get, run, insert, transaction, cerrar, usarPool, aPostgres };
