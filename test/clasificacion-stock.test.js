'use strict';
// Clasificación de stock aprobada:
//   negativo → faltante · cero → sin_stock
//   0 < stock ≤ mínimo (con mínimo > 0) → stock_bajo · resto → ok
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const { clasificarStock, getAlertasStock } = require('../services/stockService');
after(async () => { await (await srv).cerrar(); base.cerrar(); });
beforeEach(() => h.resetear());

test('tabla de clasificación', () => {
  const casos = [
    // [stock, mínimo, esperado]
    [-1, 0, 'faltante'], [-10, 20, 'faltante'],
    [0, 0, 'sin_stock'], [0, 15, 'sin_stock'],
    [1, 0, 'ok'],                       // mínimo 0: nunca es stock bajo
    [1, 5, 'stock_bajo'], [5, 5, 'stock_bajo'],
    [6, 5, 'ok'], [100, 30, 'ok'],
  ];
  for (const [s, m, esperado] of casos) {
    assert.equal(clasificarStock(s, m), esperado, `stock ${s}, mínimo ${m}`);
  }
});

test('alertas: sin stock en talles habilitados y en stock general; no en talles no habilitados', () => {
  const p = h.crearInsumo({ nombre: 'Plantilla', tipo: 'plantilla', stock_minimo: 0, talles: ['38', '39'],
    stock: { 38: 0, 39: 3, 40: 0 } });
  const c = h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre', stock_minimo: 0, stock: { general: 0 } });
  const a = getAlertasStock();
  assert.deepEqual(a.map(x => [x.id, x.talle, x.tipo_alerta]).sort(),
    [[c, null, 'sin_stock'], [p, '38', 'sin_stock']].sort());
});

test('mínimo 0 con stock positivo no genera alerta (antes "0/0" figuraba como stock bajo)', () => {
  h.crearInsumo({ nombre: 'Hebilla', tipo: 'hebilla', stock_minimo: 0, stock: { general: 2 } });
  assert.equal(getAlertasStock().length, 0);
});

test('orden de gravedad: faltante, sin stock, stock bajo', () => {
  h.crearInsumo({ nombre: 'A', tipo: 'hebilla', stock_minimo: 5, stock: { general: 3 } });
  h.crearInsumo({ nombre: 'B', tipo: 'hebilla', stock_minimo: 5, stock: { general: 0 } });
  h.crearInsumo({ nombre: 'C', tipo: 'hebilla', stock_minimo: 5, stock: { general: -1 } });
  assert.deepEqual(getAlertasStock().map(x => x.tipo_alerta), ['faltante', 'sin_stock', 'stock_bajo']);
});

test('dashboard y lista de insumos usan la misma clasificación', async () => {
  const { req } = await srv;
  const sin = h.crearInsumo({ nombre: 'Sin', tipo: 'fondo', stock_minimo: 10, talles: ['38', '39'], stock: { 38: 0, 39: 4 } });
  const bajo = h.crearInsumo({ nombre: 'Bajo', tipo: 'cierre', stock_minimo: 10, stock: { general: 4 } });
  const ok = h.crearInsumo({ nombre: 'Ok', tipo: 'cierre', stock_minimo: 0, stock: { general: 1 } });
  const d = (await req('GET', '/api/dashboard')).data;
  assert.deepEqual([d.faltantes.length, d.sin_stock.length, d.stock_bajo.length], [0, 1, 2]);
  const lista = (await req('GET', '/api/insumos')).data;
  const est = id => lista.find(i => i.id === id).estado_stock;
  assert.equal(est(sin), 'sin_stock', 'el peor estado del insumo manda');
  assert.equal(est(bajo), 'stock_bajo');
  assert.equal(est(ok), 'ok');
});
