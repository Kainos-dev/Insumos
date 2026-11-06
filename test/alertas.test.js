'use strict';
// Alertas de inventario: talles habilitados vs no habilitados y stock
// negativo siempre visible.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
const { getAlertasStock } = require('../services/stockService');
const pedidos = require('../services/pedidosService');
before(() => srv);
after(() => h.cerrar());
beforeEach(() => h.resetear());

const api = async (m, u, b) => (await srv).req(m, u, b);

test('un insumo general genera una sola alerta y sin conciliación pendiente', async () => {
  const id = await h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre', stock_minimo: 100, stock: { general: 20 } });
  const alertas = (await getAlertasStock()).filter(a => a.id === id);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].stock, 20);
  assert.equal(alertas[0].tipo_alerta, 'stock_bajo');
  assert.equal(alertas[0].conciliacion_pendiente, false);
});

test('stock bajo solo en talles habilitados; negativos siempre, aunque el talle no esté habilitado', async () => {
  const id = await h.crearInsumo({ nombre: 'Plantilla', tipo: 'plantilla', stock_minimo: 3, talles: ['38'],
    stock: { 38: 2, 39: 1, 40: -2, 41: 10 } });
  const a = (await getAlertasStock()).filter(x => x.id === id);
  const porTalle = Object.fromEntries(a.map(x => [x.talle, x]));
  assert.equal(porTalle['38'].tipo_alerta, 'stock_bajo');
  assert.equal(porTalle['38'].talle_habilitado, true);
  assert.ok(!porTalle['39'], 'talle no habilitado con stock bajo: no alerta');
  assert.equal(porTalle['40'].tipo_alerta, 'faltante', 'negativo en talle no habilitado: se muestra');
  assert.equal(porTalle['40'].talle_habilitado, false);
  assert.ok(!porTalle['41']);
});

test('los faltantes aparecen primero, del más negativo al menos negativo', async () => {
  const p = await h.crearInsumo({ nombre: 'P', tipo: 'plantilla', stock_minimo: 5, talles: ['38', '39'], stock: { 38: -1, 39: 2 } });
  const c = await h.crearInsumo({ nombre: 'C', tipo: 'cierre', stock_minimo: 5, stock: { general: -7 } });
  const a = await getAlertasStock();
  assert.deepEqual(a.map(x => [x.id, x.tipo_alerta, x.stock]), [[c, 'faltante', -7], [p, 'faltante', -1], [p, 'stock_bajo', 2]]);
});

test('el dashboard separa faltantes y stock bajo y reporta avisos de configuración', async () => {
  await h.crearInsumo({ nombre: 'Fondo sin talles', tipo: 'fondo', stock_minimo: 5, stock: { 35: -5, 36: 0 } });
  await h.crearInsumo({ nombre: 'Hebilla', tipo: 'hebilla', stock_minimo: 1, stock: { general: 100 } });
  const { data } = await api('GET', '/api/dashboard');
  assert.equal(data.faltantes.length, 1);
  assert.equal(data.faltantes[0].talle, '35');
  assert.equal(data.stock_bajo.length, 0, 'sin talles habilitados no hay stock bajo');
  assert.equal(data.sin_stock.length, 0, 'el talle 36 en cero no está habilitado: no alerta');
  assert.deepEqual(data.avisos.sin_talles.map(x => x.nombre), ['Fondo sin talles']);
  assert.deepEqual(data.avisos.conciliacion, [], 'la base ya no admite stock general duplicado');
  assert.deepEqual(data.totales, { insumos: 2, productos: 0, proveedores: 0, ordenes_borrador: 0 });
});

test('el estado de cada insumo en la lista usa las mismas reglas', async () => {
  const ok = await h.crearInsumo({ nombre: 'OK', tipo: 'hebilla', stock_minimo: 5, stock: { general: 50 } });
  const bajo = await h.crearInsumo({ nombre: 'Bajo', tipo: 'plantilla', stock_minimo: 5, talles: ['38'], stock: { 38: 5, 39: 100 } });
  const falta = await h.crearInsumo({ nombre: 'Falta', tipo: 'fondo', stock_minimo: 5, talles: ['38'], stock: { 38: 50, 40: -1 } });
  const sinTalles = await h.crearInsumo({ nombre: 'Sin talles', tipo: 'fondo', stock_minimo: 5, stock: { 38: 1 } });
  const lista = (await api('GET', '/api/insumos')).data;
  const estado = id => lista.find(i => i.id === id);
  assert.equal(estado(ok).estado_stock, 'ok');
  assert.equal(estado(bajo).estado_stock, 'stock_bajo');
  assert.equal(estado(falta).estado_stock, 'faltante');
  assert.equal(estado(sinTalles).estado_stock, 'ok');
  assert.equal(estado(sinTalles).sin_talles_habilitados, true);
});

test('el detector de faltantes para pedidos sugiere reponer hasta el mínimo más un margen', async () => {
  const prov = await h.crearProveedor();
  const id = await h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre', stock_minimo: 50, proveedor_id: prov, stock: { general: 10 } });
  const f = (await pedidos.detectarFaltantes()).filter(x => x.insumo_id === id);
  assert.equal(f.length, 1);
  assert.equal(f[0].stock, 10);
  assert.equal(f[0].sugerido, 50 - 10 + 10);
});
