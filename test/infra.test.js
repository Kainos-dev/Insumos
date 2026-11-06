'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
after(async () => { await (await srv).cerrar(); base.cerrar(); });

test('las pruebas usan una base temporal marcada y nunca una ruta protegida', () => {
  const { DB_PATH, esBaseDePruebas, getDb } = require('../db/database');
  assert.equal(DB_PATH, base.dbPath);
  assert.ok(esBaseDePruebas(getDb()));
  assert.ok(!h.rutasProtegidas().includes(DB_PATH.toLowerCase()));
});

test('la API responde JSON, también para rutas inexistentes', async () => {
  const { req } = await srv;
  h.escenarioBase();
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
