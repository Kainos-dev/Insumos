'use strict';

// Responsables de reposición. Los espacios son vistas de trabajo, no
// controles de acceso (todavía no hay autenticación).
const express = require('express');
const router = express.Router();
const svc = require('../services/responsablesService');

// Siempre responde (aunque falte la migración): permite a la interfaz avisarlo.
router.get('/estado', (req, res) => {
  res.json(svc.estadoModulo());
});

router.get('/', (req, res) => {
  res.json({ responsables: svc.listar(), sin_asignar: svc.insumosSinAsignar() });
});

router.get('/diagnostico-pedidos', (req, res) => {
  res.json(svc.diagnosticoPedidos());
});

// Asignación en bloque: { asignaciones: [{ insumo_id, responsable_id|null }] }
router.put('/asignaciones', (req, res) => {
  res.json({ ok: true, asignaciones: svc.asignarVarios(req.body.asignaciones) });
});

router.get('/:slug/panel', (req, res) => {
  res.json(svc.panel(req.params.slug));
});

module.exports = router;
