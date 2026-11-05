'use strict';
// Stock sin talle (cierres / hebillas): sin filas duplicadas nuevas,
// comportamiento determinista con duplicados históricos y conciliación.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const base = h.prepararBaseDePruebas();
const srv = h.iniciarServidor();
const stock = require('../services/stockService');
const conciliacion = require('../scripts/conciliacion-stock');
after(async () => { await (await srv).cerrar(); base.cerrar(); });
beforeEach(() => h.resetear());

const filasGenerales = id => h.filasStock(id).filter(f => f.talle === null);

test('movimientos repetidos sobre un insumo sin talle no crean filas nuevas y se acumulan', () => {
  const id = h.crearInsumo({ nombre: 'Hebilla', tipo: 'hebilla', stock: { general: 50 } });
  stock.adjustStock(id, null, -4, 'consumo_orden', 'orden', 1);
  stock.adjustStock(id, null, -6, 'consumo_orden', 'orden', 2);
  stock.adjustStock(id, null, 10, 'ingreso');
  assert.equal(filasGenerales(id).length, 1);
  assert.equal(stock.getStock(id, null), 50);
  stock.adjustStock(id, null, -60, 'egreso');
  assert.equal(stock.getStock(id, null), -10, 'el stock negativo sigue permitido');
  assert.equal(filasGenerales(id).length, 1);
});

test('setStock crea la fila si no existe y luego la actualiza (nunca duplica)', () => {
  const id = h.crearInsumo({ nombre: 'Cierre', tipo: 'cierre' });
  stock.setStock(id, null, 7);
  stock.setStock(id, undefined, 9);
  stock.setStock(id, '', 11);
  assert.deepEqual(filasGenerales(id).map(f => f.stock), [11]);
});

test('talle numérico y texto se tratan como el mismo talle', () => {
  const id = h.crearInsumo({ nombre: 'Plantilla', tipo: 'plantilla', talles: ['38'], stock: { 38: 5 } });
  stock.adjustStock(id, 38, 2, 'ingreso');
  assert.equal(h.filasStock(id).length, 1);
  assert.equal(stock.getStock(id, '38'), 7);
});

test('con duplicados históricos se usa siempre la fila vigente (menor id) y no se tocan las demás', () => {
  const id = h.crearInsumo({ nombre: 'Hebilla vieja', tipo: 'hebilla' });
  const vigente = h.insertarFilaStock(id, null, 100);
  h.insertarFilaStock(id, null, 96);
  h.insertarFilaStock(id, null, 92);
  assert.equal(stock.getStock(id, null), 100, 'mismo valor que leía el sistema antes de la corrección');
  stock.adjustStock(id, null, -4, 'consumo_orden', 'orden', 9);
  const filas = filasGenerales(id);
  assert.equal(filas.length, 3, 'no se agregan ni se borran filas');
  assert.deepEqual(filas.map(f => [f.id === vigente, f.stock]), [[true, 96], [false, 96], [false, 92]]);
  assert.equal(stock.contarFilasDuplicadas(id), 2);
  const mov = h.movimientos('insumo_id = ?', [id]);
  assert.equal(mov.length, 1);
  assert.equal(mov[0].cantidad, -4);
});

test('la API muestra el stock vigente (no la suma de duplicados) e informa los pendientes', async () => {
  const { req } = await srv;
  const id = h.crearInsumo({ nombre: 'Cierre dup', tipo: 'cierre' });
  h.insertarFilaStock(id, null, 20);
  h.insertarFilaStock(id, null, 18);
  h.insertarFilaStock(id, null, 16);
  const r = await req('GET', `/api/insumos/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.stock_total, 20);
  assert.equal(r.data.stock_rows.length, 1);
  assert.equal(r.data.stock_duplicados, 2);
  const r404 = await req('GET', '/api/insumos/999999');
  assert.equal(r404.status, 404);
});

test('conciliación: el reporte no modifica la base y propone candidatos', () => {
  const id = h.crearInsumo({ nombre: 'Hebilla X', tipo: 'hebilla' });
  h.insertarFilaStock(id, null, 100);
  h.insertarFilaStock(id, null, 96);
  stock.adjustStock(id, null, -4, 'consumo_orden', 'orden', 1);
  const antes = h.filasStock(id);
  const r = conciliacion.reporte(base.dbPath);
  assert.deepEqual(h.filasStock(id), antes);
  assert.equal(r.insumos.length, 1);
  const i = r.insumos[0];
  assert.equal(i.valor_que_usa_el_sistema, 96);
  assert.equal(i.suma_movimientos, -4);
  assert.equal(i.estimacion_alta_mas_movimientos, 92);
  assert.equal(i.valor_contado, null, 'nunca propone un valor como definitivo');
});

test('conciliación: aplicar exige un valor contado para cada insumo y no cambia nada si falta alguno', () => {
  const a = h.crearInsumo({ nombre: 'A', tipo: 'hebilla' });
  h.insertarFilaStock(a, null, 10); h.insertarFilaStock(a, null, 9);
  const b = h.crearInsumo({ nombre: 'B', tipo: 'cierre' });
  h.insertarFilaStock(b, null, 5); h.insertarFilaStock(b, null, 4);
  const plantilla = path.join(path.dirname(base.dbPath), 'plantilla-incompleta.json');
  const r = conciliacion.reporte(base.dbPath, plantilla);
  r.insumos.find(x => x.insumo_id === a).valor_contado = 7;
  fs.writeFileSync(plantilla, JSON.stringify(r));
  assert.throws(() => conciliacion.aplicar(base.dbPath, plantilla), /Falta valor_contado/);
  assert.equal(filasGenerales(a).length, 2);
  assert.equal(filasGenerales(b).length, 2);
});

test('conciliación: aplicar deja una fila, registra el ajuste e impide nuevos duplicados', () => {
  const id = h.crearInsumo({ nombre: 'Hebilla Y', tipo: 'hebilla' });
  const vigente = h.insertarFilaStock(id, null, 100);
  h.insertarFilaStock(id, null, 96);
  h.insertarFilaStock(id, null, 92);
  const plantilla = path.join(path.dirname(base.dbPath), 'plantilla.json');
  const r = conciliacion.reporte(base.dbPath, plantilla);
  r.insumos[0].valor_contado = 8;
  fs.writeFileSync(plantilla, JSON.stringify(r));

  const reg = conciliacion.aplicar(base.dbPath, plantilla);
  assert.ok(fs.existsSync(reg.archivo_registro));
  assert.deepEqual(filasGenerales(id).map(f => [f.id, f.stock]), [[vigente, 8]]);
  const mov = h.movimientos("insumo_id = ? AND referencia_tipo = 'conciliacion'", [id]);
  assert.equal(mov.length, 1);
  assert.equal(mov[0].tipo, 'ajuste');
  assert.equal(mov[0].cantidad, -92);
  assert.ok(reg.indice_unico_creado);
  assert.throws(() => h.insertarFilaStock(id, null, 1), /UNIQUE/);
  fs.rmSync(reg.archivo_registro);
});
