'use strict';
// Pedidos a proveedores: transiciones de estado y recepción única.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const svc = require('../services/pedidosService');
after(async () => { await (await srv).cerrar(); base.cerrar(); });

let e;
beforeEach(() => { e = h.escenarioBase({ stockPlantilla: 10, stockCierre: 50 }); });

const stockDe = (id, talle) => h.filasStock(id).find(r => r.talle === (talle == null ? null : String(talle))).stock;
const nuevoPedido = () => svc.crearPedido(e.prov, [
  { insumo_id: e.plantilla, talle: '38', cantidad: 7 },
  { insumo_id: e.cierre, talle: null, cantidad: 20 },
]);
const estado = async (id, est) => (await srv).req('PUT', `/api/pedidos/${id}/estado`, { estado: est });

test('flujo normal: borrador → enviado → recibido suma el stock una vez', async () => {
  const id = nuevoPedido();
  assert.equal((await estado(id, 'enviado')).status, 200);
  assert.equal((await estado(id, 'recibido')).status, 200);
  assert.equal(stockDe(e.plantilla, 38), 17);
  assert.equal(stockDe(e.cierre, null), 70);
  const movs = h.movimientos("referencia_tipo = 'pedido' AND referencia_id = ?", [id]);
  assert.equal(movs.length, 2);
  assert.ok(movs.every(m => m.tipo === 'ingreso_pedido'));
});

test('un pedido recibido no puede volver a borrador ni recibirse otra vez', async () => {
  const id = nuevoPedido();
  await estado(id, 'enviado');
  await estado(id, 'recibido');
  for (const est of ['borrador', 'enviado', 'recibido', 'cancelado']) {
    const r = await estado(id, est);
    assert.equal(r.status, 409, `recibido → ${est} debe rechazarse`);
  }
  assert.equal(stockDe(e.plantilla, 38), 17, 'el stock se sumó una sola vez');
  assert.equal(h.movimientos("referencia_tipo = 'pedido'").length, 2);
});

test('un pedido cancelado no puede reactivarse ni recibirse', async () => {
  const id = nuevoPedido();
  assert.equal((await estado(id, 'cancelado')).status, 200);
  for (const est of ['borrador', 'enviado', 'recibido']) {
    assert.equal((await estado(id, est)).status, 409);
  }
  assert.equal(stockDe(e.plantilla, 38), 10);
  assert.equal(h.movimientos().length, 0);
});

test('no se puede recibir un pedido que no fue enviado', async () => {
  const id = nuevoPedido();
  const r = await estado(id, 'recibido');
  assert.equal(r.status, 409);
  assert.equal(stockDe(e.plantilla, 38), 10);
});

test('dos recepciones simultáneas solo contabilizan una', async () => {
  const id = nuevoPedido();
  await estado(id, 'enviado');
  const [a, b] = await Promise.all([estado(id, 'recibido'), estado(id, 'recibido')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(stockDe(e.plantilla, 38), 17);
});

test('si la recepción falla a mitad de camino no queda nada aplicado (transacción)', () => {
  const id = nuevoPedido();
  svc.actualizarEstado(id, 'enviado');
  // Simula un ingreso previo inconsistente para forzar el rechazo dentro de la transacción
  h.db().prepare(`INSERT INTO movimientos_stock (insumo_id, talle, tipo, cantidad, referencia_tipo, referencia_id)
                  VALUES (?, '38', 'ingreso_pedido', 1, 'pedido', ?)`).run(e.plantilla, id);
  assert.throws(() => svc.actualizarEstado(id, 'recibido'), /ya registró ingresos/);
  const p = h.db().prepare('SELECT estado FROM pedidos_proveedor WHERE id=?').get(id);
  assert.equal(p.estado, 'enviado', 'el estado no cambió');
  assert.equal(stockDe(e.plantilla, 38), 10, 'el stock no cambió');
});

test('estados y pedidos inválidos', async () => {
  const id = nuevoPedido();
  assert.equal((await estado(id, 'perdido')).status, 400);
  assert.equal((await estado(999999, 'enviado')).status, 404);
  const { req } = await srv;
  assert.equal((await req('POST', '/api/pedidos', { proveedor_id: e.prov, lineas: [{ insumo_id: e.cierre, cantidad: 0 }] })).status, 400);
  assert.equal((await req('POST', '/api/pedidos', { proveedor_id: 999999, lineas: [{ insumo_id: e.cierre, cantidad: 1 }] })).status, 400);
});
