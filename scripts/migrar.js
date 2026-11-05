'use strict';
// ============================================================
// Migraciones del esquema (E4: responsables).
//
//   npm run migrar -- estado  [--db <ruta>]
//       Solo lectura, sobre una COPIA temporal: integridad, migraciones
//       pendientes y huella del inventario.
//
//   npm run migrar -- aplicar --db <ruta> --confirmo-respaldo [--puerto 3000]
//       Aplica las pendientes. Exige:
//         · --db explícito y --confirmo-respaldo,
//         · servidor detenido (no responde en --puerto),
//         · PRAGMA integrity_check = ok.
//       Todo ocurre en una transacción: si la huella del inventario
//       cambiara, se revierte y no queda nada aplicado.
//
//   npm run migrar -- revertir --db <ruta> --confirmo-respaldo [--puerto 3000]
//       Elimina las tablas de E4 (plan B; el plan A es restaurar el respaldo).
// ============================================================

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const { pendientes, aplicadas, aplicarPendientes, SQL_REVERSION, TABLA_CONTROL } = require('../db/migraciones');
const { huellaInventario } = require('../db/huella');

const arg = (argv, n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

function servidorActivo(puerto) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port: puerto });
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.once('timeout', () => { s.destroy(); res(false); });
  });
}

function conCopia(dbPath, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darc-migrar-'));
  try {
    for (const suf of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suf)) fs.copyFileSync(dbPath + suf, path.join(tmp, 'copia.db' + suf));
    }
    const db = new Database(path.join(tmp, 'copia.db'), { fileMustExist: true });
    try { return fn(db); } finally { db.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function estado(dbPath) {
  return conCopia(dbPath, db => ({
    base: dbPath,
    integridad: db.pragma('integrity_check', { simple: true }),
    aplicadas: aplicadas(db),
    pendientes: pendientes(db).map(m => ({ id: m.id, descripcion: m.descripcion })),
    huella_inventario: huellaInventario(db),
  }));
}

/** Aplica pendientes con verificación de huella dentro de la misma transacción. */
function aplicar(dbPath) {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const integridad = db.pragma('integrity_check', { simple: true });
    if (integridad !== 'ok') throw new Error(`integrity_check = ${integridad}`);
    const antes = huellaInventario(db);
    const ids = db.transaction(() => {
      const r = aplicarPendientes(db);
      const despues = huellaInventario(db);
      if (despues.total !== antes.total) throw new Error('La huella del inventario cambió: se revierte la migración');
      return r;
    })();
    const despues = huellaInventario(db);
    const resumen = {
      aplicado: new Date().toISOString(), base: dbPath, migraciones: ids,
      integridad_despues: db.pragma('integrity_check', { simple: true }),
      inventario_sin_cambios: antes.total === despues.total,
      huella_inventario: despues.total,
      responsables: db.prepare("SELECT slug, nombre FROM responsables ORDER BY id").all(),
      insumos_asignados: db.prepare('SELECT COUNT(*) AS n FROM insumo_responsable').get().n,
      pedidos_con_responsable: db.prepare('SELECT COUNT(*) AS n FROM pedido_responsable').get().n,
    };
    const reg = path.join(path.dirname(dbPath), `migracion-${Date.now()}.json`);
    fs.writeFileSync(reg, JSON.stringify({ ...resumen, huella_antes: antes, huella_despues: despues }, null, 2));
    resumen.archivo_registro = reg;
    return resumen;
  } finally {
    db.close();
  }
}

function revertir(dbPath) {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const antes = huellaInventario(db);
    db.transaction(() => {
      const control = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLA_CONTROL);
      db.exec(control ? SQL_REVERSION : SQL_REVERSION.replace(/DELETE FROM[^;]+;/, ''));
      if (huellaInventario(db).total !== antes.total) throw new Error('La huella del inventario cambió: se cancela la reversión');
    })();
    return { revertido: true, inventario_sin_cambios: true, pendientes: pendientes(db).map(m => m.id) };
  } finally {
    db.close();
  }
}

async function main(argv) {
  const modo = argv[0];
  if (modo === 'estado') {
    const dbPath = path.resolve(arg(argv, '--db') || require('../db/database').DB_PATH);
    const e = estado(dbPath);
    console.log(`Base (analizada sobre una copia): ${e.base}`);
    console.log(`Integridad: ${e.integridad}`);
    console.log(`Aplicadas: ${e.aplicadas.map(m => m.id).join(', ') || 'ninguna'}`);
    console.log(`Pendientes: ${e.pendientes.map(m => `${m.id} (${m.descripcion})`).join('; ') || 'ninguna'}`);
    console.log(`Huella del inventario: ${e.huella_inventario.total}`);
    for (const [t, v] of Object.entries(e.huella_inventario)) if (t !== 'total') console.log(`   ${t.padEnd(26)} ${String(v.filas).padStart(5)} filas  ${v.sha256.slice(0, 16)}`);
    return 0;
  }
  if (modo === 'aplicar' || modo === 'revertir') {
    const dbArg = arg(argv, '--db');
    if (!dbArg) { console.error(`Uso: ${modo} --db <ruta> --confirmo-respaldo [--puerto 3000]`); return 1; }
    if (!argv.includes('--confirmo-respaldo')) {
      console.error('✋ Rechazado: indicá --confirmo-respaldo después de respaldar la base (db, -wal y -shm).');
      return 1;
    }
    const puerto = Number(arg(argv, '--puerto') || process.env.PORT || 3000);
    if (await servidorActivo(puerto)) {
      console.error(`✋ Rechazado: hay un servidor respondiendo en el puerto ${puerto}. Detenelo con Ctrl+C y reintentá.`);
      return 1;
    }
    try {
      const r = modo === 'aplicar' ? aplicar(path.resolve(dbArg)) : revertir(path.resolve(dbArg));
      console.log(JSON.stringify(r, null, 2));
      return 0;
    } catch (e) {
      console.error('✋ No se aplicó ningún cambio: ' + e.message);
      return 1;
    }
  }
  console.error('Uso: npm run migrar -- estado|aplicar|revertir ... (ver encabezado de scripts/migrar.js)');
  return 1;
}

if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; });

module.exports = { estado, aplicar, revertir, servidorActivo };
