'use strict';
// ============================================================
// Conciliación de stock general duplicado (cierres / hebillas)
//
// Contexto: un error antiguo creaba una fila nueva de stock (talle NULL) en
// cada movimiento. El sistema siempre leyó la primera fila (menor id), por lo
// que hoy existen varias filas por insumo y ninguna garantiza el valor real.
// Este script NO decide valores: la cantidad correcta debe surgir de un
// conteo físico aprobado.
//
// 1) Reporte (solo lectura; trabaja sobre una COPIA temporal de la base):
//      npm run conciliacion -- reporte [--db <ruta>] [--salida plantilla.json]
//
// 2) Aplicar valores contados (modifica la base indicada):
//      npm run conciliacion -- aplicar --db <ruta> --valores plantilla.json --confirmo-respaldo
//    - Exige un valor_contado entero para CADA insumo afectado.
//    - En una transacción: conserva la fila vigente, elimina las duplicadas,
//      fija el valor contado y registra un movimiento 'ajuste' con
//      referencia 'conciliacion'. Guarda un registro JSON de lo eliminado.
//    - Al no quedar duplicados crea un índice único que impide que vuelvan.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const INDICE = 'ux_insumo_stock_general';

function argumento(argv, nombre) {
  const i = argv.indexOf(nombre);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Analiza los duplicados de una base ya abierta. */
function analizar(db) {
  const afectados = db.prepare(`
    SELECT s.insumo_id, i.nombre, i.tipo, COUNT(*) AS filas
    FROM insumo_stock s JOIN insumos i ON i.id = s.insumo_id
    WHERE s.talle IS NULL GROUP BY s.insumo_id HAVING COUNT(*) > 1 ORDER BY s.insumo_id`).all();

  return afectados.map(a => {
    const filas = db.prepare('SELECT id, stock FROM insumo_stock WHERE insumo_id = ? AND talle IS NULL ORDER BY id').all(a.insumo_id);
    const mov = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cantidad),0) AS suma
      FROM movimientos_stock WHERE insumo_id = ? AND talle IS NULL`).get(a.insumo_id);
    const vigente = filas[0];
    return {
      insumo_id: a.insumo_id,
      nombre: a.nombre,
      tipo: a.tipo,
      filas,
      fila_vigente: vigente.id,
      valor_que_usa_el_sistema: vigente.stock,
      valor_ultima_fila: filas[filas.length - 1].stock,
      movimientos: mov.n,
      suma_movimientos: mov.suma,
      // Hipótesis: la fila vigente nunca cambió desde el alta y todos los
      // movimientos registrados fueron reales. No reemplaza un conteo físico.
      estimacion_alta_mas_movimientos: vigente.stock + mov.suma,
      valor_contado: null,
    };
  });
}

function reporte(dbPath, salida) {
  // Copia temporal: la base original no se abre.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darc-conciliacion-'));
  try {
    for (const suf of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suf)) fs.copyFileSync(dbPath + suf, path.join(tmp, 'copia.db' + suf));
    }
    const db = new Database(path.join(tmp, 'copia.db'), { fileMustExist: true });
    const insumos = analizar(db);
    db.close();
    const resultado = { generado: new Date().toISOString(), base: dbPath, insumos };
    if (salida) fs.writeFileSync(salida, JSON.stringify(resultado, null, 2));
    return resultado;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function aplicar(dbPath, valoresPath) {
  const plantilla = JSON.parse(fs.readFileSync(valoresPath, 'utf8'));
  const valores = new Map((plantilla.insumos || []).map(i => [Number(i.insumo_id), i.valor_contado]));

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  try {
    const afectados = analizar(db);
    const faltan = afectados.filter(a => !Number.isInteger(valores.get(a.insumo_id)));
    if (faltan.length) {
      throw new Error('Falta valor_contado entero para: ' + faltan.map(f => `#${f.insumo_id} ${f.nombre}`).join(', '));
    }

    const registro = { aplicado: new Date().toISOString(), base: dbPath, insumos: [] };
    db.transaction(() => {
      for (const a of afectados) {
        const contado = valores.get(a.insumo_id);
        const eliminadas = a.filas.slice(1);
        const delBorrar = db.prepare('DELETE FROM insumo_stock WHERE id = ?');
        for (const f of eliminadas) delBorrar.run(f.id);
        db.prepare('UPDATE insumo_stock SET stock = ? WHERE id = ?').run(contado, a.fila_vigente);
        db.prepare(`INSERT INTO movimientos_stock (insumo_id, talle, tipo, cantidad, referencia_tipo, referencia_id)
                    VALUES (?, NULL, 'ajuste', ?, 'conciliacion', NULL)`).run(a.insumo_id, contado - a.valor_que_usa_el_sistema);
        registro.insumos.push({
          insumo_id: a.insumo_id, nombre: a.nombre,
          valor_anterior: a.valor_que_usa_el_sistema, valor_contado: contado,
          fila_conservada: a.fila_vigente, filas_eliminadas: eliminadas,
        });
      }
      const quedan = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT insumo_id FROM insumo_stock
        WHERE talle IS NULL GROUP BY insumo_id HAVING COUNT(*) > 1)`).get().n;
      if (quedan === 0) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE} ON insumo_stock(insumo_id) WHERE talle IS NULL`);
        registro.indice_unico_creado = true;
      }
    })();

    const regPath = path.join(path.dirname(dbPath), `conciliacion-${Date.now()}.json`);
    fs.writeFileSync(regPath, JSON.stringify(registro, null, 2));
    registro.archivo_registro = regPath;
    return registro;
  } finally {
    db.close();
  }
}

function main(argv) {
  const modo = argv[0];
  if (modo === 'reporte') {
    const dbPath = path.resolve(argumento(argv, '--db') || require('../db/database').DB_PATH);
    const r = reporte(dbPath, argumento(argv, '--salida'));
    if (!r.insumos.length) { console.log('Sin filas de stock general duplicadas.'); return 0; }
    console.log(`Base analizada (copia temporal de): ${r.base}\n`);
    for (const i of r.insumos) {
      console.log(`#${i.insumo_id} ${i.nombre} (${i.tipo}) — ${i.filas.length} filas`);
      console.log(`   valor que usa hoy el sistema: ${i.valor_que_usa_el_sistema}   última fila: ${i.valor_ultima_fila}`);
      console.log(`   movimientos: ${i.movimientos} (suma ${i.suma_movimientos})   estimación alta+movimientos: ${i.estimacion_alta_mas_movimientos}`);
    }
    console.log('\nCompletar "valor_contado" con el conteo físico en la plantilla (--salida) antes de aplicar.');
    return 0;
  }
  if (modo === 'aplicar') {
    const dbArg = argumento(argv, '--db');
    const valores = argumento(argv, '--valores');
    if (!dbArg || !valores) { console.error('Uso: aplicar --db <ruta> --valores <plantilla.json> --confirmo-respaldo'); return 1; }
    if (!argv.includes('--confirmo-respaldo')) {
      console.error('✋ Rechazado: indicá --confirmo-respaldo después de respaldar la base y con el servidor detenido.');
      return 1;
    }
    try {
      const r = aplicar(path.resolve(dbArg), valores);
      console.log(`✅ Conciliación aplicada a ${r.insumos.length} insumo(s). Registro: ${r.archivo_registro}`);
      return 0;
    } catch (e) {
      console.error('✋ No se aplicó ningún cambio: ' + e.message);
      return 1;
    }
  }
  console.error('Uso: npm run conciliacion -- reporte|aplicar ...  (ver encabezado de scripts/conciliacion-stock.js)');
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { analizar, reporte, aplicar };
