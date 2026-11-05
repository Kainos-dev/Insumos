'use strict';
// Movimientos: tipo correcto en la API e integridad stock ↔ movimientos.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const pedidos = require('../services/pedidosService');
after(async () => { await (await srv).cerrar(); base.cerrar(); });

let e;
beforeEach(() => { e = h.escenarioBase({ stockPlantilla: 10, stockFondo: 10, stockCierre: 50 }); });
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

test('la corrección no altera los datos: la API devuelve lo mismo que la tabla', async () => {
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 4, tipo: 'egreso' });
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 7, tipo: 'ajuste' });
  const api_ = (await api('GET', '/api/movimientos?limit=100')).data;
  const tabla = h.movimientos();
  assert.equal(api_.length, tabla.length);
  for (const t of tabla) {
    const a = api_.find(x => x.id === t.id);
    for (const campo of ['insumo_id', 'talle', 'tipo', 'cantidad', 'referencia_tipo', 'referencia_id', 'created_at']) {
      assert.equal(a[campo], t[campo], `campo ${campo} del movimiento ${t.id}`);
    }
  }
});

test('integridad: la suma de movimientos explica cada cambio de stock', async () => {
  const inicial = {
    p38: 10, f38: 10, c: 50,
  };
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.plantilla, talle: '38', cantidad: 5, tipo: 'ingreso' });
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 3, tipo: 'egreso' });
  await api('POST', '/api/movimientos/rapido', { insumo_id: e.fondo, talle: '38', cantidad: 2, tipo: 'ajuste' });
  const { data: { id } } = await api('POST', '/api/ordenes', {});
  await api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas: [{ talle: '38', cantidad: 20 }] });
  await api('POST', `/api/ordenes/${id}/confirmar`);
  const ped = pedidos.crearPedido(e.prov, [{ insumo_id: e.cierre, cantidad: 6 }]);
  pedidos.actualizarEstado(ped, 'enviado');
  pedidos.actualizarEstado(ped, 'recibido');
  await api('POST', `/api/ordenes/${id}/cancelar`);

  const suma = (insumo, talle) => h.movimientos('insumo_id = ? AND talle IS ?', [insumo, talle])
    .reduce((s, m) => s + m.cantidad, 0);
  const stock = (insumo, talle) => h.filasStock(insumo).find(f => f.talle === talle).stock;
  assert.equal(stock(e.plantilla, '38'), inicial.p38 + suma(e.plantilla, '38'));
  assert.equal(stock(e.fondo, '38'), inicial.f38 + suma(e.fondo, '38'));
  assert.equal(stock(e.cierre, null), inicial.c + suma(e.cierre, null));
  assert.equal(stock(e.plantilla, '39'), 10, 'talle no tocado');
});

test('límite de resultados saneado', async () => {
  for (let i = 0; i < 3; i++) await api('POST', '/api/movimientos/rapido', { insumo_id: e.cierre, cantidad: 1, tipo: 'ingreso' });
  assert.equal((await api('GET', '/api/movimientos?limit=2')).data.length, 2);
  assert.equal((await api('GET', '/api/movimientos?limit=abc')).status, 200);
  assert.equal((await api('GET', '/api/movimientos?limit=-5')).data.length, 3);
});
