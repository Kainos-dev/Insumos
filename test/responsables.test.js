'use strict';
// Responsables: asignación (máximo uno por insumo), paneles individuales
// y garantía de que asignar no modifica el inventario.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const srv = h.iniciar();
before(() => srv);
after(() => h.cerrar());

let e;
beforeEach(async () => { e = await h.escenarioBase({ stockPlantilla: 10, stockFondo: 0, stockCierre: -3 }); });
const api = async (m, u, b) => (await srv).req(m, u, b);
const asignar = async (insumo, slug) => api('PUT', `/api/insumos/${insumo}/responsable`,
  { responsable_id: slug === null ? null : await h.responsableId(slug) });
const filasAsignacion = () => h.q('SELECT * FROM insumo_responsable ORDER BY insumo_id');

test('el módulo de responsables está disponible y sin migraciones pendientes', async () => {
  const est = (await api('GET', '/api/responsables/estado')).data;
  assert.deepEqual(est, { disponible: true, migraciones_pendientes: [] });
  assert.deepEqual(await h.q('SELECT slug, nombre, activo FROM responsables ORDER BY id'),
    [{ slug: 'ruben', nombre: 'Rubén', activo: 1 }, { slug: 'dani', nombre: 'Dani', activo: 1 }, { slug: 'jorge', nombre: 'Jorge', activo: 1 }]);
});

test('los insumos comienzan sin responsable y aparecen como sin asignar en Fábrica', async () => {
  const ins = (await api('GET', '/api/insumos')).data;
  assert.ok(ins.every(i => i.responsable === null));
  const d = (await api('GET', '/api/dashboard')).data;
  assert.equal(d.responsables.disponible, true);
  assert.equal(d.responsables.sin_asignar.length, 3);
  assert.deepEqual(d.responsables.lista.map(r => [r.slug, r.insumos_asignados]), [['ruben', 0], ['dani', 0], ['jorge', 0]]);
});

test('asignar, cambiar y quitar: como máximo un responsable por insumo', async () => {
  assert.equal((await asignar(e.plantilla, 'ruben')).status, 200);
  assert.deepEqual((await filasAsignacion()).map(f => f.responsable_id), [await h.responsableId('ruben')]);
  assert.equal((await asignar(e.plantilla, 'dani')).status, 200);
  assert.equal((await filasAsignacion()).length, 1, 'cambiar reemplaza, no agrega');
  assert.equal((await filasAsignacion())[0].responsable_id, await h.responsableId('dani'));
  const ins = (await api('GET', `/api/insumos/${e.plantilla}`)).data;
  assert.deepEqual([ins.responsable.slug, ins.responsable.nombre], ['dani', 'Dani']);
  assert.equal((await asignar(e.plantilla, null)).status, 200);
  assert.equal((await filasAsignacion()).length, 0);
  await assert.rejects(() => h.ejecutar('INSERT INTO insumo_responsable (insumo_id, responsable_id) VALUES (?, ?), (?, ?)',
    [e.cierre, 1, e.cierre, 3]), /duplicate key|unique/i);
});

test('asignar no modifica stock, movimientos ni historiales', async () => {
  const antes = await h.huella();
  await asignar(e.plantilla, 'ruben');
  await asignar(e.fondo, 'jorge');
  await asignar(e.cierre, 'dani');
  await asignar(e.cierre, 'ruben');
  await asignar(e.fondo, null);
  await api('PUT', '/api/responsables/asignaciones', { asignaciones: [{ insumo_id: e.fondo, responsable_id: await h.responsableId('dani') }] });
  assert.deepEqual(await h.huella(), antes);
});

test('validaciones: responsable inexistente o inactivo, insumo inexistente', async () => {
  assert.equal((await api('PUT', `/api/insumos/${e.plantilla}/responsable`, { responsable_id: 999 })).status, 400);
  await h.ejecutar("UPDATE responsables SET activo = 0 WHERE slug = 'jorge'");
  const r = await asignar(e.plantilla, 'jorge');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no está activo/);
  assert.equal((await asignar(999999, 'ruben')).status, 404);
  assert.equal((await filasAsignacion()).length, 0);
});

test('asignación en bloque: si una falla no se aplica ninguna', async () => {
  const rid = await h.responsableId('ruben');
  const r = await api('PUT', '/api/responsables/asignaciones', { asignaciones: [
    { insumo_id: e.plantilla, responsable_id: rid },
    { insumo_id: 999999, responsable_id: rid },
  ] });
  assert.equal(r.status, 404);
  assert.equal((await filasAsignacion()).length, 0);
  const ok = await api('PUT', '/api/responsables/asignaciones', { asignaciones: [
    { insumo_id: e.plantilla, responsable_id: rid },
    { insumo_id: e.fondo, responsable_id: rid },
  ] });
  assert.equal(ok.status, 200);
  assert.equal((await filasAsignacion()).length, 2);
});

test('cada panel muestra solo los insumos y alertas de su responsable', async () => {
  await asignar(e.plantilla, 'ruben');   // OK (10 / mínimo 3)
  await asignar(e.fondo, 'ruben');       // sin stock en 38 y 39
  await asignar(e.cierre, 'dani');       // faltante (-3)
  const ruben = (await api('GET', '/api/responsables/ruben/panel')).data;
  assert.deepEqual(ruben.insumos.map(i => i.id).sort(), [e.plantilla, e.fondo].sort());
  assert.ok(ruben.alertas.every(a => a.id === e.fondo));
  assert.deepEqual([ruben.resumen.insumos_asignados, ruben.resumen.faltantes, ruben.resumen.sin_stock], [2, 0, 2]);
  const dani = (await api('GET', '/api/responsables/dani/panel')).data;
  assert.deepEqual(dani.insumos.map(i => i.id), [e.cierre]);
  assert.equal(dani.resumen.faltantes, 1);
  const jorge = (await api('GET', '/api/responsables/jorge/panel')).data;
  assert.deepEqual([jorge.insumos.length, jorge.alertas.length], [0, 0]);
  assert.equal((await api('GET', '/api/responsables/nadie/panel')).status, 404);
  const lista = (await api('GET', '/api/responsables')).data;
  assert.deepEqual(lista.responsables.map(r => [r.slug, r.insumos_asignados, r.faltantes, r.sin_stock]),
    [['ruben', 2, 0, 2], ['dani', 1, 1, 0], ['jorge', 0, 0, 0]]);
  assert.equal(lista.sin_asignar.length, 0);
});

test('eliminar un insumo sin historial elimina también su asignación', async () => {
  const id = await h.crearInsumo({ nombre: 'Temporal', tipo: 'hebilla' });
  await asignar(id, 'jorge');
  assert.equal((await api('DELETE', `/api/insumos/${id}`)).status, 200);
  assert.equal((await filasAsignacion()).filter(f => f.insumo_id === id).length, 0);
});
