// ============================================================
// config/espacios.js — Espacios de trabajo individuales
//
// Lista fija y provisoria (prototipo visual). Cuando exista la tabla
// `responsables` (E4), esta lista se obtendrá desde la API.
// No otorga permisos: hoy el acceso es abierto para todos.
// ============================================================

const ESPACIOS = [
  { slug: 'ruben', nombre: 'Rubén', inicial: 'R', color: '#d4ab82' },
  { slug: 'dani',  nombre: 'Dani',  inicial: 'D', color: '#9dbbe0' },
  { slug: 'jorge', nombre: 'Jorge', inicial: 'J', color: '#bfa9e6' },
];

function getEspacio(slug) {
  return ESPACIOS.find(e => e.slug === slug) || null;
}
