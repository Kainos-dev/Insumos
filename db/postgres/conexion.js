'use strict';
// Conexión a PostgreSQL (Supabase).
// Lee DATABASE_URL del archivo .env (no versionado). Las variables ya
// definidas en la sesión tienen prioridad sobre las del archivo.
// Con un servidor remoto exige SSL verificado con el certificado raíz de
// Supabase (certs/supabase-ca.crt). Con un servidor local (pruebas) no usa SSL.

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

const RAIZ = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(RAIZ, '.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(ENV_FILE);
}

const CA_FILE = path.join(RAIZ, 'certs', 'supabase-ca.crt');
const HOSTS_LOCALES = ['127.0.0.1', 'localhost', '::1', '[::1]'];

// COUNT(*) devuelve bigint y SUM() devuelve numeric; pg los entrega como texto.
// Las cantidades de este sistema entran holgadas en un Number de JavaScript.
types.setTypeParser(types.builtins.INT8, v => Number(v));
types.setTypeParser(types.builtins.NUMERIC, v => Number(v));

function urlConexion() {
  const url = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!url) throw new Error('Falta DATABASE_URL (definila en el archivo .env)');
  return url;
}

function esLocal(url) {
  return HOSTS_LOCALES.includes(new URL(url).hostname);
}

function crearPool(opciones = {}) {
  const url = urlConexion();
  const local = esLocal(url);
  // Protección: las pruebas automáticas (node --test) solo pueden usar una base local.
  if (process.env.NODE_TEST_CONTEXT && !local) {
    throw new Error('Las pruebas no pueden conectarse a una base remota. Revisá DATABASE_URL.');
  }
  if (!process.env.NODE_TEST_CONTEXT) console.log(`Base de datos: ${new URL(url).hostname}`);
  return new Pool({
    connectionString: url,
    ssl: local ? false : { ca: fs.readFileSync(CA_FILE, 'utf8') },
    max: 5,
    ...opciones,
  });
}

module.exports = { crearPool, urlConexion, esLocal };
