'use strict';

const express = require('express');
const router = express.Router();
const { all, get } = require('../db/database');
const { getAlertasStock, insumosConDuplicados, insumosSinTallesHabilitados } = require('../services/stockService');
const responsables = require('../services/responsablesService');

router.get('/', (req, res) => {
  const alertas = getAlertasStock();

  const ordenes_recientes = all(`
    SELECT o.*, COUNT(d.id) AS lineas, SUM(d.cantidad) AS total_pares
    FROM ordenes_produccion o
    LEFT JOIN detalle_orden d ON d.orden_id=o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 5
  `);

  const pedidos_pendientes = all(`
    SELECT pp.*, pr.nombre AS proveedor_nombre
    FROM pedidos_proveedor pp
    JOIN proveedores pr ON pr.id=pp.proveedor_id
    WHERE pp.estado IN ('borrador','enviado')
    ORDER BY pp.created_at DESC
  `);

  const totales = {
    insumos: get('SELECT COUNT(*) AS n FROM insumos').n,
    productos: get('SELECT COUNT(*) AS n FROM productos').n,
    proveedores: get('SELECT COUNT(*) AS n FROM proveedores').n,
    ordenes_borrador: get("SELECT COUNT(*) AS n FROM ordenes_produccion WHERE estado='borrador'").n,
  };

  const faltantes  = alertas.filter(a => a.tipo_alerta === 'faltante');
  const sin_stock  = alertas.filter(a => a.tipo_alerta === 'sin_stock');
  const stock_bajo = alertas.filter(a => a.tipo_alerta === 'stock_bajo');

  res.json({
    totales,
    faltantes,
    sin_stock,
    stock_bajo,
    ordenes_recientes,
    pedidos_pendientes,
    // Situaciones de configuración o de datos que requieren revisión
    avisos: {
      conciliacion: insumosConDuplicados(),
      sin_talles: insumosSinTallesHabilitados(),
    },
    // Responsables de reposición (null si falta la migración en esta base)
    responsables: responsables.disponible()
      ? { disponible: true, lista: responsables.listar(), sin_asignar: responsables.insumosSinAsignar() }
      : { disponible: false, ...responsables.estadoModulo() },
  });
});

module.exports = router;
