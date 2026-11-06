'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
before(() => srv);
after(() => h.cerrar());

test('las pruebas usan una base PostgreSQL local en memoria, nunca una remota', async () => {
  const { esLocal, urlConexion } = require('../db/postgres/conexion');
  assert.ok(esLocal(urlConexion()));
  const { version } = await h.uno('SELECT version() AS version');
  assert.match(version, /PGlite/);
});

test('la conexión rechaza bases remotas durante las pruebas', () => {
  const { crearPool } = require('../db/postgres/conexion');
  const anterior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://usuario:clave@ejemplo.supabase.com:5432/postgres';
  try {
    assert.throws(() => crearPool(), /no pueden conectarse a una base remota/);
  } finally {
    process.env.DATABASE_URL = anterior;
  }
});

test('la API responde JSON, también para rutas inexistentes', async () => {
  const { req } = await srv;
  await h.escenarioBase();
  const r = await req('GET', '/api/insumos');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 3);
  const r404 = await req('GET', '/api/no-existe');
  assert.equal(r404.status, 404);
  assert.ok(r404.data.error);
});

test('JSON inválido devuelve 400 sin detalles internos', async () => {
  const { base: url } = await srv;
  const r = await fetch(url + '/api/proveedores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malo' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(!/at |stack/i.test(j.error));
});

test('ids no numéricos en la URL responden 404 sin error interno', async () => {
  const { req } = await srv;
  assert.equal((await req('GET', '/api/insumos/abc')).status, 404);
  assert.equal((await req('GET', '/api/proveedores/abc')).status, 404);
  assert.equal((await req('GET', '/api/productos/1.5')).status, 404);
  assert.equal((await req('GET', '/api/ordenes/abc')).status, 404);
  assert.equal((await req('GET', '/api/pedidos/abc')).status, 404);
});

test('los "?" dentro de textos entre comillas no se convierten en parámetros', () => {
  const { aPostgres } = require('../db/database');
  assert.equal(aPostgres("SELECT '¿qué?' AS t, a FROM x WHERE b = ? AND c = ?"),
    "SELECT '¿qué?' AS t, a FROM x WHERE b = $1 AND c = $2");
});
