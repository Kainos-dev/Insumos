'use strict';

// Responsables de reposición. Los espacios son vistas de trabajo, no
// controles de acceso (todavía no hay autenticación).
const { crearRouter } = require('../utils/router');
const router = crearRouter();
const svc = require('../services/responsablesService');

// Siempre responde (aunque falten las tablas): permite a la interfaz avisarlo.
router.get('/estado', async (req, res) => {
  res.json(await svc.estadoModulo());
});

router.get('/', async (req, res) => {
  res.json({ responsables: await svc.listar(), sin_asignar: await svc.insumosSinAsignar() });
});

router.get('/diagnostico-pedidos', async (req, res) => {
  res.json(await svc.diagnosticoPedidos());
});

// Asignación en bloque: { asignaciones: [{ insumo_id, responsable_id|null }] }
router.put('/asignaciones', async (req, res) => {
  res.json({ ok: true, asignaciones: await svc.asignarVarios(req.body.asignaciones) });
});

router.get('/:slug/panel', async (req, res) => {
  res.json(await svc.panel(req.params.slug));
});

module.exports = router;
