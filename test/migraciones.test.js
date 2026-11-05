'use strict';
// Migraciones de E4: comportamiento sin migrar, aplicación idempotente,
// inventario intacto, script con protecciones y reversión.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const h = require('./helpers');
const base = h.prepararBaseDePruebas({ migrar: false });   // como la base real antes de E4
const srv = h.iniciarServidor();
const migraciones = require('../db/migraciones');
const { huellaInventario } = require('../db/huella');
const { initSchema } = require('../db/database');
after(async () => { await (await srv).cerrar(); base.cerrar(); });

const RAIZ = path.join(__dirname, '..');
const api = async (m, u, b) => (await srv).req(m, u, b);

test('sin migrar: el sistema funciona y responsables avisa que falta la migración', async () => {
  const e = h.escenarioBase();
  assert.equal((await api('GET', '/api/insumos')).status, 200);
  const ins = (await api('GET', '/api/insumos')).data;
  assert.ok(ins.every(i => i.responsable === null));
  const est = (await api('GET', '/api/responsables/estado')).data;
  assert.equal(est.disponible, false);
  assert.deepEqual(est.migraciones_pendientes.map(m => m.id), ['001_responsables', '002_pedido_responsable', '003_reglas_responsables']);
  assert.equal((await api('GET', '/api/responsables/ruben/panel')).status, 503);
  assert.equal((await api('PUT', `/api/insumos/${e.cierre}/responsable`, { responsable_id: 1 })).status, 503);
  const dash = (await api('GET', '/api/dashboard')).data;
  assert.equal(dash.responsables.disponible, false);
  assert.equal((await api('GET', '/api/pedidos')).status, 200, 'los pedidos existentes siguen consultables');
  const ped = await api('POST', '/api/pedidos', { proveedor_id: e.prov, lineas: [{ insumo_id: e.cierre, cantidad: 3 }] });
  assert.equal(ped.status, 503, 'sin responsables no se pueden crear pedidos nuevos (responsable obligatorio)');
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM pedidos_proveedor').get().n, 0);
  assert.ok(!migraciones.existeTabla(h.db(), migraciones.TABLA_CONTROL), 'el servidor no aplicó nada por su cuenta');
});

test('aplicar: crea las tablas y los 3 responsables, sin asignar insumos ni tocar el inventario', async () => {
  const antes = huellaInventario(h.db());
  const ids = migraciones.aplicarPendientes(h.db());
  assert.deepEqual(ids, ['001_responsables', '002_pedido_responsable', '003_reglas_responsables']);
  assert.deepEqual(huellaInventario(h.db()), antes);
  assert.deepEqual(h.db().prepare('SELECT slug, nombre, activo FROM responsables ORDER BY id').all(),
    [{ slug: 'ruben', nombre: 'Rubén', activo: 1 }, { slug: 'dani', nombre: 'Dani', activo: 1 }, { slug: 'jorge', nombre: 'Jorge', activo: 1 }]);
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM insumo_responsable').get().n, 0);
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM pedido_responsable').get().n, 0, 'pedidos históricos sin asignar');
  assert.equal((await api('GET', '/api/responsables/estado')).data.disponible, true);
  const r = (await api('GET', '/api/responsables')).data;
  assert.equal(r.sin_asignar.length, 3);
});

test('idempotente: aplicar otra vez o reejecutar cada paso no duplica nada', () => {
  assert.deepEqual(migraciones.aplicarPendientes(h.db()), []);
  for (const m of migraciones.MIGRACIONES) m.up(h.db());
  assert.equal(h.db().prepare('SELECT COUNT(*) n FROM responsables').get().n, 3);
  assert.equal(h.db().prepare(`SELECT COUNT(*) n FROM ${migraciones.TABLA_CONTROL}`).get().n, 3);
});

test('verificación de esquema: detecta cambios en objetos existentes u objetos no previstos', () => {
  const { verificarEsquema } = require('../scripts/migrar');
  const base = [{ type: 'table', name: 'insumos', tbl_name: 'insumos', sql: 'CREATE TABLE insumos (id)' }];
  assert.throws(() => verificarEsquema(base, [{ ...base[0], sql: 'CREATE TABLE insumos (id, extra)' }]), /Cambió un objeto existente/);
  assert.throws(() => verificarEsquema(base, [...base, { type: 'table', name: 'otra', tbl_name: 'otra', sql: 'x' }]), /no previsto/);
  assert.throws(() => verificarEsquema(base, [...base,
    { type: 'trigger', name: 'trg_pr_inmutable', tbl_name: 'insumos', sql: 'x' }]), /tabla existente/);
  assert.deepEqual(verificarEsquema(base, [...base, { type: 'table', name: 'responsables', tbl_name: 'responsables', sql: 'x' }]),
    ['table:responsables']);
});

// ——— Script scripts/migrar.js sobre una base aparte (simula la base real) ———

function baseSimulada() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darc-migrar-test-'));
  const f = path.join(dir, 'trabajo.db');
  const d = new Database(f);
  d.pragma('journal_mode = WAL');
  initSchema(d);
  d.exec(`INSERT INTO proveedores (nombre) VALUES ('P');
          INSERT INTO insumos (nombre, tipo, stock_minimo, proveedor_id) VALUES ('Cierre', 'cierre', 5, 1);
          INSERT INTO insumo_stock (insumo_id, talle, stock) VALUES (1, NULL, 7), (1, NULL, 6);
          INSERT INTO movimientos_stock (insumo_id, talle, tipo, cantidad) VALUES (1, NULL, 'ingreso', 7);
          INSERT INTO pedidos_proveedor (proveedor_id, estado) VALUES (1, 'recibido');
          INSERT INTO detalle_pedido_proveedor (pedido_id, insumo_id, cantidad) VALUES (1, 1, 7);`);
  d.close();
  return { dir, f };
}
const migrar = (args) => spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'migrar.js'), ...args], { cwd: RAIZ, encoding: 'utf8' });
const huellaArchivo = f => { const d = new Database(f, { readonly: true }); const x = huellaInventario(d); d.close(); return x; };
const puertoLibre = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('script: estado es de solo lectura y aplicar exige --confirmo-respaldo', async () => {
  const { dir, f } = baseSimulada();
  const libre = String(await puertoLibre());
  const hashArchivo = () => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const antes = hashArchivo();
  const e = migrar(['estado', '--db', f]);
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /Pendientes: 001_responsables/);
  assert.equal(hashArchivo(), antes, 'estado no toca el archivo');
  const r = migrar(['aplicar', '--db', f, '--puerto', libre]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /confirmo-respaldo/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script: se niega a aplicar si hay un servidor activo en el puerto', async () => {
  const { dir, f } = baseSimulada();
  const dummy = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => dummy.once('listening', r));
  const r = migrar(['aplicar', '--db', f, '--confirmo-respaldo', '--puerto', String(dummy.address().port)]);
  dummy.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /servidor respondiendo/);
  const d = new Database(f, { readonly: true });
  assert.ok(!migraciones.existeTabla(d, 'responsables'));
  d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('script: aplicar conserva el inventario, deja registro y revertir vuelve atrás', async () => {
  const { dir, f } = baseSimulada();
  const libre = String(await puertoLibre());
  const antes = huellaArchivo(f);
  const r = migrar(['aplicar', '--db', f, '--confirmo-respaldo', '--puerto', libre]);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.inventario_sin_cambios, true);
  assert.equal(res.integridad_despues, 'ok');
  assert.deepEqual(res.objetos_nuevos.sort(), [
    'index:ix_insumo_responsable_responsable', 'index:ix_pedido_responsable_responsable',
    'table:insumo_responsable', 'table:pedido_responsable', 'table:responsables', 'table:schema_migraciones',
    'trigger:trg_ir_desasignacion_abiertos', 'trigger:trg_ir_reasignacion_abiertos', 'trigger:trg_pr_inmutable',
  ]);
  assert.equal(res.insumos_asignados, 0);
  assert.deepEqual(res.responsables.map(x => x.slug), ['ruben', 'dani', 'jorge']);
  assert.ok(fs.existsSync(res.archivo_registro));
  assert.deepEqual(huellaArchivo(f), antes, 'incluye las filas de stock duplicadas: no se tocan');

  const r2 = migrar(['aplicar', '--db', f, '--confirmo-respaldo', '--puerto', libre]);
  assert.equal(r2.status, 0);
  assert.deepEqual(JSON.parse(r2.stdout).migraciones, [], 'segunda ejecución: nada pendiente');

  const v = migrar(['revertir', '--db', f, '--confirmo-respaldo', '--puerto', libre]);
  assert.equal(v.status, 0, v.stderr);
  const d = new Database(f, { readonly: true });
  assert.ok(!migraciones.existeTabla(d, 'responsables'));
  assert.ok(!migraciones.existeTabla(d, 'insumo_responsable'));
  assert.equal(migraciones.pendientes(d).length, 3);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n, 0, 'sin triggers residuales');
  d.close();
  assert.deepEqual(huellaArchivo(f), antes);
  fs.rmSync(dir, { recursive: true, force: true });
});
