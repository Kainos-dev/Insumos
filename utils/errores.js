'use strict';

/**
 * Error de negocio con código HTTP. Los servicios lo lanzan cuando una
 * operación no está permitida (estado inválido, datos incorrectos, etc.).
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/** Middleware final de errores: siempre responde JSON y nunca expone detalles internos. */
function manejadorErrores(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la solicitud no es JSON válido' });
  }
  if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({ error: 'No se puede completar la operación: hay registros relacionados que dependen de este elemento.' });
  }
  // Reglas validadas en la base mediante triggers (respaldo de las del servidor)
  if (err && err.code === 'SQLITE_CONSTRAINT_TRIGGER') {
    const mensajes = {
      REASIGNACION_CON_PEDIDOS_ABIERTOS: 'No se puede cambiar el responsable: el insumo está en pedidos abiertos de otro responsable.',
      PEDIDO_RESPONSABLE_INMUTABLE: 'El responsable de un pedido no puede modificarse.',
    };
    const clave = Object.keys(mensajes).find(k => String(err.message).includes(k));
    return res.status(409).json({ error: clave ? mensajes[clave] : 'La operación no cumple las reglas de la base de datos.' });
  }
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return res.status(400).json({ error: 'Los datos enviados no cumplen las reglas de la base de datos.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
}

module.exports = { AppError, manejadorErrores };
