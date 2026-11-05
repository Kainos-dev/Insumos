'use strict';
// Responsables: asignación (máximo uno por insumo), paneles individuales
// y garantía de que asignar no modifica el inventario.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const { huellaInventario } = require('../db/huella');
after(async () => { await (await srv).cerrar(); base.cerrar(); });

let e;
beforeEach(() => { e = h.escenarioBase({ stockPlantilla: 10, stockFondo: 0, stockCierre: -3 }); });
const api = async (m, u, b) => (await srv).req(m, u, b);
const asignar = (insumo, slug) => api('PUT', `/api/insumos/${insumo}/responsable`,
  { responsable_id: slug === null ? null : h.responsableId(slug) });
const filasAsignacion = () => h.db().prepare('SELECT * FROM insumo_responsable ORDER BY insumo_id').all();

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
  assert.deepEqual(filasAsignacion().map(f => f.responsable_id), [h.responsableId('ruben')]);
  assert.equal((await asignar(e.plantilla, 'dani')).status, 200);
  assert.equal(filasAsignacion().length, 1, 'cambiar reemplaza, no agrega');
  assert.equal(filasAsignacion()[0].responsable_id, h.responsableId('dani'));
  const ins = (await api('GET', `/api/insumos/${e.plantilla}`)).data;
  assert.deepEqual([ins.responsable.slug, ins.responsable.nombre], ['dani', 'Dani']);
  assert.equal((await asignar(e.plantilla, null)).status, 200);
  assert.equal(filasAsignacion().length, 0);
  assert.throws(() => h.db().prepare('INSERT INTO insumo_responsable (insumo_id, responsable_id) VALUES (?, ?), (?, ?)')
    .run(e.cierre, h.responsableId('ruben'), e.cierre, h.responsableId('jorge')), /UNIQUE|PRIMARY/);
});

test('asignar no modifica stock, movimientos ni historiales', async () => {
  const antes = huellaInventario(h.db());
  await asignar(e.plantilla, 'ruben');
  await asignar(e.fondo, 'jorge');
  await asignar(e.cierre, 'dani');
  await asignar(e.cierre, 'ruben');
  await asignar(e.fondo, null);
  await api('PUT', '/api/responsables/asignaciones', { asignaciones: [{ insumo_id: e.fondo, responsable_id: h.responsableId('dani') }] });
  assert.deepEqual(huellaInventario(h.db()), antes);
});

test('validaciones: responsable inexistente o inactivo, insumo inexistente', async () => {
  assert.equal((await api('PUT', `/api/insumos/${e.plantilla}/responsable`, { responsable_id: 999 })).status, 400);
  h.db().prepare("UPDATE responsables SET activo = 0 WHERE slug = 'jorge'").run();
  try {
    const r = await asignar(e.plantilla, 'jorge');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /no está activo/);
  } finally {
    h.db().prepare("UPDATE responsables SET activo = 1 WHERE slug = 'jorge'").run();
  }
  assert.equal((await asignar(999999, 'ruben')).status, 404);
  assert.equal(filasAsignacion().length, 0);
});

test('asignación en bloque: si una falla no se aplica ninguna', async () => {
  const r = await api('PUT', '/api/responsables/asignaciones', { asignaciones: [
    { insumo_id: e.plantilla, responsable_id: h.responsableId('ruben') },
    { insumo_id: 999999, responsable_id: h.responsableId('ruben') },
  ] });
  assert.equal(r.status, 404);
  assert.equal(filasAsignacion().length, 0);
  const ok = await api('PUT', '/api/responsables/asignaciones', { asignaciones: [
    { insumo_id: e.plantilla, responsable_id: h.responsableId('ruben') },
    { insumo_id: e.fondo, responsable_id: h.responsableId('ruben') },
  ] });
  assert.equal(ok.status, 200);
  assert.equal(filasAsignacion().length, 2);
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
  const id = h.crearInsumo({ nombre: 'Temporal', tipo: 'hebilla' });
  await asignar(id, 'jorge');
  assert.equal((await api('DELETE', `/api/insumos/${id}`)).status, 200);
  assert.equal(filasAsignacion().filter(f => f.insumo_id === id).length, 0);
});
