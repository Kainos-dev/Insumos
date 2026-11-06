'use strict';
// Movimientos: tipo correcto en la API e integridad stock ↔ movimientos.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
const pedidos = require('../services/pedidosService');
before(() => srv);
after(() => h.cerrar());

let e;
beforeEach(async () => { e = await h.escenarioBase({ stockPlantilla: 10, stockFondo: 10, stockCierre: 50 }); });
const api = async (m, u, b) => (await srv).req(m, u, b);

test('la columna tipo es el tipo de movimiento y el del insumo va aparte', async () => {
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.plantilla, talle: '38', cantidad: 3, tipo: 'ingreso' });
  const { data: { id } } = await api('POST', '/api/ordenes', {});
  await api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas: [{ talle: '38', cantidad: 1 }] });
  await api('POST', `/api/ordenes/${id}/confirmar`);

  const lista = (await api('GET', `/api/movimientos?insumo_id=${e.plantilla}`)).data;
  assert.deepEqual(lista.map(m => m.tipo).sort(), ['consumo_orden', 'ingreso']);
  assert.ok(lista.every(m => m.insumo_tipo === 'plantilla'));
  const consumo = lista.find(m => m.tipo === 'consumo_orden');
  assert.deepEqual([consumo.cantidad, consumo.talle, consumo.referencia_tipo, consumo.referencia_id], [-1, '38', 'orden', id]);
});

test('la API devuelve lo mismo que la tabla (fechas incluidas)', async () => {
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 4, tipo: 'egreso' });
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 7, tipo: 'ajuste' });
  const api_ = (await api('GET', '/api/movimientos?limit=100')).data;
  const tabla = JSON.parse(JSON.stringify(await h.movimientos()));   // las fechas viajan como texto ISO
  assert.equal(api_.length, tabla.length);
  for (const t of tabla) {
    const a = api_.find(x => x.id === t.id);
    for (const campo of ['insumo_id', 'talle', 'tipo', 'cantidad', 'referencia_tipo', 'referencia_id', 'created_at']) {
      assert.equal(a[campo], t[campo], `campo ${campo} del movimiento ${t.id}`);
    }
  }
  assert.ok(!Number.isNaN(Date.parse(api_[0].created_at)), 'la fecha se puede interpretar en el navegador');
});

test('integridad: la suma de movimientos explica cada cambio de stock', async () => {
  const inicial = { p38: 10, f38: 10, c: 50 };
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.plantilla, talle: '38', cantidad: 5, tipo: 'ingreso' });
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 3, tipo: 'egreso' });
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.fondo, talle: '38', cantidad: 2, tipo: 'ajuste' });
  const { data: { id } } = await api('POST', '/api/ordenes', {});
  await api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas: [{ talle: '38', cantidad: 20 }] });
  await api('POST', `/api/ordenes/${id}/confirmar`);
  await h.asignarDirecto(e.cierre, 'dani');
  const ped = await pedidos.crearPedido(e.prov, [{ insumo_id: e.cierre, cantidad: 6 }], await h.responsableId('dani'));
  await pedidos.actualizarEstado(ped, 'enviado');
  await pedidos.actualizarEstado(ped, 'recibido');
  await api('POST', `/api/ordenes/${id}/cancelar`);

  const suma = async (insumo, talle) => (await h.movimientos('insumo_id = ? AND talle IS NOT DISTINCT FROM ?', [insumo, talle]))
    .reduce((s, m) => s + m.cantidad, 0);
  const stock = async (insumo, talle) => (await h.filasStock(insumo)).find(f => f.talle === talle).stock;
  assert.equal(await stock(e.plantilla, '38'), inicial.p38 + await suma(e.plantilla, '38'));
  assert.equal(await stock(e.fondo, '38'), inicial.f38 + await suma(e.fondo, '38'));
  assert.equal(await stock(e.cierre, null), inicial.c + await suma(e.cierre, null));
  assert.equal(await stock(e.plantilla, '39'), 10, 'talle no tocado');
});

test('límite de resultados saneado', async () => {
  for (let i = 0; i < 3; i++) await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 1, tipo: 'ingreso' });
  assert.equal((await api('GET', '/api/movimientos?limit=2')).data.length, 2);
  assert.equal((await api('GET', '/api/movimientos?limit=abc')).status, 200);
  assert.equal((await api('GET', '/api/movimientos?limit=-5')).data.length, 3);
  assert.deepEqual((await api('GET', '/api/movimientos?insumo_id=abc')).data, []);
});
