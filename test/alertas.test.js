'use strict';
// Alertas de inventario: sin duplicados, talles habilitados vs no
// habilitados y stock negativo siempre visible.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const { getAlertasStock } = require('../services/stockService');
const pedidos = require('../services/pedidosService');
after(async () => { await (await srv).cerrar(); base.cerrar(); });
beforeEach(() => h.resetear());

const api = async (m, u, b) => (await srv).req(m, u, b);

test('un insumo general con filas duplicadas genera una sola alerta con el valor vigente', () => {
  const id = h.crearInsumo({ nombre: 'Cierre dup', tipo: 'cierre', stock_minimo: 100 });
  h.insertarFilaStock(id, null, 20);
  for (let i = 0; i < 17; i++) h.insertarFilaStock(id, null, 16);
  const alertas = getAlertasStock().filter(a => a.id === id);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].stock, 20);
  assert.equal(alertas[0].tipo_alerta, 'stock_bajo');
  assert.equal(alertas[0].conciliacion_pendiente, true);
});

test('stock bajo solo en talles habilitados; negativos siempre, aunque el talle no esté habilitado', () => {
  const id = h.crearInsumo({ nombre: 'Plantilla', tipo: 'plantilla', stock_minimo: 3, talles: ['38'],
    stock: { 38: 2, 39: 1, 40: -2, 41: 10 } });
  const a = getAlertasStock().filter(x => x.id === id);
  const porTalle = Object.fromEntries(a.map(x => [x.talle, x]));
  assert.equal(porTalle['38'].tipo_alerta, 'stock_bajo');
  assert.equal(porTalle['38'].talle_habilitado, true);
  assert.ok(!porTalle['39'], 'talle no habilitado con stock bajo: no alerta');
  assert.equal(porTalle['40'].tipo_alerta, 'faltante', 'negativo en talle no habilitado: se muestra');
  assert.equal(porTalle['40'].talle_habilitado, false);
  assert.ok(!porTalle['41']);
});

test('los faltantes aparecen primero, del más negativo al menos negativo', () => {
  const p = h.crearInsumo({ nombre: 'P', tipo: 'plantilla', stock_minimo: 5, talles: ['38', '39'], stock: { 38: -1, 39: 2 } });
  const c = h.crearInsumo({ nombre: 'C', tipo: 'cierre', stock_minimo: 5, stock: { general: -7 } });
  const a = getAlertasStock();
  assert.deepEqual(a.map(x => [x.id, x.tipo_alerta, x.stock]), [[c, 'faltante', -7], [p, 'faltante', -1], [p, 'stock_bajo', 2]]);
});

test('el dashboard separa faltantes y stock bajo y reporta avisos de configuración', async () => {
  h.crearInsumo({ nombre: 'Fondo sin talles', tipo: 'fondo', stock_minimo: 5, stock: { 35: -5, 36: 0 } });
  const dup = h.crearInsumo({ nombre: 'Hebilla dup', tipo: 'hebilla', stock_minimo: 1 });
  h.insertarFilaStock(dup, null, 100); h.insertarFilaStock(dup, null, 96);
  const { data } = await api('GET', '/api/dashboard');
  assert.equal(data.faltantes.length, 1);
  assert.equal(data.faltantes[0].talle, '35');
  assert.equal(data.stock_bajo.length, 0, 'sin talles habilitados no hay stock bajo');
  assert.equal(data.sin_stock.length, 0, 'el talle 36 en cero no está habilitado: no alerta');
  assert.deepEqual(data.avisos.sin_talles.map(x => x.nombre), ['Fondo sin talles']);
  assert.deepEqual(data.avisos.conciliacion.map(x => [x.nombre, x.filas_duplicadas]), [['Hebilla dup', 1]]);
});

test('el estado de cada insumo en la lista usa las mismas reglas', async () => {
  const ok = h.crearInsumo({ nombre: 'OK', tipo: 'hebilla', stock_minimo: 5, stock: { general: 50 } });
  const bajo = h.crearInsumo({ nombre: 'Bajo', tipo: 'plantilla', stock_minimo: 5, talles: ['38'], stock: { 38: 5, 39: 100 } });
  const falta = h.crearInsumo({ nombre: 'Falta', tipo: 'fondo', stock_minimo: 5, talles: ['38'], stock: { 38: 50, 40: -1 } });
  const sinTalles = h.crearInsumo({ nombre: 'Sin talles', tipo: 'fondo', stock_minimo: 5, stock: { 38: 1 } });
  const lista = (await api('GET', '/api/insumos')).data;
  const estado = id => lista.find(i => i.id === id);
  assert.equal(estado(ok).estado_stock, 'ok');
  assert.equal(estado(bajo).estado_stock, 'stock_bajo');
  assert.equal(estado(falta).estado_stock, 'faltante');
  assert.equal(estado(sinTalles).estado_stock, 'ok');
  assert.equal(estado(sinTalles).sin_talles_habilitados, true);
});

test('el detector de faltantes para pedidos no repite insumos duplicados', () => {
  const prov = h.crearProveedor();
  const id = h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre', stock_minimo: 50, proveedor_id: prov });
  h.insertarFilaStock(id, null, 10); h.insertarFilaStock(id, null, 8); h.insertarFilaStock(id, null, 6);
  const f = pedidos.detectarFaltantes().filter(x => x.insumo_id === id);
  assert.equal(f.length, 1);
  assert.equal(f[0].stock, 10);
  assert.equal(f[0].sugerido, 50 - 10 + 10);
});
