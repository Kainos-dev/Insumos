'use strict';
// Edición de insumos separada de las operaciones de inventario.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
before(() => srv);
after(() => h.cerrar());
beforeEach(() => h.resetear());

const stockDe = async (id, talle) => {
  const f = (await h.filasStock(id)).find(r => r.talle === (talle == null ? null : String(talle)));
  return f ? f.stock : undefined;
};

test('editar un insumo con talles NO modifica sus existencias aunque se envíen stock_rows', async () => {
  const { req } = await srv;
  const { plantilla } = await h.escenarioBase({ stockPlantilla: 10 });
  const r = await req('PUT', `/api/insumos/${plantilla}`, {
    nombre: 'Plantilla renombrada', tipo: 'plantilla', stock_minimo: 4, talles: ['38', '39'],
    stock_rows: [{ talle: '38', stock: 999 }, { talle: '39', stock: 0 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.stock_ignorado, true);
  assert.equal(await stockDe(plantilla, 38), 10);
  assert.equal(await stockDe(plantilla, 39), 10);
  assert.equal((await h.movimientos()).length, 0, 'editar no genera movimientos');
  const ins = (await req('GET', `/api/insumos/${plantilla}`)).data;
  assert.equal(ins.nombre, 'Plantilla renombrada');
  assert.equal(ins.stock_minimo, 4);
});

test('editar un insumo general (cierre) no crea filas ni cambia el stock', async () => {
  const { req } = await srv;
  const { cierre } = await h.escenarioBase({ stockCierre: 50 });
  await req('PUT', `/api/insumos/${cierre}`, { nombre: 'Cierre G2', tipo: 'cierre', stock_rows: [{ talle: null, stock: 1 }] });
  assert.deepEqual((await h.filasStock(cierre)).map(f => f.stock), [50]);
});

test('editar cambia talles habilitados sin tocar stock', async () => {
  const { req } = await srv;
  const { plantilla } = await h.escenarioBase();
  await req('PUT', `/api/insumos/${plantilla}`, { nombre: 'Plantilla T', tipo: 'plantilla', talles: ['38'] });
  const ins = (await req('GET', `/api/insumos/${plantilla}`)).data;
  assert.deepEqual(ins.talles, ['38']);
  assert.equal(ins.stock_rows.length, 2, 'las filas de stock del talle 39 se conservan');
});

test('no se puede pasar de tipo con talles a sin talles si hay stock o movimientos', async () => {
  const { req } = await srv;
  const { plantilla } = await h.escenarioBase();
  const r = await req('PUT', `/api/insumos/${plantilla}`, { nombre: 'X', tipo: 'cierre' });
  assert.equal(r.status, 409);
  assert.equal((await req('GET', `/api/insumos/${plantilla}`)).data.tipo, 'plantilla');
});

test('validaciones de datos generales', async () => {
  const { req } = await srv;
  const { plantilla } = await h.escenarioBase();
  assert.equal((await req('PUT', `/api/insumos/${plantilla}`, { nombre: '', tipo: 'plantilla' })).status, 400);
  assert.equal((await req('PUT', `/api/insumos/${plantilla}`, { nombre: 'A', tipo: 'zapato' })).status, 400);
  assert.equal((await req('PUT', `/api/insumos/${plantilla}`, { nombre: 'A', tipo: 'plantilla', stock_minimo: -1 })).status, 400);
  assert.equal((await req('PUT', '/api/insumos/999999', { nombre: 'A', tipo: 'plantilla' })).status, 404);
});

test('el alta registra el stock inicial como ajuste trazable', async () => {
  const { req } = await srv;
  const prov = await h.crearProveedor();
  const r = await req('POST', '/api/insumos', {
    nombre: 'Fondo nuevo', tipo: 'fondo', proveedor_id: prov, talles: ['40'],
    stock_rows: [{ talle: '40', stock: 12 }, { talle: '41', stock: 0 }],
  });
  assert.equal(r.status, 200);
  const id = r.data.id;
  assert.equal(await stockDe(id, 40), 12);
  assert.equal(await stockDe(id, 41), 0);
  const movs = await h.movimientos('insumo_id = ?', [id]);
  assert.equal(movs.length, 1);
  assert.deepEqual([movs[0].tipo, movs[0].cantidad, movs[0].referencia_tipo], ['ajuste', 12, 'alta_insumo']);

  const g = await req('POST', '/api/insumos', { nombre: 'Hebilla nueva', tipo: 'hebilla', stock_rows: [{ talle: null, stock: 30 }] });
  assert.deepEqual((await h.filasStock(g.data.id)).map(f => [f.talle, f.stock]), [[null, 30]]);
});

test('movimientos manuales: validan tipo, cantidad y talle, y siempre registran movimiento', async () => {
  const { req } = await srv;
  const { plantilla, cierre } = await h.escenarioBase({ stockPlantilla: 10, stockCierre: 50 });
  const mov = (body) => req('POST', '/api/movimientos/rapido', body);

  assert.equal((await mov({ insumo_id: plantilla, talle: '38', cantidad: 5, tipo: 'ingreso' })).status, 200);
  assert.equal(await stockDe(plantilla, 38), 15);
  assert.equal((await mov({ insumo_id: plantilla, talle: '38', cantidad: 20, tipo: 'egreso' })).status, 200);
  assert.equal(await stockDe(plantilla, 38), -5, 'el egreso puede dejar stock negativo');
  assert.equal((await mov({ insumo_id: cierre, cantidad: 0, tipo: 'ajuste' })).status, 200, 'se puede ajustar a 0');
  assert.equal(await stockDe(cierre, null), 0);

  assert.equal((await mov({ insumo_id: plantilla, cantidad: 5, tipo: 'ingreso' })).status, 400, 'falta talle');
  assert.equal((await mov({ insumo_id: cierre, talle: '38', cantidad: 5, tipo: 'ingreso' })).status, 400, 'talle en insumo general');
  assert.equal((await mov({ insumo_id: cierre, cantidad: 0, tipo: 'ingreso' })).status, 400);
  assert.equal((await mov({ insumo_id: cierre, cantidad: 2.5, tipo: 'ingreso' })).status, 400);
  assert.equal((await mov({ insumo_id: cierre, cantidad: 5, tipo: 'consumo_orden' })).status, 400, 'tipo reservado');
  assert.equal((await mov({ insumo_id: 999999, cantidad: 5, tipo: 'ingreso' })).status, 404);

  const movs = await h.movimientos();
  assert.equal(movs.length, 3, 'solo las operaciones válidas generan movimiento');
  assert.deepEqual(movs.map(m => m.cantidad), [5, -20, -50]);
});

test('PUT /insumos/:id/stock queda registrado como ajuste', async () => {
  const { req } = await srv;
  const { plantilla } = await h.escenarioBase({ stockPlantilla: 10 });
  assert.equal((await req('PUT', `/api/insumos/${plantilla}/stock`, { talle: '39', stock: 4 })).status, 200);
  assert.equal(await stockDe(plantilla, 39), 4);
  const m = await h.movimientos();
  assert.deepEqual([m.length, m[0].tipo, m[0].cantidad], [1, 'ajuste', -6]);
});

test('eliminar un insumo con movimientos responde 409 sin borrar nada', async () => {
  const { req } = await srv;
  const { cierre } = await h.escenarioBase();
  await req('POST', '/api/movimientos/rapido', { insumo_id: cierre, cantidad: 1, tipo: 'ingreso' });
  const r = await req('DELETE', `/api/insumos/${cierre}`);
  assert.equal(r.status, 409);
  assert.equal((await req('GET', `/api/insumos/${cierre}`)).status, 200);
});
