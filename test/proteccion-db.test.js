'use strict';
// Protección de la base de trabajo frente al sembrado destructivo.
// Simula una base "de trabajo" (sin marca, con datos) en una carpeta temporal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const SEED = path.join(RAIZ, 'db', 'seed.js');
const MARCA = 0x44435954;
let dir, prod, otra;

const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const correrSeed = (args, dbPathConfigurada) => spawnSync(process.execPath, [SEED, ...args], {
  cwd: RAIZ, encoding: 'utf8',
  env: { ...process.env, DB_PATH: dbPathConfigurada },
});
const contarInsumos = f => { const d = new Database(f, { readonly: true }); const n = d.prepare('SELECT COUNT(*) n FROM insumos').get().n; d.close(); return n; };

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darc-proteccion-'));
  // Base "de trabajo" simulada: sin marca de pruebas y con un dato propio
  prod = path.join(dir, 'trabajo.db');
  const d = new Database(prod);
  d.exec("CREATE TABLE insumos (id INTEGER PRIMARY KEY, nombre TEXT); INSERT INTO insumos (nombre) VALUES ('dato real');");
  d.close();
  otra = path.join(dir, 'otra-sin-marca.db');
  fs.copyFileSync(prod, otra);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('seed sin --db se niega a ejecutar', () => {
  const r = correrSeed([], prod);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Falta indicar la base de pruebas/);
});

test('seed rechaza la base de trabajo configurada en DB_PATH y no la modifica', () => {
  const antes = hash(prod);
  const r = correrSeed(['--db', prod], prod);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /base de trabajo configurada/);
  assert.equal(hash(prod), antes);
  assert.equal(contarInsumos(prod), 1);
});

test('seed rechaza la base configurada aunque se escriba con otras mayúsculas', () => {
  const variante = prod.toUpperCase();
  const r = correrSeed(['--db', variante], prod);
  assert.equal(r.status, 1);
  assert.equal(contarInsumos(prod), 1);
});

test('seed rechaza la base histórica del proyecto (./calzado.db)', () => {
  const proyecto = path.join(RAIZ, 'calzado.db');
  const r = correrSeed(['--db', proyecto], prod);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Rechazado/);
});

test('seed rechaza cualquier base existente sin marca de pruebas', () => {
  const antes = hash(otra);
  const r = correrSeed(['--db', otra], prod);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no está marcada como base de pruebas/);
  assert.equal(hash(otra), antes);
});

test('seed crea y marca una base de pruebas nueva, y puede volver a sembrarla', () => {
  const nueva = path.join(dir, 'demo.db');
  const r1 = correrSeed(['--db', nueva], prod);
  assert.equal(r1.status, 0, r1.stderr);
  const d = new Database(nueva, { readonly: true });
  assert.equal(d.pragma('application_id', { simple: true }), MARCA);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM insumos').get().n, 11);
  d.close();
  const r2 = correrSeed(['--db', nueva], prod);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(contarInsumos(nueva), 11);
  assert.equal(contarInsumos(prod), 1, 'la base de trabajo sigue intacta');
});

test('con DB_PATH definida, una ruta inexistente no crea una base vacía', () => {
  const inexistente = path.join(dir, 'no-existe.db');
  const r = spawnSync(process.execPath, ['-e', "require('./db/database').getDb()"], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, DB_PATH: inexistente },
  });
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(inexistente));
});
