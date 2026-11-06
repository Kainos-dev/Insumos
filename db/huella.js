'use strict';
// Huella (SHA-256) del inventario y su historial. Sirve para demostrar que
// una operación (migración, asignación de responsables) no modificó datos.

const crypto = require('crypto');

const TABLAS_INVENTARIO = [
  'proveedores', 'insumos', 'insumo_talles', 'insumo_stock',
  'productos', 'producto_talles', 'producto_accesorios',
  'ordenes_produccion', 'detalle_orden',
  'pedidos_proveedor', 'detalle_pedido_proveedor',
  'movimientos_stock',
];

/** { tabla: { filas, sha256 }, total: sha256 } */
function huellaInventario(db) {
  const resultado = {};
  const total = crypto.createHash('sha256');
  for (const t of TABLAS_INVENTARIO) {
    const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const filas = existe ? db.prepare(`SELECT * FROM ${t} ORDER BY id`).all() : [];
    const sha = crypto.createHash('sha256').update(JSON.stringify(filas)).digest('hex');
    resultado[t] = { filas: filas.length, sha256: sha };
    total.update(t + ':' + sha);
  }
  resultado.total = total.digest('hex');
  return resultado;
}

module.exports = { huellaInventario, TABLAS_INVENTARIO };
