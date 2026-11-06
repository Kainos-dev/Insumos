'use strict';
// Adaptador de prueba: expone una base PGlite (PostgreSQL en memoria, dentro
// del mismo proceso) con la misma forma que un Pool de "pg"
// (query, connect/release, end), para que la app la use sin cambios.
//
// PGlite tiene una sola sesión: las conexiones se entregan de a una, igual
// que un pool de tamaño 1. Una transacción conserva su conexión hasta el final.

class PoolPGlite {
  constructor(db) {
    this.db = db;
    this.cola = Promise.resolve();
  }

  async connect() {
    let liberar;
    const turno = new Promise(res => { liberar = res; });
    const anterior = this.cola;
    this.cola = anterior.then(() => turno);
    await anterior;
    let liberado = false;
    return {
      query: (sql, params) => this._ejecutar(sql, params),
      release: () => { if (!liberado) { liberado = true; liberar(); } },
    };
  }

  async query(sql, params) {
    const c = await this.connect();
    try {
      return await c.query(sql, params);
    } finally {
      c.release();
    }
  }

  async _ejecutar(sql, params = []) {
    const r = await this.db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }

  on() { return this; }

  async end() {}
}

module.exports = { PoolPGlite };
