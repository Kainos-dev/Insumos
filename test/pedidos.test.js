'use strict';
// Pedidos a proveedores: transiciones de estado y recepción única.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
const svc = require('../services/pedidosService');
before(() => srv);
after(() => h.cerrar());

let e;
beforeEach(async () => {
  e = await h.escenarioBase({ stockPlantilla: 10, stockCierre: 50 });
  // Regla vigente: todo pedido nuevo exige insumos asignados a un mismo responsable
  await h.asignarDirecto(e.plantilla, 'ruben');
  await h.asignarDirecto(e.cierre, 'ruben');
});

const stockDe = async (id, talle) =>
  (await h.filasStock(id)).find(r => r.talle === (talle == null ? null : String(talle))).stock;
const nuevoPedido = async () => svc.crearPedido(e.prov, [
  { insumo_id: e.plantilla, talle: '38', cantidad: 7 },
  { insumo_id: e.cierre, talle: null, cantidad: 20 },
], await h.responsableId('ruben'));
const estado = async (id, est) => (await srv).req('PUT', `/api/pedidos/${id}/estado`, { estado: est });

test('flujo normal: borrador → enviado → recibido suma el stock una vez', async () => {
  const id = await nuevoPedido();
  assert.equal((await estado(id, 'enviado')).status, 200);
  assert.equal((await estado(id, 'recibido')).status, 200);
  assert.equal(await stockDe(e.plantilla, 38), 17);
  assert.equal(await stockDe(e.cierre, null), 70);
  const movs = await h.movimientos("referencia_tipo = 'pedido' AND referencia_id = ?", [id]);
  assert.equal(movs.length, 2);
  assert.ok(movs.every(m => m.tipo === 'ingreso_pedido'));
  const p = await h.uno('SELECT recibido_at FROM pedidos_proveedor WHERE id = ?', [id]);
  assert.ok(p.recibido_at instanceof Date, 'queda registrada la fecha de recepción');
});

test('el mensaje de WhatsApp detalla cada insumo y talle', async () => {
  const id = await nuevoPedido();
  const { mensaje_whatsapp } = await h.uno('SELECT mensaje_whatsapp FROM pedidos_proveedor WHERE id = ?', [id]);
  assert.match(mensaje_whatsapp, /^Hola Proveedor A/);
  assert.match(mensaje_whatsapp, /• Cierre G: 20 unidades/);
  assert.match(mensaje_whatsapp, /• Plantilla T \(talle 38\): 7 unidades/);
});

test('un pedido recibido no puede volver a borrador ni recibirse otra vez', async () => {
  const id = await nuevoPedido();
  await estado(id, 'enviado');
  await estado(id, 'recibido');
  for (const est of ['borrador', 'enviado', 'recibido', 'cancelado']) {
    const r = await estado(id, est);
    assert.equal(r.status, 409, `recibido → ${est} debe rechazarse`);
  }
  assert.equal(await stockDe(e.plantilla, 38), 17, 'el stock se sumó una sola vez');
  assert.equal((await h.movimientos("referencia_tipo = 'pedido'")).length, 2);
});

test('un pedido cancelado no puede reactivarse ni recibirse', async () => {
  const id = await nuevoPedido();
  assert.equal((await estado(id, 'cancelado')).status, 200);
  for (const est of ['borrador', 'enviado', 'recibido']) {
    assert.equal((await estado(id, est)).status, 409);
  }
  assert.equal(await stockDe(e.plantilla, 38), 10);
  assert.equal((await h.movimientos()).length, 0);
});

test('no se puede recibir un pedido que no fue enviado', async () => {
  const id = await nuevoPedido();
  const r = await estado(id, 'recibido');
  assert.equal(r.status, 409);
  assert.equal(await stockDe(e.plantilla, 38), 10);
});

test('dos recepciones simultáneas solo contabilizan una', async () => {
  const id = await nuevoPedido();
  await estado(id, 'enviado');
  const [a, b] = await Promise.all([estado(id, 'recibido'), estado(id, 'recibido')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(await stockDe(e.plantilla, 38), 17);
});

test('si la recepción falla a mitad de camino no queda nada aplicado (transacción)', async () => {
  const id = await nuevoPedido();
  await svc.actualizarEstado(id, 'enviado');
  // Simula un ingreso previo inconsistente para forzar el rechazo dentro de la transacción
  await h.ejecutar(`INSERT INTO movimientos_stock (insumo_id, talle, tipo, cantidad, referencia_tipo, referencia_id)
                    VALUES (?, '38', 'ingreso_pedido', 1, 'pedido', ?)`, [e.plantilla, id]);
  await assert.rejects(() => svc.actualizarEstado(id, 'recibido'), /ya registró ingresos/);
  const p = await h.uno('SELECT estado FROM pedidos_proveedor WHERE id=?', [id]);
  assert.equal(p.estado, 'enviado', 'el estado no cambió');
  assert.equal(await stockDe(e.plantilla, 38), 10, 'el stock no cambió');
});

test('estados y pedidos inválidos', async () => {
  const id = await nuevoPedido();
  assert.equal((await estado(id, 'perdido')).status, 400);
  assert.equal((await estado(999999, 'enviado')).status, 404);
  const { req } = await srv;
  const rid = await h.responsableId('ruben');
  assert.equal((await req('POST', '/api/pedidos', { proveedor_id: e.prov, responsable_id: rid, lineas: [{ insumo_id: e.cierre, cantidad: 0 }] })).status, 400);
  assert.equal((await req('POST', '/api/pedidos', { proveedor_id: 999999, responsable_id: rid, lineas: [{ insumo_id: e.cierre, cantidad: 1 }] })).status, 400);
  assert.equal((await req('POST', '/api/pedidos', { proveedor_id: e.prov, responsable_id: rid, lineas: [{ insumo_id: 'x', cantidad: 1 }] })).status, 400);
});

test('listado y detalle de pedidos incluyen totales y responsable', async () => {
  const id = await nuevoPedido();
  const { req } = await srv;
  const lista = (await req('GET', '/api/pedidos')).data;
  const p = lista.find(x => x.id === id);
  assert.deepEqual([p.lineas, p.total_unidades, p.proveedor_nombre, p.responsable_slug], [2, 27, 'Proveedor A', 'ruben']);
  const det = (await req('GET', `/api/pedidos/${id}`)).data;
  assert.equal(det.detalles.length, 2);
});
