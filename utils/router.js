'use strict';

const express = require('express');
const { AppError } = require('./errores');

/**
 * Router de Express que acepta manejadores async: si la promesa falla, el
 * error llega al manejador central (Express 4 no lo hace por sí solo).
 */
function crearRouter() {
  const router = express.Router();
  for (const metodo of ['get', 'post', 'put', 'delete', 'patch']) {
    const original = router[metodo].bind(router);
    router[metodo] = (ruta, ...manejadores) => original(ruta, ...manejadores.map(fn =>
      (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)));
  }
  return router;
}

/**
 * Id numérico de la URL. Un id que no es un entero positivo no puede existir:
 * responde 404 (mensaje) en lugar de llegar a la base como dato inválido.
 */
function idDe(valor, mensaje = 'No encontrado') {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new AppError(mensaje, 404);
  return n;
}

module.exports = { crearRouter, idDe };
