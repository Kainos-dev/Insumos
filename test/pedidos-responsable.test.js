'use strict';
// Pedidos y responsables: un pedido corresponde a un solo responsable,
// validado en el servidor; los históricos no se modifican.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
after(async () => { await (await srv).cerrar(); base.cerrar(); });

let e;
beforeEach(() => { e = h.escenarioBase(); });
const api = async (m, u, b) => (await srv).req(m, u, b);
const crear = (lineas, extra = {}) => api('POST', '/api/pedidos', { proveedor_id: e.prov, lineas, ...extra });
const L = (insumo_id, talle = null, cantidad = 2) => ({ insumo_id, talle, cantidad });
const contarPedidos = () => h.db().prepare('SELECT COUNT(*) n FROM pedidos_proveedor').get().n;

test('pedido con insumos de un mismo responsable queda asignado a ese responsable', async () => {
  h.asignarDirecto(e.plantilla, 'ruben');
  h.asignarDirecto(e.fondo, 'ruben');
  const r = await crear([L(e.plantilla, '38'), L(e.fondo, '39')]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = (await api('GET', `/api/pedidos/${r.data.id}`)).data;
  assert.deepEqual([p.responsable_slug, p.responsable_nombre], ['ruben', 'Rubén']);
  const panel = (await api('GET', '/api/responsables/ruben/panel')).data;
  assert.deepEqual(panel.pedidos.map(x => x.id), [r.data.id]);
  assert.equal(panel.resumen.pedidos_pendientes, 1);
  assert.equal((await api('GET', '/api/responsables/dani/panel')).data.pedidos.length, 0);
});

test('mezclar insumos de distintos responsables se rechaza en el servidor', async () => {
  h.asignarDirecto(e.plantilla, 'ruben');
  h.asignarDirecto(e.cierre, 'dani');
  const r = await crear([L(e.plantilla, '38'), L(e.cierre)]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /mismo responsable.*Rubén.*Dani/);
  assert.equal(contarPedidos(), 0, 'no se creó nada');
});

test('mezclar insumos asignados con insumos sin responsable se rechaza', async () => {
  h.asignarDirecto(e.plantilla, 'jorge');
  const r = await crear([L(e.plantilla, '38'), L(e.cierre)]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /sin responsable/);
  assert.equal(contarPedidos(), 0);
});

test('un pedido solo con insumos sin asignar queda sin responsable (transición)', async () => {
  const r = await crear([L(e.cierre), L(e.plantilla, '38')]);
  assert.equal(r.status, 200);
  assert.equal((await api('GET', `/api/pedidos/${r.data.id}`)).data.responsable_id, null);
});

test('el responsable elegido en pantalla debe coincidir con el de los insumos', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  const mal = await crear([L(e.cierre)], { responsable_id: h.responsableId('ruben') });
  assert.equal(mal.status, 400);
  const malNull = await crear([L(e.cierre)], { responsable_id: null });
  assert.equal(malNull.status, 400);
  const ok = await crear([L(e.cierre)], { responsable_id: h.responsableId('dani') });
  assert.equal(ok.status, 200);
  assert.equal(contarPedidos(), 1);
});

test('diagnóstico: identifica pedidos históricos incompatibles sin modificarlos', async () => {
  // Pedido creado antes de asignar responsables (como los históricos reales)
  const hist = (await crear([L(e.plantilla, '38'), L(e.cierre)])).data.id;
  const antes = h.db().prepare('SELECT * FROM pedidos_proveedor WHERE id = ?').get(hist);
  h.asignarDirecto(e.plantilla, 'ruben');
  h.asignarDirecto(e.cierre, 'dani');
  const d = (await api('GET', '/api/responsables/diagnostico-pedidos')).data;
  assert.deepEqual(d.mezcla.map(x => x.id), [hist]);
  assert.deepEqual(d.mezcla[0].responsables.sort(), ['Dani', 'Rubén']);
  assert.equal(d.sin_responsable, 1);
  assert.deepEqual(h.db().prepare('SELECT * FROM pedidos_proveedor WHERE id = ?').get(hist), antes);
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM pedido_responsable').get().n, 0, 'no se asignó automáticamente');
});

test('diagnóstico: detecta pedidos cuyo insumo fue reasignado después (sin cambiar el pedido)', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  const id = (await crear([L(e.cierre)])).data.id;
  h.asignarDirecto(e.cierre, 'jorge');
  const d = (await api('GET', '/api/responsables/diagnostico-pedidos')).data;
  assert.deepEqual(d.desalineado.map(x => [x.id, x.responsable_pedido]), [[id, 'Dani']]);
  assert.equal((await api('GET', `/api/pedidos/${id}`)).data.responsable_slug, 'dani', 'el pedido conserva su responsable');
});

test('el flujo de estados y la recepción única siguen funcionando con responsables', async () => {
  h.asignarDirecto(e.cierre, 'ruben');
  const id = (await crear([L(e.cierre, null, 5)])).data.id;
  assert.equal((await api('PUT', `/api/pedidos/${id}/estado`, { estado: 'recibido' })).status, 409, 'sin pasar por enviado');
  assert.equal((await api('PUT', `/api/pedidos/${id}/estado`, { estado: 'enviado' })).status, 200);
  assert.equal((await api('PUT', `/api/pedidos/${id}/estado`, { estado: 'recibido' })).status, 200);
  assert.equal((await api('PUT', `/api/pedidos/${id}/estado`, { estado: 'recibido' })).status, 409);
  assert.equal(h.filasStock(e.cierre)[0].stock, 55);
});
