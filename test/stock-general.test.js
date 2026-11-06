'use strict';
// Stock sin talle (cierres / hebillas): una sola fila por insumo, garantizada
// por la base (UNIQUE NULLS NOT DISTINCT), y ajustes simultáneos sin pisarse.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
const stock = require('../services/stockService');
before(() => srv);
after(() => h.cerrar());
beforeEach(() => h.resetear());

const filasGenerales = async id => (await h.filasStock(id)).filter(f => f.talle === null);

test('movimientos repetidos sobre un insumo sin talle no crean filas nuevas y se acumulan', async () => {
  const id = await h.crearInsumo({ nombre: 'Hebilla', tipo: 'hebilla', stock: { general: 50 } });
  await stock.adjustStock(id, null, -4, 'consumo_orden', 'orden', 1);
  await stock.adjustStock(id, null, -6, 'consumo_orden', 'orden', 2);
  await stock.adjustStock(id, null, 10, 'ingreso');
  assert.equal((await filasGenerales(id)).length, 1);
  assert.equal(await stock.getStock(id, null), 50);
  await stock.adjustStock(id, null, -60, 'egreso');
  assert.equal(await stock.getStock(id, null), -10, 'el stock negativo sigue permitido');
  assert.equal((await filasGenerales(id)).length, 1);
});

test('setStock crea la fila si no existe y luego la actualiza (nunca duplica)', async () => {
  const id = await h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre' });
  await stock.setStock(id, null, 7);
  await stock.setStock(id, undefined, 9);
  await stock.setStock(id, '', 11);
  assert.deepEqual((await filasGenerales(id)).map(f => f.stock), [11]);
});

test('talle numérico y texto se tratan como el mismo talle', async () => {
  const id = await h.crearInsumo({ nombre: 'Plantilla', tipo: 'plantilla', talles: ['38'], stock: { 38: 5 } });
  await stock.adjustStock(id, 38, 2, 'ingreso');
  assert.equal((await h.filasStock(id)).length, 1);
  assert.equal(await stock.getStock(id, '38'), 7);
});

test('la base rechaza una segunda fila de stock general para el mismo insumo', async () => {
  const id = await h.crearInsumo({ nombre: 'Hebilla', tipo: 'hebilla', stock: { general: 100 } });
  await assert.rejects(() => h.insertarFilaStock(id, null, 96), /duplicate key|unique/i);
  assert.equal((await filasGenerales(id)).length, 1);
  assert.equal(await stock.contarFilasDuplicadas(id), 0);
});

test('un movimiento sobre un insumo sin fila de stock la crea y registra el movimiento', async () => {
  const id = await h.crearInsumo({ nombre: 'Cierre nuevo', tipo: 'cierre' });
  await stock.adjustStock(id, null, 5, 'ingreso');
  assert.deepEqual((await filasGenerales(id)).map(f => f.stock), [5]);
  assert.deepEqual((await h.movimientos('insumo_id = ?', [id])).map(m => m.cantidad), [5]);
});

test('la API muestra el stock vigente y responde 404 para insumos inexistentes', async () => {
  const { req } = await srv;
  const id = await h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre', stock: { general: 20 } });
  const r = await req('GET', `/api/insumos/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.stock_total, 20);
  assert.equal(r.data.stock_rows.length, 1);
  assert.equal(r.data.stock_duplicados, 0);
  const r404 = await req('GET', '/api/insumos/999999');
  assert.equal(r404.status, 404);
});

test('movimientos simultáneos sobre el mismo insumo no se pisan', async () => {
  const { req } = await srv;
  const id = await h.crearInsumo({ nombre: 'Hebilla', tipo: 'hebilla', stock: { general: 100 } });
  await Promise.all(Array.from({ length: 10 }, () =>
    req('POST', '/api/movimientos/rapido', { insumo_id: id, cantidad: 3, tipo: 'egreso' })));
  assert.equal(await stock.getStock(id, null), 70);
  assert.equal((await h.movimientos('insumo_id = ?', [id])).length, 10);
});
