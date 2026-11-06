'use strict';
// Planillas de Corte: confirmación única, stock negativo permitido,
// protección de planillas confirmadas y cancelación con devolución.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
before(() => srv);
after(() => h.cerrar());

let e;
beforeEach(async () => { e = await h.escenarioBase({ stockPlantilla: 10, stockFondo: 10, stockCierre: 50 }); });

const stockDe = async (id, talle) => (await h.filasStock(id)).find(r => r.talle === (talle == null ? null : String(talle))).stock;
const api = async (method, url, body) => (await srv).req(method, url, body);

/** Crea una planilla con N pares del talle 38 del producto de prueba. */
async function planillaCon(pares) {
  const { data: { id } } = await api('POST', '/api/ordenes', { descripcion: 'Prueba' });
  const r = await api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas: [{ talle: '38', cantidad: pares }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return id;
}

test('confirmar descuenta plantilla, fondo y accesorios una sola vez', async () => {
  const id = await planillaCon(4);
  assert.equal((await api('POST', `/api/ordenes/${id}/confirmar`)).status, 200);
  assert.equal(await stockDe(e.plantilla, 38), 6);
  assert.equal(await stockDe(e.fondo, 38), 6);
  assert.equal(await stockDe(e.cierre, null), 42, '2 cierres por par');
  const r2 = await api('POST', `/api/ordenes/${id}/confirmar`);
  assert.equal(r2.status, 409, 'reconfirmar se rechaza');
  assert.equal(await stockDe(e.plantilla, 38), 6, 'sin consumo duplicado');
  assert.equal((await h.movimientos("referencia_tipo='orden'")).length, 3);
});

test('confirmaciones simultáneas solo consumen una vez', async () => {
  const id = await planillaCon(2);
  const res = await Promise.all([api('POST', `/api/ordenes/${id}/confirmar`), api('POST', `/api/ordenes/${id}/confirmar`)]);
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409]);
  assert.equal(await stockDe(e.plantilla, 38), 8);
});

test('stock negativo: se confirma aunque falte stock y la verificación lo informa', async () => {
  const id = await planillaCon(15);
  const ver = (await api('GET', `/api/ordenes/${id}/verificar`)).data;
  assert.ok(ver[0].insumos.some(i => i.faltante > 0));
  assert.equal((await api('POST', `/api/ordenes/${id}/confirmar`)).status, 200);
  assert.equal(await stockDe(e.plantilla, 38), -5);
  assert.equal(await stockDe(e.fondo, 38), -5);
  assert.equal(await stockDe(e.cierre, null), 20);
});

test('una planilla confirmada no admite agregar, editar ni eliminar líneas', async () => {
  const id = await planillaCon(2);
  const { detalles } = (await api('GET', `/api/ordenes/${id}`)).data;
  await api('POST', `/api/ordenes/${id}/confirmar`);
  assert.equal((await api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas: [{ talle: '38', cantidad: 1 }] })).status, 409);
  assert.equal((await api('POST', `/api/ordenes/${id}/detalle`, { producto_id: e.producto, talle: '38', cantidad: 1 })).status, 409);
  assert.equal((await api('PUT', `/api/ordenes/detalle/${detalles[0].id}`, { cantidad: 99 })).status, 409);
  assert.equal((await api('DELETE', `/api/ordenes/detalle/${detalles[0].id}`)).status, 409);
  const despues = (await api('GET', `/api/ordenes/${id}`)).data.detalles;
  assert.deepEqual(despues.map(d => d.cantidad), [2]);
});

test('validaciones de líneas en borrador', async () => {
  const { data: { id } } = await api('POST', '/api/ordenes', {});
  const bulk = lineas => api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas });
  assert.equal((await bulk([{ talle: '45', cantidad: 1 }])).status, 400, 'talle no habilitado en el producto');
  assert.equal((await bulk([{ talle: '38', cantidad: 1.5 }])).status, 400);
  assert.equal((await bulk([{ talle: '38', cantidad: 1 }])).status, 200);
  const det = (await api('GET', `/api/ordenes/${id}`)).data.detalles[0];
  assert.equal((await api('PUT', `/api/ordenes/detalle/${det.id}`, { cantidad: -3 })).status, 400);
  assert.equal((await api('PUT', `/api/ordenes/detalle/${det.id}`, { cantidad: 3 })).status, 200);
  assert.equal((await api('PUT', '/api/ordenes/detalle/999999', { cantidad: 3 })).status, 404);
});

test('no se confirma una planilla vacía', async () => {
  const { data: { id } } = await api('POST', '/api/ordenes', {});
  const r = await api('POST', `/api/ordenes/${id}/confirmar`);
  assert.equal(r.status, 400);
  assert.equal((await api('GET', `/api/ordenes/${id}`)).data.estado, 'borrador');
});

test('cancelar una planilla en borrador no genera movimientos', async () => {
  const id = await planillaCon(3);
  const r = await api('POST', `/api/ordenes/${id}/cancelar`);
  assert.equal(r.status, 200);
  assert.equal(r.data.revertido, false);
  assert.equal((await h.movimientos()).length, 0);
  assert.equal(await stockDe(e.plantilla, 38), 10);
});

test('cancelar una planilla confirmada devuelve exactamente lo consumido, con trazabilidad', async () => {
  const id = await planillaCon(15); // deja stock negativo
  await api('POST', `/api/ordenes/${id}/confirmar`);
  // Cambiar la receta después de confirmar no debe alterar la devolución
  await h.ejecutar('UPDATE producto_accesorios SET cantidad_por_par = 9 WHERE producto_id = ?', [e.producto]);
  const r = await api('POST', `/api/ordenes/${id}/cancelar`);
  assert.equal(r.status, 200);
  assert.equal(r.data.revertido, true);
  assert.equal(await stockDe(e.plantilla, 38), 10);
  assert.equal(await stockDe(e.fondo, 38), 10);
  assert.equal(await stockDe(e.cierre, null), 50);
  const devol = await h.movimientos("referencia_tipo='anulacion_orden' AND referencia_id=?", [id]);
  assert.equal(devol.length, 3);
  assert.ok(devol.every(m => m.tipo === 'ingreso' && m.cantidad > 0));
  assert.equal((await h.movimientos("referencia_tipo='orden'")).length, 3, 'los consumos originales se conservan');
  assert.equal((await api('GET', `/api/ordenes/${id}`)).data.estado, 'cancelada');
});

test('una planilla cancelada no se vuelve a cancelar ni a confirmar', async () => {
  const id = await planillaCon(2);
  await api('POST', `/api/ordenes/${id}/confirmar`);
  await api('POST', `/api/ordenes/${id}/cancelar`);
  assert.equal((await api('POST', `/api/ordenes/${id}/cancelar`)).status, 409);
  assert.equal((await api('POST', `/api/ordenes/${id}/confirmar`)).status, 409);
  assert.equal(await stockDe(e.plantilla, 38), 10, 'sin devoluciones duplicadas');
  assert.equal((await h.movimientos("referencia_tipo='anulacion_orden'")).length, 3);
});

test('planillas inexistentes responden 404', async () => {
  assert.equal((await api('POST', '/api/ordenes/999999/confirmar')).status, 404);
  assert.equal((await api('POST', '/api/ordenes/999999/cancelar')).status, 404);
  assert.equal((await api('GET', '/api/ordenes/999999')).status, 404);
});

test('agregar líneas en paralelo a la misma planilla asigna números de pedido distintos', async () => {
  const { data: { id } } = await api('POST', '/api/ordenes', {});
  const res = await Promise.all([1, 2, 3].map(() =>
    api('POST', `/api/ordenes/${id}/detalles-bulk`, { producto_id: e.producto, lineas: [{ talle: '38', cantidad: 1 }] })));
  assert.ok(res.every(r => r.status === 200));
  const nums = (await api('GET', `/api/ordenes/${id}`)).data.detalles.map(d => d.numero_pedido).sort();
  assert.deepEqual(nums, [1, 2, 3]);
});

test('el PDF de una planilla se genera y una inexistente responde 404', async () => {
  const id = await planillaCon(3);
  const { base: url } = await srv;
  const r = await fetch(`${url}/api/ordenes/${id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok((await r.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(`${url}/api/ordenes/999999/pdf`)).status, 404);
});

test('listado y verificación de planillas', async () => {
  const id = await planillaCon(4);
  const lista = (await api('GET', '/api/ordenes')).data;
  const o = lista.find(x => x.id === id);
  assert.deepEqual([o.lineas, o.total_pares, o.estado], [1, 4, 'borrador']);
  const ver = (await api('GET', `/api/ordenes/${id}/verificar`)).data;
  assert.deepEqual(ver[0].insumos.map(i => [i.tipo, i.necesario, i.faltante]),
    [['plantilla', 4, 0], ['fondo', 4, 0], ['cierre', 8, 0]]);
});
