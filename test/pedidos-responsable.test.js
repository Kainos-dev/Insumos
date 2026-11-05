'use strict';
// Reglas definitivas de pedidos y responsables:
// · todo pedido nuevo tiene responsable obligatorio y solo insumos suyos;
// · no se aceptan insumos sin asignar ni mezclas;
// · los pedidos históricos sin responsable se conservan intactos;
// · se bloquean las reasignaciones incompatibles con pedidos abiertos.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const { huellaInventario } = require('../db/huella');
after(async () => { await (await srv).cerrar(); base.cerrar(); });

let e;
beforeEach(() => { e = h.escenarioBase(); });
const api = async (m, u, b) => (await srv).req(m, u, b);
const L = (insumo_id, talle = null, cantidad = 2) => ({ insumo_id, talle, cantidad });
const crear = (lineas, slug) => api('POST', '/api/pedidos',
  { proveedor_id: e.prov, lineas, ...(slug === undefined ? {} : { responsable_id: slug && h.responsableId(slug) }) });
const contarPedidos = () => h.db().prepare('SELECT COUNT(*) n FROM pedidos_proveedor').get().n;
const asignar = (insumo, slug) => api('PUT', `/api/insumos/${insumo}/responsable`, { responsable_id: slug && h.responsableId(slug) });
const estado = (id, est) => api('PUT', `/api/pedidos/${id}/estado`, { estado: est });

/** Simula un pedido histórico (anterior a E4): sin responsable, insertado directamente. */
function pedidoHistorico(lineas, est = 'borrador') {
  const id = Number(h.db().prepare('INSERT INTO pedidos_proveedor (proveedor_id, estado) VALUES (?, ?)').run(e.prov, est).lastInsertRowid);
  for (const l of lineas) {
    h.db().prepare('INSERT INTO detalle_pedido_proveedor (pedido_id, insumo_id, talle, cantidad) VALUES (?,?,?,?)')
      .run(id, l.insumo_id, l.talle, l.cantidad);
  }
  return id;
}

// ——— Pedidos nuevos ———

test('pedido nuevo con insumos del responsable elegido: queda asignado a ese responsable', async () => {
  h.asignarDirecto(e.plantilla, 'ruben');
  h.asignarDirecto(e.fondo, 'ruben');
  const r = await crear([L(e.plantilla, '38'), L(e.fondo, '39')], 'ruben');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = (await api('GET', `/api/pedidos/${r.data.id}`)).data;
  assert.deepEqual([p.responsable_slug, p.responsable_nombre], ['ruben', 'Rubén']);
  const panel = (await api('GET', '/api/responsables/ruben/panel')).data;
  assert.deepEqual(panel.pedidos.map(x => x.id), [r.data.id]);
  assert.equal(panel.resumen.pedidos_pendientes, 1);
  assert.equal((await api('GET', '/api/responsables/dani/panel')).data.pedidos.length, 0);
});

test('el responsable es obligatorio', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  assert.equal((await crear([L(e.cierre)])).status, 400);
  assert.equal((await crear([L(e.cierre)], null)).status, 400);
  assert.equal(contarPedidos(), 0);
});

test('no se pueden pedir insumos sin responsable asignado', async () => {
  const solo = await crear([L(e.cierre)], 'ruben');
  assert.equal(solo.status, 400);
  assert.match(solo.data.error, /no tienen responsable asignado: Cierre G/);
  h.asignarDirecto(e.plantilla, 'jorge');
  const mezcla = await crear([L(e.plantilla, '38'), L(e.cierre)], 'jorge');
  assert.equal(mezcla.status, 400);
  assert.match(mezcla.data.error, /no tienen responsable/);
  assert.equal(contarPedidos(), 0);
});

test('mezclar insumos de distintos responsables se rechaza en el servidor', async () => {
  h.asignarDirecto(e.plantilla, 'ruben');
  h.asignarDirecto(e.cierre, 'dani');
  const r = await crear([L(e.plantilla, '38'), L(e.cierre)], 'ruben');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /mismo responsable.*Rubén.*Dani/);
  assert.equal(contarPedidos(), 0);
});

test('el responsable elegido debe coincidir con el de los insumos', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  const mal = await crear([L(e.cierre)], 'ruben');
  assert.equal(mal.status, 400);
  assert.match(mal.data.error, /no corresponden al responsable elegido/);
  assert.equal((await crear([L(e.cierre)], 'dani')).status, 200);
  assert.equal(contarPedidos(), 1);
});

test('el responsable de un pedido no se puede modificar (regla en la base)', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  const id = (await crear([L(e.cierre)], 'dani')).data.id;
  assert.throws(() => h.db().prepare('UPDATE pedido_responsable SET responsable_id = ? WHERE pedido_id = ?')
    .run(h.responsableId('ruben'), id), /PEDIDO_RESPONSABLE_INMUTABLE/);
});

// ——— Pedidos históricos ———

test('los pedidos históricos sin responsable se conservan y siguen consultables y operables', async () => {
  const id = pedidoHistorico([L(e.cierre, null, 4)], 'enviado');
  const antes = h.db().prepare('SELECT * FROM pedidos_proveedor WHERE id = ?').get(id);
  const p = (await api('GET', `/api/pedidos/${id}`)).data;
  assert.equal(p.responsable_id, null);
  assert.equal(p.detalles.length, 1);
  assert.ok((await api('GET', '/api/pedidos')).data.some(x => x.id === id));
  assert.deepEqual(h.db().prepare('SELECT * FROM pedidos_proveedor WHERE id = ?').get(id), antes);
  assert.equal((await estado(id, 'recibido')).status, 200, 'un histórico enviado puede recibirse');
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM pedido_responsable').get().n, 0, 'nunca se asigna automáticamente');
});

test('diagnóstico: identifica históricos que mezclan responsables, sin modificarlos', async () => {
  const hist = pedidoHistorico([L(e.plantilla, '38'), L(e.cierre)]);
  const antes = huellaInventario(h.db());
  await asignar(e.plantilla, 'ruben');
  await asignar(e.cierre, 'dani');
  const d = (await api('GET', '/api/responsables/diagnostico-pedidos')).data;
  assert.deepEqual(d.mezcla.map(x => x.id), [hist]);
  assert.deepEqual(d.mezcla[0].responsables.sort(), ['Dani', 'Rubén']);
  assert.equal(d.sin_responsable, 1);
  assert.deepEqual(huellaInventario(h.db()), antes);
});

test('los insumos de pedidos históricos abiertos sin responsable se pueden asignar libremente', async () => {
  pedidoHistorico([L(e.cierre)], 'borrador');
  assert.equal((await asignar(e.cierre, 'ruben')).status, 200);
  assert.equal((await asignar(e.cierre, 'jorge')).status, 200);
  assert.equal((await asignar(e.cierre, null)).status, 200);
});

// ——— Reasignación ———

test('se bloquea reasignar o quitar el responsable si hay pedidos abiertos de ese responsable', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  const id = (await crear([L(e.cierre)], 'dani')).data.id;
  const antes = huellaInventario(h.db());
  const r = await asignar(e.cierre, 'jorge');
  assert.equal(r.status, 409);
  assert.match(r.data.error, new RegExp(`Cierre G.*#${id} de Dani \\(borrador\\)`));
  assert.equal((await asignar(e.cierre, null)).status, 409, 'quitar también se bloquea');
  const bloque = await api('PUT', '/api/responsables/asignaciones', { asignaciones: [
    { insumo_id: e.plantilla, responsable_id: h.responsableId('jorge') },
    { insumo_id: e.cierre, responsable_id: h.responsableId('jorge') },
  ] });
  assert.equal(bloque.status, 409, 'en bloque: todo o nada');
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM insumo_responsable WHERE insumo_id = ?').get(e.plantilla).n, 0);
  assert.equal((await api('GET', `/api/insumos/${e.cierre}`)).data.responsable.slug, 'dani');
  assert.deepEqual(huellaInventario(h.db()), antes, 'sin cambios de stock ni movimientos');

  await estado(id, 'enviado');
  assert.equal((await asignar(e.cierre, 'jorge')).status, 409, 'enviado sigue abierto');
  await estado(id, 'recibido');
  assert.equal((await asignar(e.cierre, 'jorge')).status, 200, 'pedido cerrado: ya no bloquea');
});

test('una cancelación también libera la reasignación', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  const id = (await crear([L(e.cierre)], 'dani')).data.id;
  await estado(id, 'cancelado');
  assert.equal((await asignar(e.cierre, 'ruben')).status, 200);
});

test('no se bloquean cambios que no generan incompatibilidades', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  h.asignarDirecto(e.plantilla, 'dani');
  await crear([L(e.cierre)], 'dani');
  assert.equal((await asignar(e.plantilla, 'jorge')).status, 200, 'la plantilla no está en el pedido');
  assert.equal((await asignar(e.cierre, 'dani')).status, 200, 'mismo responsable: sin cambios');
  assert.equal((await asignar(e.fondo, 'ruben')).status, 200, 'insumo sin pedidos');
});

test('la base también bloquea la reasignación aunque se saltee el servidor', async () => {
  h.asignarDirecto(e.cierre, 'dani');
  await crear([L(e.cierre)], 'dani');
  assert.throws(() => h.db().prepare('UPDATE insumo_responsable SET responsable_id = ? WHERE insumo_id = ?')
    .run(h.responsableId('ruben'), e.cierre), /REASIGNACION_CON_PEDIDOS_ABIERTOS/);
  assert.throws(() => h.db().prepare('DELETE FROM insumo_responsable WHERE insumo_id = ?').run(e.cierre),
    /REASIGNACION_CON_PEDIDOS_ABIERTOS/);
});

test('flujo de estados y recepción única con responsables', async () => {
  h.asignarDirecto(e.cierre, 'ruben');
  const id = (await crear([L(e.cierre, null, 5)], 'ruben')).data.id;
  assert.equal((await estado(id, 'recibido')).status, 409, 'sin pasar por enviado');
  assert.equal((await estado(id, 'enviado')).status, 200);
  assert.equal((await estado(id, 'recibido')).status, 200);
  assert.equal((await estado(id, 'recibido')).status, 409);
  assert.equal(h.filasStock(e.cierre)[0].stock, 55);
});
