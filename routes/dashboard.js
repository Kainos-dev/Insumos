'use strict';

const { crearRouter } = require('../utils/router');
const router = crearRouter();
const { all, get } = require('../db/database');
const { getAlertasStock, insumosConDuplicados, insumosSinTallesHabilitados } = require('../services/stockService');
const responsables = require('../services/responsablesService');

router.get('/', async (req, res) => {
  // Consultas independientes: se piden en paralelo (cada ida y vuelta a la base cuenta).
  const [alertas, ordenes_recientes, pedidos_pendientes, totales, conciliacion, sin_talles, modulo] = await Promise.all([
    getAlertasStock(),
    all(`
      SELECT o.*, COUNT(d.id) AS lineas, SUM(d.cantidad) AS total_pares
      FROM ordenes_produccion o
      LEFT JOIN detalle_orden d ON d.orden_id=o.id
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 5
    `),
    all(`
      SELECT pp.*, pr.nombre AS proveedor_nombre
      FROM pedidos_proveedor pp
      JOIN proveedores pr ON pr.id=pp.proveedor_id
      WHERE pp.estado IN ('borrador','enviado')
      ORDER BY pp.created_at DESC
    `),
    get(`
      SELECT (SELECT COUNT(*) FROM insumos) AS insumos,
             (SELECT COUNT(*) FROM productos) AS productos,
             (SELECT COUNT(*) FROM proveedores) AS proveedores,
             (SELECT COUNT(*) FROM ordenes_produccion WHERE estado='borrador') AS ordenes_borrador
    `),
    insumosConDuplicados(),
    insumosSinTallesHabilitados(),
    // Responsables de reposición
    (async () => ((await responsables.disponible())
      ? { disponible: true, ...Object.fromEntries(await Promise.all([
        responsables.listar().then(v => ['lista', v]),
        responsables.insumosSinAsignar().then(v => ['sin_asignar', v]),
      ])) }
      : { disponible: false, ...(await responsables.estadoModulo()) }))(),
  ]);

  res.json({
    totales,
    faltantes: alertas.filter(a => a.tipo_alerta === 'faltante'),
    sin_stock: alertas.filter(a => a.tipo_alerta === 'sin_stock'),
    stock_bajo: alertas.filter(a => a.tipo_alerta === 'stock_bajo'),
    ordenes_recientes,
    pedidos_pendientes,
    // Situaciones de configuración o de datos que requieren revisión
    avisos: { conciliacion, sin_talles },
    responsables: modulo,
  });
});

module.exports = router;
