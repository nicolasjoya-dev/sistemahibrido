/* ════════════════════════════════════════════════════
   SistemaHíbrido — app.js  (Firestore optimizado)
   - Caché local para productos y anchetas
   - Inventario virtual con búsqueda local (no re-lee Firestore)
   - onSnapshot masivo eliminado (era el mayor consumidor)
   - Anulación de ventas de anchetas corregida
   - Inventario paginado para soportar 2000+ productos
   ════════════════════════════════════════════════════ */

import {
  collection, doc, getDocs, getDoc, addDoc, setDoc,
  updateDoc, deleteDoc, query, where, orderBy,
  serverTimestamp, limit, runTransaction, writeBatch, increment, onSnapshot, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

function db() { return window.__db; }

// ── Utils ─────────────────────────────────────────────
const fmt    = n => Math.round(n || 0).toLocaleString('es-CO');
const fmtCOP = n => '$' + fmt(n);
const $      = id => document.getElementById(id);

function tsToDate(ts) {
  if (!ts) return new Date();
  if (ts instanceof Date) return ts;
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}
function fmtHora(ts)      { return tsToDate(ts).toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' }); }
function fmtFecha(ts)     { return tsToDate(ts).toLocaleDateString('es-CO'); }
function fmtFechaHora(ts) { return fmtFecha(ts) + ' · ' + fmtHora(ts); }

function fechaLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function labelMedioPago(mp) {
  const map = { efectivo: '💵 Efectivo', nequi: '🟣 Nequi', daviplata: '🔴 Daviplata' };
  return map[mp] || mp || 'Efectivo';
}

// ── Caché global (UNA sola lectura de Firestore por sesión) ──
let _productosCache  = null;   // null = sin cargar aún
let _anchetasCache   = null;
let _ajustesCache    = null;

// Timestamp de última carga para invalidar si llevan +30 min
let _productosCargadoEn = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos
const VENTAS_CACHE_TTL_MS = 5 * 60 * 1000; // evita re-leer al navegar entre tabs
const DASH_VENTAS_LIMIT = 20;
const AUDITORIA_PRECIO_COMPRA_ALTO = 50000;
const AUDITORIA_VALOR_COMPRA_ALTO = 1000000;
const INVENTARIO_EDIT_PASSWORD = '780828Zyc';
const _ventasFechaCache = new Map();
const _ventasRangoCache = new Map();
const _ventasRecientesCache = new Map();
const _resumenDiaCache = new Map();
const _resumenMesCache = new Map();
let _cierresCache = null;
let _cierresCargadoEn = 0;
let _dashboardResumenUnsub = null;
let _dashboardResumenFecha = null;

async function getProductos(forzar = false) {
  const ahora = Date.now();
  if (!forzar && _productosCache && (ahora - _productosCargadoEn) < CACHE_TTL_MS) {
    return _productosCache;
  }
  const snap = await getDocs(collection(db(), 'productos'));
  _productosCache    = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  _productosCargadoEn = ahora;
  return _productosCache;
}

async function getAnchetas(forzar = false) {
  if (!forzar && _anchetasCache) return _anchetasCache;
  const snap = await getDocs(query(collection(db(), 'anchetas'), orderBy('nombre')));
  _anchetasCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _anchetasCache;
}

// Invalida caché de productos (después de crear/editar/eliminar)
function invalidarProductos() {
  _productosCache    = null;
  _productosCargadoEn = 0;
}
function invalidarAnchetas() { _anchetasCache = null; }

function cacheVigente(entry, ttl = VENTAS_CACHE_TTL_MS) {
  return entry && (Date.now() - entry.cargadoEn) < ttl;
}

function guardarCache(map, key, data) {
  map.set(key, { cargadoEn: Date.now(), data });
  return data;
}

function rangoKey(desde, hasta) {
  return `${desde}|${hasta}`;
}

function mesKey(anio, mes) {
  return `${anio}-${String(mes).padStart(2, '0')}`;
}

function rangoMes(anio, mes) {
  const ultimo = new Date(anio, mes, 0).getDate();
  const mm = String(mes).padStart(2, '0');
  return {
    desde: `${anio}-${mm}-01`,
    hasta: `${anio}-${mm}-${String(ultimo).padStart(2, '0')}`
  };
}

function fechaVenta(v) {
  return v.fecha_key || fechaLocal(tsToDate(v.fecha));
}

function costoItems(items) {
  return (items || []).reduce((s, item) => {
    const cantidad = parseFloat(item.cantidad) || 0;
    const compra = parseFloat(item.precio_compra) || 0;
    return s + (cantidad * compra);
  }, 0);
}

function costoAncheta(a) {
  return (a.items || []).reduce((s, sub) => {
    const producto = productos.find(p => p.id === sub.producto_id);
    const cantidad = parseFloat(sub.cantidad) || 0;
    const compra = parseFloat(producto?.precio_compra) || 0;
    return s + (cantidad * compra);
  }, 0);
}

function gananciaVenta(v) {
  if (typeof v.ganancia_total === 'number') return v.ganancia_total;
  const total = parseFloat(v.total) || 0;
  return total - costoItems(v.items);
}

function resumenDesdeVentas(fecha, ventas) {
  const validas = (ventas || []).filter(v => !v.anulada);
  const anuladas = (ventas || []).filter(v => v.anulada);
  return {
    fecha,
    num_ventas: validas.length,
    total_ventas: validas.reduce((s, v) => s + (v.total || 0), 0),
    ganancia_total: validas.reduce((s, v) => s + gananciaVenta(v), 0),
    ventas_anuladas: anuladas.length,
    total_anulado: anuladas.reduce((s, v) => s + (v.total || 0), 0)
  };
}

function resumenesDesdeVentas(ventas) {
  const porDia = {};
  (ventas || []).forEach(v => {
    const fecha = fechaVenta(v);
    if (!porDia[fecha]) porDia[fecha] = [];
    porDia[fecha].push(v);
  });
  return Object.entries(porDia).map(([fecha, lista]) => resumenDesdeVentas(fecha, lista));
}

async function guardarResumenes(resumenes, metaId = null, metaData = {}) {
  const batch = writeBatch(db());
  resumenes.forEach(r => {
    batch.set(doc(db(), 'resumenes_diarios', r.fecha), {
      ...r,
      actualizado: serverTimestamp()
    }, { merge: true });
  });
  if (metaId) {
    batch.set(doc(db(), 'resumenes_migraciones', metaId), {
      ...metaData,
      actualizado: serverTimestamp()
    }, { merge: true });
  }
  await batch.commit();
}

function invalidarVentasCache(fecha = null) {
  if (fecha) _ventasFechaCache.delete(fecha);
  else _ventasFechaCache.clear();
  _ventasRangoCache.clear();
  _ventasRecientesCache.clear();
  if (fecha) _resumenDiaCache.delete(fecha);
  else _resumenDiaCache.clear();
  _resumenMesCache.clear();
  _cierresCache = null;
  _cierresCargadoEn = 0;
}

function acumularStock(mapa, productoId, cantidad) {
  if (!productoId || !cantidad) return;
  mapa.set(productoId, (mapa.get(productoId) || 0) + cantidad);
}

function stockNecesarioDesdeItems(items) {
  const mapa = new Map();
  (items || []).forEach(item => {
    if (item._ancheta_id) {
      (item._ancheta_items || []).forEach(sub => {
        acumularStock(mapa, sub.producto_id, (sub.cantidad || 0) * (item.cantidad || 0));
      });
    } else {
      acumularStock(mapa, item.producto_id, stockCantidadItem(item));
    }
  });
  return mapa;
}

function booleanCajaActiva(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (typeof value === 'number') return value > 0;
  const texto = String(value).trim().toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return ['1', 'si', 's', 'true', 'x', 'yes', 'y'].includes(texto);
}

function configCajaProducto(p) {
  const nested = p?.venta_caja || p?.caja || {};
  const unidades = numeroSeguro(
    p?.caja_unidades ?? p?.unidades_por_caja ?? nested.caja_unidades ?? nested.unidades_por_caja ?? nested.unidades
  );
  const precioVenta = numeroSeguro(
    p?.caja_precio_venta ?? p?.precio_venta_caja ?? nested.caja_precio_venta ?? nested.precio_venta_caja ?? nested.precio_venta
  );
  const compraDirecta = numeroSeguro(
    p?.caja_precio_compra ?? p?.precio_compra_caja ?? nested.caja_precio_compra ?? nested.precio_compra_caja ?? nested.precio_compra
  );
  const precioCompra = compraDirecta > 0
    ? compraDirecta
    : (numeroSeguro(p?.precio_compra) * Math.max(1, unidades));
  const codigo = limpiarCodigo(
    p?.caja_codigo_barras ?? p?.codigo_barras_caja ?? nested.caja_codigo_barras ?? nested.codigo_barras_caja ?? nested.codigo_barras ?? ''
  );
  const activaRaw = p?.caja_activa ?? p?.venta_caja_activa ?? nested.caja_activa ?? nested.activa ?? nested.aplica;
  const activa = booleanCajaActiva(activaRaw) && unidades > 0 && precioVenta > 0;
  return { activa, unidades, precio_venta: precioVenta, precio_compra: precioCompra, codigo_barras: codigo };
}

function productoTieneCaja(p) {
  return configCajaProducto(p).activa;
}

function codigoCajaProducto(p) {
  const caja = configCajaProducto(p);
  return caja.activa ? caja.codigo_barras : '';
}

function codigoEsCajaProducto(p, codigo) {
  const cajaCodigo = codigoCajaProducto(p);
  return !!cajaCodigo && cajaCodigo === limpiarCodigo(codigo);
}

function stockCantidadPorPresentacion(item, cantidad = item?.cantidad) {
  const cant = parseFloat(cantidad) || 0;
  if ((item?.presentacion || 'unidad') === 'caja') {
    return cant * Math.max(1, numeroSeguro(item?.caja_unidades));
  }
  return cant;
}

function stockCantidadItem(item) {
  const explicita = parseFloat(item?.stock_cantidad);
  if (Number.isFinite(explicita) && explicita > 0) return explicita;
  return stockCantidadPorPresentacion(item);
}

function textoMetaCarrito(item) {
  if ((item.presentacion || 'unidad') === 'caja') {
    const unidades = Math.max(1, numeroSeguro(item.caja_unidades));
    const descuenta = stockCantidadPorPresentacion(item);
    return `Caja x${fmt(unidades)} unidades - descuenta ${fmt(descuenta)} unidades`;
  }
  return item.unidad || 'unidades';
}

function stockEnCarritoProducto(productoId, itemIgnorado = null) {
  return carrito.reduce((sum, item) => {
    if (item === itemIgnorado || item._ancheta_id || item.producto_id !== productoId) return sum;
    return sum + stockCantidadItem(item);
  }, 0);
}

// ── State ─────────────────────────────────────────────
let productos = [];   // alias local del caché
let anchetas  = [];
let carrito   = [];
let editandoProductoId  = null;
let productoGuardando   = false;
let entradaProductoId   = null;
let productoParaCarrito = null;
let anchetaParaCarrito  = null;
let presentacionParaCarrito = 'unidad';
let productoPresentacionPendiente = null;
let codigoProductoId    = null;
let etiquetasCodigo     = [];
let etiquetasCodigoCargadas = false;
let scannerControls     = null;
let scannerReader       = null;
let scannerActive       = false;
let scannerNativeStream = null;
let scannerNativeTimer  = null;
let scannerQuaggaHandler = null;
let scannerEngine       = '';
let scannerFallbackTimer = null;
let scannerDestino      = 'producto';
let scannerLecturaPendiente = null;
let scannerRetryTimer = null;
let codigosAlternativosProductoModal = [];
let calAnio = new Date().getFullYear();
let calMes  = new Date().getMonth() + 1;

// Paginación inventario
const INV_PAGE_SIZE = 50;
const COD_BATCH_SIZE = 50;
const COD_SEQ_DIGITS = 5;
const INV_SCAN_CLEAR_MS = 5000;
const INV_SCAN_ENTER_GRACE_MS = 600;
let invPagina = 0;
let invFiltro = '';
let invCodigoFiltro = 'todos';
let invCategoriaFiltro = '';
let invUltimoCodigoEscaneado = '';
let invUltimoCodigoEscaneadoEn = 0;
let auditoriaIgnorados = new Map();
let auditoriaIgnoradosCargados = false;
let auditoriaIssuesActuales = new Map();
let auditoriaSeleccionados = new Set();
let auditoriaAccionPendiente = null;
let inventarioAccionPendiente = null;
let codigosLotePreview = null;

// ── Connection status ─────────────────────────────────
function updateConnStatus() {
  const el = $('conn-status');
  if (navigator.onLine) { el.textContent = '● Online';  el.classList.remove('offline'); }
  else                  { el.textContent = '● Offline'; el.classList.add('offline'); }
}
window.addEventListener('online',  updateConnStatus);
window.addEventListener('offline', updateConnStatus);
updateConnStatus();

function setMobileMenu(open) {
  document.body.classList.toggle('mobile-menu-open', open);
  const btn = document.querySelector('.mobile-menu-btn');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

window.toggleMobileMenu = function() {
  setMobileMenu(!document.body.classList.contains('mobile-menu-open'));
};

window.closeMobileMenu = function() {
  setMobileMenu(false);
};

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMobileMenu();
});

// ── Navigation ────────────────────────────────────────
window.switchTab = function(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('tab-' + name).classList.add('active');
  if (el) el.classList.add('active');
  closeMobileMenu();
  if (name !== 'dashboard') detenerEscuchaResumenDashboard();
  // Solo carga desde Firestore en primera visita o tabs que siempre necesitan datos frescos
  if (name === 'dashboard')  loadDashboard();
  if (name === 'inventario') renderInventarioPaginado();   // usa caché
  if (name === 'calendario') renderCalendario();
  if (name === 'cierre')     loadCierreHistorial();
  if (name === 'ajustes')    loadAjustes();
  if (name === 'anchetas')   renderAnchetas();             // usa caché
  if (name === 'codigos')    renderCodigosBarras();
  if (name === 'auditoria')  loadAuditoria();
};

// ── Messages ──────────────────────────────────────────
function showMsg(elId, text, type = 'ok') {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 3500);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function escapeJsString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* ═══════════════════════════════════════════════════════
   VENTAS
═══════════════════════════════════════════════════════ */
async function getVentasHoy(forzar = false) {
  return getVentasPorFecha(fechaLocal(), forzar);
}

async function getVentasRecientesHoy(forzar = false) {
  const hoy = fechaLocal();
  const cached = _ventasRecientesCache.get(hoy);
  if (!forzar && cacheVigente(cached)) return cached.data;
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '==', hoy),
      orderBy('fecha', 'desc'),
      limit(DASH_VENTAS_LIMIT))
  );
  return guardarCache(_ventasRecientesCache, hoy, snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

async function getVentasPorFecha(fechaStr, forzar = false) {
  const cached = _ventasFechaCache.get(fechaStr);
  if (!forzar && cacheVigente(cached)) return cached.data;
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '==', fechaStr),
      orderBy('fecha', 'desc'))
  );
  return guardarCache(_ventasFechaCache, fechaStr, snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

async function getVentasRango(desde, hasta, forzar = false) {
  const key = rangoKey(desde, hasta);
  const cached = _ventasRangoCache.get(key);
  if (!forzar && cacheVigente(cached)) return cached.data;
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '>=', desde),
      where('fecha_key', '<=', hasta),
      orderBy('fecha_key', 'desc'))
  );
  return guardarCache(_ventasRangoCache, key, snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

async function asegurarResumenDia(fecha) {
  const cached = _resumenDiaCache.get(fecha);
  if (cacheVigente(cached)) return cached.data;

  const ref = doc(db(), 'resumenes_diarios', fecha);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = { fecha, ...snap.data() };
      if (typeof data.ganancia_total === 'number') {
        return guardarCache(_resumenDiaCache, fecha, data);
      }
    }
  } catch (e) {
    console.warn('No se pudo leer resumen diario:', e.message || e);
  }

  const ventas = await getVentasPorFecha(fecha);
  const resumen = resumenDesdeVentas(fecha, ventas);
  try {
    await setDoc(ref, { ...resumen, actualizado: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn('No se pudo guardar resumen diario:', e.message || e);
  }
  return guardarCache(_resumenDiaCache, fecha, resumen);
}

async function ajustarResumenDia(fecha, { totalDelta = 0, countDelta = 0, gananciaDelta = 0, totalAnuladoDelta = 0, anuladasDelta = 0 }) {
  try {
    await setDoc(doc(db(), 'resumenes_diarios', fecha), {
      fecha,
      total_ventas: increment(totalDelta),
      num_ventas: increment(countDelta),
      ganancia_total: increment(gananciaDelta),
      total_anulado: increment(totalAnuladoDelta),
      ventas_anuladas: increment(anuladasDelta),
      actualizado: serverTimestamp()
    }, { merge: true });
    _resumenDiaCache.delete(fecha);
    _resumenMesCache.clear();
  } catch (e) {
    console.warn('No se pudo actualizar resumen diario:', e.message || e);
  }
}

function aplicarResumenLocal(fecha, { totalDelta = 0, countDelta = 0, gananciaDelta = 0, totalAnuladoDelta = 0, anuladasDelta = 0 }) {
  const actual = _resumenDiaCache.get(fecha)?.data || { fecha };
  const resumen = {
    ...actual,
    fecha,
    total_ventas: Math.max(0, (actual.total_ventas || 0) + totalDelta),
    num_ventas: Math.max(0, (actual.num_ventas || 0) + countDelta),
    ganancia_total: (actual.ganancia_total || 0) + gananciaDelta,
    total_anulado: Math.max(0, (actual.total_anulado || 0) + totalAnuladoDelta),
    ventas_anuladas: Math.max(0, (actual.ventas_anuladas || 0) + anuladasDelta)
  };
  guardarCache(_resumenDiaCache, fecha, resumen);
  _resumenMesCache.clear();
  if (_dashboardResumenFecha === fecha) pintarResumenDashboard(resumen);
  return resumen;
}

function agregarVentaCache(fecha, venta) {
  const recientes = _ventasRecientesCache.get(fecha);
  if (cacheVigente(recientes)) {
    guardarCache(_ventasRecientesCache, fecha, [venta, ...recientes.data].slice(0, DASH_VENTAS_LIMIT));
  }
  const porFecha = _ventasFechaCache.get(fecha);
  if (cacheVigente(porFecha)) {
    guardarCache(_ventasFechaCache, fecha, [venta, ...porFecha.data]);
  }
  _ventasRangoCache.clear();
}

function actualizarVentaCache(fecha, ventaId, patch) {
  const aplicar = entry => {
    if (!cacheVigente(entry)) return null;
    return entry.data.map(v => v.id === ventaId ? { ...v, ...patch } : v);
  };
  const recientes = aplicar(_ventasRecientesCache.get(fecha));
  if (recientes) guardarCache(_ventasRecientesCache, fecha, recientes);
  const porFecha = aplicar(_ventasFechaCache.get(fecha));
  if (porFecha) guardarCache(_ventasFechaCache, fecha, porFecha);
  _ventasRangoCache.clear();
}

async function getResumenesMes(anio, mes) {
  const key = mesKey(anio, mes);
  const cached = _resumenMesCache.get(key);
  if (cacheVigente(cached, CACHE_TTL_MS)) return cached.data;

  const { desde, hasta } = rangoMes(anio, mes);
  const metaRef = doc(db(), 'resumenes_migraciones', key);
  let metaSnap = null;
  try {
    metaSnap = await getDoc(metaRef);
  } catch (e) {
    console.warn('No se pudo leer migracion de resumenes:', e.message || e);
    const ventas = await getVentasRango(desde, hasta);
    return guardarCache(_resumenMesCache, key, resumenesDesdeVentas(ventas));
  }

  if (!metaSnap.exists()) {
    const ventas = await getVentasRango(desde, hasta);
    const resumenes = resumenesDesdeVentas(ventas);
    try {
      await guardarResumenes(resumenes, key, { mes: key, desde, hasta });
    } catch (e) {
      console.warn('No se pudieron guardar resumenes del mes:', e.message || e);
    }
    return guardarCache(_resumenMesCache, key, resumenes);
  }

  try {
    const snap = await getDocs(
      query(collection(db(), 'resumenes_diarios'),
        where('fecha', '>=', desde),
        where('fecha', '<=', hasta),
        orderBy('fecha', 'desc'))
    );
    return guardarCache(_resumenMesCache, key, snap.docs.map(d => ({ fecha: d.id, ...d.data() })));
  } catch (e) {
    console.warn('No se pudieron leer resumenes del mes:', e.message || e);
    const ventas = await getVentasRango(desde, hasta);
    return guardarCache(_resumenMesCache, key, resumenesDesdeVentas(ventas));
  }
}

/* ═══════════════════════════════════════════════════════
   DASHBOARD  — una sola llamada paralela
═══════════════════════════════════════════════════════ */
function pintarResumenDashboard(resumenHoy = {}) {
  if (!$('d-ventas-hoy')) return;
  $('d-ventas-hoy').textContent = resumenHoy.num_ventas || 0;
  $('d-total-hoy').textContent  = fmtCOP(resumenHoy.total_ventas || 0);
  $('d-ganancia-hoy').textContent = fmtCOP(resumenHoy.ganancia_total || 0);
}

function detenerEscuchaResumenDashboard() {
  if (_dashboardResumenUnsub) _dashboardResumenUnsub();
  _dashboardResumenUnsub = null;
  _dashboardResumenFecha = null;
}

function escucharResumenDashboard(fecha) {
  if (_dashboardResumenUnsub && _dashboardResumenFecha === fecha) return;
  detenerEscuchaResumenDashboard();
  _dashboardResumenFecha = fecha;
  _dashboardResumenUnsub = onSnapshot(doc(db(), 'resumenes_diarios', fecha), snap => {
    if (!snap.exists()) return;
    const resumen = { fecha, ...snap.data() };
    guardarCache(_resumenDiaCache, fecha, resumen);
    pintarResumenDashboard(resumen);
  }, e => console.warn('No se pudo escuchar resumen diario:', e.message || e));
}

async function loadDashboard() {
  const hoy = new Date();
  $('fecha-hoy').textContent = hoy.toLocaleDateString('es-CO', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // Paralelo: productos (caché) + ventas hoy (siempre fresco)
  const fechaHoy = fechaLocal(hoy);
  const [prods, resumenHoy, todasVentas] = await Promise.all([
    getProductos(),
    asegurarResumenDia(fechaHoy),
    getVentasRecientesHoy()
  ]);
  productos = prods;

  const alertas = prods.filter(p => p.stock <= p.stock_minimo);
  const valorInventario = prods.reduce((sum, p) => {
    const stock = parseFloat(p.stock) || 0;
    const precioCompra = parseFloat(p.precio_compra) || 0;
    return sum + (stock * precioCompra);
  }, 0);

  $('d-productos').textContent  = prods.length;
  pintarResumenDashboard(resumenHoy);
  escucharResumenDashboard(fechaHoy);
  $('d-valor-inventario').textContent = fmtCOP(valorInventario);
  $('d-alertas').textContent    = alertas.length;

  const card = $('d-alertas-card');
  alertas.length > 0 ? card.classList.add('warn') : card.classList.remove('warn');

  const alertEl = $('dash-alertas-list');
  if (alertas.length === 0) {
    alertEl.innerHTML = '<div class="empty">✓ Todo el stock está en niveles normales</div>';
  } else {
    alertEl.innerHTML = alertas.map(p => {
      const tipo  = p.stock === 0 ? 'agotado' : 'bajo';
      const label = p.stock === 0 ? 'AGOTADO' : 'Stock bajo';
      return `<div class="alerta-card ${tipo}">
        <div class="alerta-dot"></div>
        <div class="alerta-info">
          <div class="alerta-nombre">${p.nombre}</div>
          <div class="alerta-det">${label} · Mínimo: ${p.stock_minimo} ${p.unidad}</div>
        </div>
        <div class="alerta-stock">${p.stock}</div>
      </div>`;
    }).join('');
  }

  const tbody = $('dash-ventas-body');
  if (todasVentas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Sin ventas hoy</td></tr>';
  } else {
    tbody.innerHTML = todasVentas.map((v, i) => {
      const anulada   = v.anulada === true;
      const rowStyle  = anulada ? 'opacity:0.45;text-decoration:line-through' : '';
      const badgePago = `<span class="badge" style="text-transform:capitalize;font-size:11px">${labelMedioPago(v.medio_pago)}</span>`;
      const btnAnular = anulada
        ? `<span style="color:var(--red,#ff6b6b);font-size:11px;font-weight:600">ANULADA</span>`
        : `<button class="btn-icon del" onclick="anularVenta('${v.id}')">Anular</button>`;
      return `<tr style="${rowStyle}">
        <td>#${i + 1}</td>
        <td>${fmtHora(v.fecha)}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen || '—'}</td>
        <td>${badgePago}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td style="display:flex;gap:6px;align-items:center">
          <button class="btn-icon" onclick="imprimirFactura('${v.id}')">PDF</button>
          ${btnAnular}
        </td>
      </tr>`;
    }).join('');
  }
}

/* ═══════════════════════════════════════════════════════
   ANULAR VENTA  — soporta productos normales Y anchetas
═══════════════════════════════════════════════════════ */
window.anularVenta = async function(ventaId) {
  if (!confirm('¿Anular esta venta? El stock de los productos será devuelto.')) return;

  const ventaRef = doc(db(), 'ventas', ventaId);
  const ventaSnap = await getDoc(ventaRef);
  if (!ventaSnap.exists()) { alert('Venta no encontrada'); return; }
  const v = ventaSnap.data();
  if (v.anulada) { alert('Esta venta ya fue anulada.'); return; }
  const fechaKey = fechaVenta(v);
  const ganancia = gananciaVenta(v);
  await asegurarResumenDia(fechaKey);

  const reposiciones = stockNecesarioDesdeItems(v.items || []);
  const nuevosStocks = {};
  await runTransaction(db(), async tx => {
    const ventaActual = await tx.get(ventaRef);
    if (!ventaActual.exists()) throw new Error('Venta no encontrada');
    if (ventaActual.data().anulada) throw new Error('Esta venta ya fue anulada.');

    const productosTx = [];
    for (const [productoId, cantidad] of reposiciones.entries()) {
      const prodRef = doc(db(), 'productos', productoId);
      const prodSnap = await tx.get(prodRef);
      if (prodSnap.exists()) {
        productosTx.push({ ref: prodRef, id: productoId, stock: prodSnap.data().stock || 0, cantidad });
      }
    }

    productosTx.forEach(p => {
      const nuevoStock = p.stock + p.cantidad;
      nuevosStocks[p.id] = nuevoStock;
      tx.update(p.ref, { stock: nuevoStock });
    });
    tx.update(ventaRef, {
      anulada:         true,
      fecha_anulacion: serverTimestamp()
    });
  });

  if (_productosCache) {
    Object.entries(nuevosStocks).forEach(([id, stock]) => {
      const idx = _productosCache.findIndex(p => p.id === id);
      if (idx >= 0) _productosCache[idx].stock = stock;
    });
    productos = _productosCache;
  }
  aplicarResumenLocal(fechaKey, {
    totalDelta: -(v.total || 0),
    countDelta: -1,
    gananciaDelta: -ganancia,
    totalAnuladoDelta: v.total || 0,
    anuladasDelta: 1
  });
  actualizarVentaCache(fechaKey, ventaId, { anulada: true, fecha_anulacion: new Date() });
  ajustarResumenDia(fechaKey, {
    totalDelta: -(v.total || 0),
    countDelta: -1,
    gananciaDelta: -ganancia,
    totalAnuladoDelta: v.total || 0,
    anuladasDelta: 1
  });

  showMsg('dash-msg', 'Venta anulada y stock devuelto correctamente.', 'warn');
  if ($('tab-dashboard')?.classList.contains('active')) loadDashboard();
  return;

  // Devolver stock — distingue producto normal vs ancheta
  for (const item of (v.items || [])) {
    if (item._ancheta_id) {
      // Es una ancheta: devolver stock de cada sub-item
      for (const sub of (item._ancheta_items || [])) {
        const prodRef  = doc(db(), 'productos', sub.producto_id);
        const prodSnap = await getDoc(prodRef);
        if (prodSnap.exists()) {
          const stockActual = prodSnap.data().stock || 0;
          await updateDoc(prodRef, { stock: stockActual + (sub.cantidad * item.cantidad) });
        }
      }
    } else {
      // Producto normal
      const prodRef  = doc(db(), 'productos', item.producto_id);
      const prodSnap = await getDoc(prodRef);
      if (prodSnap.exists()) {
        const stockActual = prodSnap.data().stock || 0;
        await updateDoc(prodRef, { stock: stockActual + item.cantidad });
      }
    }
  }

  await updateDoc(doc(db(), 'ventas', ventaId), {
    anulada:         true,
    fecha_anulacion: serverTimestamp()
  });

  // Invalidar caché de productos para que refleje stocks actualizados
  invalidarProductos();
  productos = await getProductos();

  showMsg('dash-msg', '✓ Venta anulada y stock devuelto correctamente.', 'warn');
  loadDashboard();
};

/* ═══════════════════════════════════════════════════════
   INVENTARIO  — paginado + búsqueda local (sin re-leer Firestore)
═══════════════════════════════════════════════════════ */
function categoriaKeyInventario(categoria) {
  return String(categoria || '').trim().toLowerCase();
}

function categoriasInventarioDisponibles() {
  const mapa = new Map();
  productos.forEach(p => {
    const nombre = String(p.categoria || '').trim();
    if (!nombre) return;
    const key = categoriaKeyInventario(nombre);
    if (!mapa.has(key)) mapa.set(key, nombre);
  });
  return [...mapa.entries()]
    .map(([key, nombre]) => ({ key, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function actualizarCategoriasInventario(preferida = invCategoriaFiltro) {
  const select = $('inv-categoria-filtro');
  const trigger = $('inv-categoria-trigger');
  const menu = $('inv-categoria-menu');
  const categorias = categoriasInventarioDisponibles();
  const activa = categorias.some(c => c.key === preferida) ? preferida : '';

  if (select) {
    select.innerHTML = '<option value="">Todas las categorias</option>' +
      categorias.map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.nombre)}</option>`).join('');
    select.value = activa;
  }

  invCategoriaFiltro = activa;

  const nombreActivo = activa
    ? (categorias.find(c => c.key === activa)?.nombre || 'Categoria')
    : 'Todas las categorias';
  if (trigger) {
    trigger.textContent = nombreActivo;
    trigger.setAttribute('aria-expanded', $('inv-category-filter')?.classList.contains('open') ? 'true' : 'false');
  }
  if (menu) {
    const opciones = [{ key: '', nombre: 'Todas las categorias' }, ...categorias];
    menu.innerHTML = opciones.map(c => `
      <button type="button" class="filter-option ${c.key === activa ? 'active' : ''}" onclick="seleccionarCategoriaInventario('${escapeJsString(c.key)}')">
        ${escapeHtml(c.nombre)}
      </button>
    `).join('');
  }
}

window.toggleInventarioCategoriaMenu = function() {
  const wrap = $('inv-category-filter');
  if (!wrap) return;
  const abierto = wrap.classList.toggle('open');
  $('inv-categoria-trigger')?.setAttribute('aria-expanded', abierto ? 'true' : 'false');
};

window.seleccionarCategoriaInventario = function(key) {
  invCategoriaFiltro = key || '';
  const select = $('inv-categoria-filtro');
  if (select) select.value = invCategoriaFiltro;
  $('inv-category-filter')?.classList.remove('open');
  $('inv-categoria-trigger')?.setAttribute('aria-expanded', 'false');
  filtrarInventario();
};

document.addEventListener('click', e => {
  const wrap = $('inv-category-filter');
  if (!wrap || wrap.contains(e.target)) return;
  wrap.classList.remove('open');
  $('inv-categoria-trigger')?.setAttribute('aria-expanded', 'false');
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target?.id !== 'inv-search') return;
  const input = e.target;
  const limpio = limpiarCodigo(input.value || '');
  const ahora = Date.now();
  const pasoEnterFinalPrimerEscaneo = ahora - invUltimoCodigoEscaneadoEn <= INV_SCAN_ENTER_GRACE_MS;
  if (limpio && !pasoEnterFinalPrimerEscaneo && codigoInventarioEscaneadoDosVeces(limpio, ahora)) {
    e.preventDefault();
    input.value = '';
    resetEscaneoInventario();
    filtrarInventario();
    showMsg('inv-msg', `Busqueda limpiada: ${limpio} escaneado dos veces.`, 'ok');
  }
});

function productosInventarioFiltrados() {
  return productos.filter(p => {
    const codigos = codigosProducto(p);
    const tieneCodigo = codigos.length > 0;
    const codigoBuscado = limpiarCodigo(invFiltro);
    const coincideTexto = !invFiltro ||
      (p.nombre || '').toLowerCase().includes(invFiltro) ||
      (p.categoria || '').toLowerCase().includes(invFiltro) ||
      (codigoBuscado && codigos.some(codigo => codigo.includes(codigoBuscado)));
    const coincideCategoria = !invCategoriaFiltro ||
      categoriaKeyInventario(p.categoria) === invCategoriaFiltro;
    const coincideCodigo =
      invCodigoFiltro === 'todos' ||
      (invCodigoFiltro === 'con' && tieneCodigo) ||
      (invCodigoFiltro === 'sin' && !tieneCodigo);
    return coincideTexto && coincideCategoria && coincideCodigo;
  });
}

function renderInventarioPaginado() {
  actualizarCategoriasInventario();
  const lista   = productosInventarioFiltrados();

  const total   = lista.length;
  const inicio  = invPagina * INV_PAGE_SIZE;
  const fin     = inicio + INV_PAGE_SIZE;
  const pagina  = lista.slice(inicio, fin);
  const totalPags = Math.ceil(total / INV_PAGE_SIZE);

  const tbody = $('inv-body');
  if (pagina.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No hay productos registrados</td></tr>';
  } else {
    tbody.innerHTML = pagina.map(p => {
      let estado, badge;
      if (p.stock === 0)                  { estado = 'Agotado'; badge = 'badge-agotado'; }
      else if (p.stock <= p.stock_minimo) { estado = 'Bajo';    badge = 'badge-bajo'; }
      else                                { estado = 'OK';      badge = 'badge-ok'; }
      return `<tr>
        <td><strong>${p.nombre}</strong></td>
        <td>${p.categoria || '—'}</td>
        <td>${fmtCOP(p.precio_compra)}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(p.precio_venta)}</strong></td>
        <td>${p.stock}</td>
        <td>${p.stock_minimo}</td>
        <td style="color:var(--muted)">${p.unidad}</td>
        <td><span class="badge ${badge}">${estado}</span></td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-icon" onclick="openModalProducto('${p.id}')">Editar</button>
          <button class="btn-icon" onclick="openModalEntrada('${p.id}')">+Stock</button>
          <button class="btn-icon del" onclick="eliminarProducto('${p.id}')">Eliminar</button>
        </td>
      </tr>`;
    }).join('');
  }

  // Controles de paginación
  let paginaHtml = `<div style="display:flex;align-items:center;gap:10px;justify-content:flex-end;padding:12px 0;font-size:0.85rem;color:var(--muted)">
    <span>${total} productos · Página ${invPagina+1} de ${totalPags || 1}</span>
    <button class="btn-secondary" style="padding:4px 12px" onclick="invIrPagina(${invPagina-1})" ${invPagina===0?'disabled':''}>‹ Ant</button>
    <button class="btn-secondary" style="padding:4px 12px" onclick="invIrPagina(${invPagina+1})" ${invPagina>=totalPags-1?'disabled':''}>Sig ›</button>
  </div>`;
  const paginacionEl = $('inv-paginacion');
  if (paginacionEl) paginacionEl.innerHTML = paginaHtml;
}

window.invIrPagina = function(pag) {
  const lista  = productosInventarioFiltrados();
  const maxPag = Math.ceil(lista.length / INV_PAGE_SIZE) - 1;
  invPagina = Math.max(0, Math.min(pag, maxPag));
  renderInventarioPaginado();
};

function resetEscaneoInventario() {
  invUltimoCodigoEscaneado = '';
  invUltimoCodigoEscaneadoEn = 0;
}

function codigoInventarioEscaneadoDosVeces(codigo, ahora = Date.now()) {
  return !!codigo &&
    invUltimoCodigoEscaneado === codigo &&
    ahora - invUltimoCodigoEscaneadoEn <= INV_SCAN_CLEAR_MS;
}

function registrarCodigoInventarioEscaneado(codigo, ahora = Date.now()) {
  const limpio = limpiarCodigo(codigo);
  if (!limpio) return;
  invUltimoCodigoEscaneado = limpio;
  invUltimoCodigoEscaneadoEn = ahora;
}

function aplicarCodigoEscaneadoInventario(codigo, motor = 'lector') {
  const limpio = limpiarCodigo(codigo);
  const input = $('inv-search');
  if (!input || !limpio) return;

  const ahora = Date.now();
  if (codigoInventarioEscaneadoDosVeces(limpio, ahora)) {
    input.value = '';
    resetEscaneoInventario();
    filtrarInventario();
    showMsg('inv-msg', `Busqueda limpiada: ${limpio} escaneado dos veces.`, 'ok');
    return;
  }

  input.value = limpio;
  filtrarInventario();
  registrarCodigoInventarioEscaneado(limpio, ahora);
  showMsg('inv-msg', `Codigo escaneado: ${limpio} (${motor})`, 'ok');
}

window.filtrarInventario = function(desdeBusqueda = false) {
  const input = $('inv-search');
  const valor = input?.value || '';
  const limpio = limpiarCodigo(valor);
  const ahora = Date.now();
  const esDobleCodigoPegado = !!(invUltimoCodigoEscaneado &&
    limpio === invUltimoCodigoEscaneado + invUltimoCodigoEscaneado &&
    ahora - invUltimoCodigoEscaneadoEn <= INV_SCAN_CLEAR_MS);
  if (desdeBusqueda && (esDobleCodigoPegado || (limpio && codigoInventarioEscaneadoDosVeces(limpio, ahora)))) {
    const normalizado = valor.trim();
    if (esDobleCodigoPegado || normalizado === limpio) {
      const codigoLimpiado = esDobleCodigoPegado ? invUltimoCodigoEscaneado : limpio;
      input.value = '';
      resetEscaneoInventario();
      invFiltro = '';
      invCodigoFiltro = $('inv-codigo-filtro')?.value || 'todos';
      invCategoriaFiltro = $('inv-categoria-filtro')?.value || '';
      invPagina = 0;
      renderInventarioPaginado();
      showMsg('inv-msg', `Busqueda limpiada: ${codigoLimpiado} escaneado dos veces.`, 'ok');
      return;
    }
  }
  invFiltro = valor.toLowerCase().trim();
  invCodigoFiltro = $('inv-codigo-filtro')?.value || 'todos';
  invCategoriaFiltro = $('inv-categoria-filtro')?.value || '';
  const productoExacto = limpio && productoConCodigo(limpio);
  if (productoExacto) {
    registrarCodigoInventarioEscaneado(limpio, ahora);
  } else if (!limpio || (invUltimoCodigoEscaneado && ahora - invUltimoCodigoEscaneadoEn > INV_SCAN_CLEAR_MS)) {
    resetEscaneoInventario();
  }
  invPagina = 0;
  renderInventarioPaginado();
};

/* ═══════════════════════════════════════════════════════
   CENTRO DE AUDITORIA
═══════════════════════════════════════════════════════ */
function auditoriaIgnoradosRef() {
  return collection(db(), 'auditoria_ignorados');
}

function numeroSeguro(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function hashAuditoria(value) {
  const texto = String(value || '');
  let hash = 5381;
  for (let i = 0; i < texto.length; i++) hash = ((hash << 5) + hash) ^ texto.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function crearIssueAuditoria(tipo, producto, etiqueta, detalle, metrica, severidad, extra = '') {
  const firma = JSON.stringify([
    tipo,
    producto?.id || '',
    limpiarCodigo(producto?.codigo_barras || ''),
    numeroSeguro(producto?.stock),
    numeroSeguro(producto?.precio_compra),
    numeroSeguro(producto?.precio_venta),
    extra
  ]);
  const issueId = `${tipo}_${hashAuditoria(producto?.id || extra)}_${hashAuditoria(firma)}`;
  return {
    id: issueId,
    tipo,
    productoId: producto?.id || '',
    nombre: producto?.nombre || 'Producto sin nombre',
    categoria: producto?.categoria || '',
    etiqueta,
    detalle,
    metrica,
    severidad,
    firma
  };
}

async function cargarAuditoriaIgnorados(forzar = false) {
  if (auditoriaIgnoradosCargados && !forzar) return auditoriaIgnorados;
  try {
    const snap = await getDocs(auditoriaIgnoradosRef());
    auditoriaIgnorados = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    auditoriaIgnoradosCargados = true;
  } catch (e) {
    auditoriaIgnorados = new Map();
    auditoriaIgnoradosCargados = true;
    console.warn('No se pudieron cargar auditorias ignoradas:', e.message || e);
  }
  return auditoriaIgnorados;
}

function productosConCodigoAuditoria() {
  return productos.filter(p => codigosProducto(p).length > 0);
}

function calcularAuditoria() {
  const conCodigo = productosConCodigoAuditoria().length;
  const sinCodigo = Math.max(0, productos.length - conCodigo);
  const porCodigo = new Map();

  productos.forEach(p => {
    codigosProducto(p).forEach(codigo => {
      if (!porCodigo.has(codigo)) porCodigo.set(codigo, []);
      porCodigo.get(codigo).push(p);
    });
  });

  const gruposDuplicados = [...porCodigo.entries()].filter(([, lista]) => lista.length > 1);
  const duplicados = [];
  gruposDuplicados.forEach(([codigo, lista]) => {
    const idsGrupo = lista.map(p => p.id).sort().join('|');
    lista.forEach(p => {
      const otros = lista
        .filter(x => x.id !== p.id)
        .map(x => x.nombre)
        .join(', ');
      duplicados.push(crearIssueAuditoria(
        'codigo_duplicado',
        p,
        'Codigo duplicado',
        `Codigo ${codigo} tambien aparece en: ${otros || 'otro producto'}`,
        codigo,
        'danger',
        `${codigo}|${idsGrupo}`
      ));
    });
  });

  const altos = productos
    .map(p => {
      const compra = numeroSeguro(p.precio_compra);
      const venta = numeroSeguro(p.precio_venta);
      const stock = numeroSeguro(p.stock);
      const valor = stock * compra;
      return { p, compra, venta, stock, valor };
    })
    .filter(x => x.compra >= AUDITORIA_PRECIO_COMPRA_ALTO || x.valor >= AUDITORIA_VALOR_COMPRA_ALTO)
    .sort((a, b) => b.valor - a.valor)
    .map(x => {
      const razones = [];
      if (x.compra >= AUDITORIA_PRECIO_COMPRA_ALTO) razones.push(`Compra ${fmtCOP(x.compra)}`);
      if (x.valor >= AUDITORIA_VALOR_COMPRA_ALTO) razones.push(`Valor ${fmtCOP(x.valor)}`);
      return crearIssueAuditoria(
        'valor_alto',
        x.p,
        'Compra alta',
        `${razones.join(' · ')} · Stock ${fmt(x.stock)} · Venta ${fmtCOP(x.venta)}`,
        fmtCOP(x.valor),
        'warning',
        `${x.compra}|${x.stock}|${x.valor}`
      );
    });

  const pendientes = productos
    .map(p => ({
      p,
      compra: numeroSeguro(p.precio_compra),
      venta: numeroSeguro(p.precio_venta),
      stock: numeroSeguro(p.stock)
    }))
    .filter(x => (x.venta > 0 && x.venta <= 10) || (x.compra > 0 && x.venta > 0 && x.venta < x.compra))
    .sort((a, b) => (b.compra - b.venta) - (a.compra - a.venta))
    .map(x => {
      const motivo = x.venta <= 10 ? 'Venta marcada en $10' : 'Venta menor que compra';
      return crearIssueAuditoria(
        'venta_pendiente',
        x.p,
        motivo,
        `Compra ${fmtCOP(x.compra)} · Venta ${fmtCOP(x.venta)} · Stock ${fmt(x.stock)}`,
        fmtCOP(x.venta),
        'info',
        `${x.compra}|${x.venta}|${x.stock}`
      );
    });

  const visibles = lista => lista.filter(issue => !auditoriaIgnorados.has(issue.id));
  return {
    stats: {
      total: productos.length,
      conCodigo,
      sinCodigo,
      pctCodigo: productos.length ? Math.round((conCodigo / productos.length) * 100) : 0,
      codigosDuplicados: gruposDuplicados.length
    },
    duplicados: visibles(duplicados),
    altos: visibles(altos),
    pendientes: visibles(pendientes)
  };
}

function setTextAuditoria(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function renderAuditoriaLista(id, issues) {
  const cont = $(id);
  if (!cont) return;
  if (issues.length === 0) {
    cont.innerHTML = '<div class="empty audit-empty">Sin productos por revisar</div>';
    return;
  }

  cont.innerHTML = issues.map(issue => `
    <div class="audit-item ${issue.severidad} ${auditoriaSeleccionados.has(issue.id) ? 'selected' : ''}">
      <input class="audit-select" type="checkbox" ${auditoriaSeleccionados.has(issue.id) ? 'checked' : ''}
        onchange="toggleSeleccionAuditoria('${escapeJsString(issue.id)}', this.checked)"/>
      <div class="audit-main">
        <div class="audit-kicker">${escapeHtml(issue.etiqueta)}</div>
        <div class="audit-name">${escapeHtml(issue.nombre)}</div>
        <div class="audit-detail">${escapeHtml(issue.detalle)}</div>
      </div>
      <div class="audit-meta">
        <span>${escapeHtml(issue.categoria || 'Sin categoria')}</span>
        <strong>${escapeHtml(issue.metrica)}</strong>
      </div>
      <div class="audit-actions">
        <button class="btn-icon" onclick="openModalProducto('${escapeJsString(issue.productoId)}')">Editar</button>
        <button class="btn-icon" onclick="ignorarAuditoria('${escapeJsString(issue.id)}')">Esta bien</button>
      </div>
    </div>
  `).join('');
}

function renderAuditoria(resultado) {
  const todosIssues = [...resultado.duplicados, ...resultado.altos, ...resultado.pendientes];
  auditoriaIssuesActuales = new Map(todosIssues.map(issue => [issue.id, issue]));
  const visibles = new Set(todosIssues.map(issue => issue.id));
  auditoriaSeleccionados = new Set([...auditoriaSeleccionados].filter(id => visibles.has(id)));

  setTextAuditoria('aud-progreso', `${resultado.stats.pctCodigo}%`);
  setTextAuditoria('aud-progreso-detalle', `${resultado.stats.conCodigo} con codigo / ${resultado.stats.total} productos`);
  setTextAuditoria('aud-duplicados-stat', resultado.stats.codigosDuplicados);
  setTextAuditoria('aud-altos-stat', resultado.altos.length);
  setTextAuditoria('aud-pendientes-stat', resultado.pendientes.length);
  setTextAuditoria('aud-duplicados-count', `${resultado.duplicados.length} productos`);
  setTextAuditoria('aud-altos-count', `${resultado.altos.length} productos`);
  setTextAuditoria('aud-pendientes-count', `${resultado.pendientes.length} productos`);

  const barra = $('aud-progreso-barra');
  if (barra) barra.style.width = `${resultado.stats.pctCodigo}%`;

  renderAuditoriaLista('aud-duplicados-list', resultado.duplicados);
  renderAuditoriaLista('aud-altos-list', resultado.altos);
  renderAuditoriaLista('aud-pendientes-list', resultado.pendientes);
  actualizarEstadoSeleccionAuditoria();
}

function actualizarEstadoSeleccionAuditoria() {
  const el = $('aud-bulk-status');
  if (!el) return;
  const total = auditoriaIssuesActuales.size;
  const seleccionados = auditoriaSeleccionados.size;
  el.textContent = `${seleccionados} seleccionado(s) de ${total} aviso(s) visibles`;
}

window.toggleSeleccionAuditoria = function(issueId, checked) {
  if (checked) auditoriaSeleccionados.add(issueId);
  else auditoriaSeleccionados.delete(issueId);
  actualizarEstadoSeleccionAuditoria();
};

window.seleccionarTodosAuditoria = function() {
  auditoriaSeleccionados = new Set(auditoriaIssuesActuales.keys());
  renderAuditoria(calcularAuditoria());
};

window.limpiarSeleccionAuditoria = function() {
  auditoriaSeleccionados.clear();
  renderAuditoria(calcularAuditoria());
};

window.prepararAuditoriaSeleccion = function(tipo) {
  const ids = [...auditoriaSeleccionados].filter(id => auditoriaIssuesActuales.has(id));
  if (ids.length === 0) {
    showMsg('aud-msg', 'Selecciona al menos un aviso de auditoria.', 'warn');
    return;
  }
  auditoriaAccionPendiente = { tipo, ids };
  const issues = ids.map(id => auditoriaIssuesActuales.get(id)).filter(Boolean);
  const productosUnicos = new Set(issues.map(issue => issue.productoId).filter(Boolean));
  const titulo = tipo === 'eliminar' ? 'Eliminar productos seleccionados' : 'Marcar seleccion como correcta';
  const texto = tipo === 'eliminar'
    ? `Vas a eliminar ${productosUnicos.size} producto(s) del inventario relacionados con ${ids.length} aviso(s). Esta accion no se puede deshacer.`
    : `Vas a ocultar ${ids.length} aviso(s) de auditoria como revisados. Los productos no se eliminan.`;
  $('aud-action-title').textContent = titulo;
  $('aud-action-text').textContent = texto;
  $('aud-action-msg').innerHTML = '';
  const btn = $('aud-action-confirm-btn');
  if (btn) btn.textContent = tipo === 'eliminar' ? 'Eliminar' : 'Marcar bien';
  openModal('modal-auditoria-accion');
};

window.cancelarAccionAuditoria = function() {
  auditoriaAccionPendiente = null;
  closeModal('modal-auditoria-accion');
};

async function marcarAuditoriasComoCorrectas(issues) {
  let batch = writeBatch(db());
  let ops = 0;
  for (const issue of issues) {
    batch.set(doc(db(), 'auditoria_ignorados', issue.id), {
      tipo: issue.tipo,
      producto_id: issue.productoId,
      producto_nombre: issue.nombre,
      firma: issue.firma,
      detalle: issue.detalle,
      actualizado: serverTimestamp()
    }, { merge: true });
    auditoriaIgnorados.set(issue.id, issue);
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = writeBatch(db());
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
}

async function eliminarProductosAuditoria(issues) {
  const idsProductos = [...new Set(issues.map(issue => issue.productoId).filter(Boolean))];
  let batch = writeBatch(db());
  let ops = 0;
  for (const productoId of idsProductos) {
    batch.delete(doc(db(), 'productos', productoId));
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = writeBatch(db());
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  if (_productosCache) {
    const borrados = new Set(idsProductos);
    _productosCache = _productosCache.filter(p => !borrados.has(p.id));
    productos = _productosCache;
  }
  return idsProductos.length;
}

window.confirmarAccionAuditoria = async function() {
  const pendiente = auditoriaAccionPendiente;
  if (!pendiente) return;
  const btn = $('aud-action-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const issues = pendiente.ids.map(id => auditoriaIssuesActuales.get(id)).filter(Boolean);
    if (pendiente.tipo === 'eliminar') {
      const total = await eliminarProductosAuditoria(issues);
      showMsg('aud-msg', `${total} producto(s) eliminados del inventario.`, 'warn');
    } else {
      await marcarAuditoriasComoCorrectas(issues);
      showMsg('aud-msg', `${issues.length} aviso(s) marcados como correctos.`, 'ok');
    }
    auditoriaSeleccionados.clear();
    auditoriaAccionPendiente = null;
    closeModal('modal-auditoria-accion');
    renderAuditoria(calcularAuditoria());
    if ($('tab-inventario')?.classList.contains('active')) renderInventarioPaginado();
  } catch (e) {
    console.warn('No se pudo ejecutar accion de auditoria:', e.message || e);
    showMsg('aud-action-msg', 'No se pudo completar. Revisa la conexion e intenta de nuevo.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.loadAuditoria = async function(forzar = false) {
  showMsg('aud-msg', 'Revisando inventario...', 'ok');
  try {
    productos = await getProductos(forzar);
    await cargarAuditoriaIgnorados(forzar);
    renderAuditoria(calcularAuditoria());
    showMsg('aud-msg', 'Auditoria actualizada.', 'ok');
  } catch (e) {
    console.warn('No se pudo cargar auditoria:', e.message || e);
    showMsg('aud-msg', 'No se pudo cargar el centro de auditoria.', 'error');
  }
};

window.ignorarAuditoria = async function(issueId) {
  const issue = auditoriaIssuesActuales.get(issueId);
  if (!issue) return;
  try {
    await setDoc(doc(db(), 'auditoria_ignorados', issue.id), {
      tipo: issue.tipo,
      producto_id: issue.productoId,
      producto_nombre: issue.nombre,
      firma: issue.firma,
      detalle: issue.detalle,
      actualizado: serverTimestamp()
    }, { merge: true });
    auditoriaIgnorados.set(issue.id, issue);
    renderAuditoria(calcularAuditoria());
    showMsg('aud-msg', 'Producto ocultado de auditoria.', 'ok');
  } catch (e) {
    console.warn('No se pudo ocultar auditoria:', e.message || e);
    showMsg('aud-msg', 'No se pudo guardar este aviso como revisado.', 'error');
  }
};

window.restaurarAuditoriaIgnorados = async function() {
  await cargarAuditoriaIgnorados(true);
  const ids = [...auditoriaIgnorados.keys()];
  if (ids.length === 0) {
    showMsg('aud-msg', 'No hay avisos ocultos.', 'warn');
    return;
  }
  if (!confirm(`Restaurar ${ids.length} aviso(s) oculto(s) de auditoria?`)) return;

  try {
    let batch = writeBatch(db());
    let ops = 0;
    for (const id of ids) {
      batch.delete(doc(db(), 'auditoria_ignorados', id));
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = writeBatch(db());
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    auditoriaIgnorados.clear();
    auditoriaIgnoradosCargados = true;
    renderAuditoria(calcularAuditoria());
    showMsg('aud-msg', 'Avisos ocultos restaurados.', 'ok');
  } catch (e) {
    console.warn('No se pudieron restaurar auditorias:', e.message || e);
    showMsg('aud-msg', 'No se pudieron restaurar los avisos ocultos.', 'error');
  }
};

/* ═══════════════════════════════════════════════════════
   MODAL PRODUCTO
═══════════════════════════════════════════════════════ */
function setProductoCajaVisible() {
  const activa = Boolean($('p-caja-activa')?.checked);
  const fields = $('p-caja-fields');
  if (fields) fields.hidden = !activa;
}

window.toggleProductoCaja = function() {
  setProductoCajaVisible();
};

function solicitarClaveEdicionInventario(id, accion = 'producto') {
  inventarioAccionPendiente = { id: id || null, accion };
  const input = $('inv-pass-input');
  const msg = $('inv-pass-msg');
  if (input) input.value = '';
  if (msg) msg.innerHTML = '';
  openModal('modal-inv-pass');
  setTimeout(() => input?.focus(), 80);
}

window.cancelarClaveInventario = function() {
  inventarioAccionPendiente = null;
  closeModal('modal-inv-pass');
};

window.confirmarClaveInventario = function() {
  const input = $('inv-pass-input');
  const valor = input?.value || '';
  if (valor !== INVENTARIO_EDIT_PASSWORD) {
    showMsg('inv-pass-msg', 'Contrasena incorrecta.', 'error');
    input?.focus();
    return;
  }
  const pendiente = inventarioAccionPendiente;
  inventarioAccionPendiente = null;
  closeModal('modal-inv-pass');
  if (!pendiente) return;
  if (pendiente.accion === 'entrada') {
    abrirModalEntradaFormulario(pendiente.id);
  } else if (pendiente.accion === 'eliminar') {
    eliminarProductoConfirmado(pendiente.id);
  } else {
    abrirModalProductoFormulario(pendiente.id);
  }
};

function abrirModalProductoFormulario(id) {
  editandoProductoId = id || null;
  $('modal-titulo').textContent   = id ? 'Editar Producto' : 'Nuevo Producto';
  $('modal-save-btn').textContent = id ? 'Actualizar' : 'Guardar';
  $('modal-msg').innerHTML = '';
  $('margen-display') && ($('margen-display').style.display = 'none');
  ['p-nombre','p-categoria','p-compra','p-venta','p-stock','p-barras','p-alt-barras-input','p-caja-unidades','p-caja-venta','p-caja-compra','p-caja-barras'].forEach(f => {
    if ($(f)) $(f).value = '';
  });
  codigosAlternativosProductoModal = [];
  $('p-stockmin').value = 5;
  $('p-unidad').value   = 'unidades';
  if ($('p-caja-activa')) $('p-caja-activa').checked = false;
  setProductoCajaVisible();

  if (id) {
    const p = productos.find(x => x.id === id);
    if (p) {
      $('p-nombre').value    = p.nombre;
      $('p-categoria').value = p.categoria || '';
      $('p-compra').value    = p.precio_compra;
      $('p-venta').value     = p.precio_venta;
      $('p-stock').value     = p.stock;
      $('p-stockmin').value  = p.stock_minimo;
      $('p-barras').value    = p.codigo_barras || '';
      codigosAlternativosProductoModal = codigosAlternativosProducto(p);
      $('p-unidad').value    = p.unidad || 'unidades';
      const caja = configCajaProducto(p);
      if ($('p-caja-activa')) $('p-caja-activa').checked = caja.activa;
      if ($('p-caja-unidades')) $('p-caja-unidades').value = caja.unidades || '';
      if ($('p-caja-venta')) $('p-caja-venta').value = caja.precio_venta || '';
      if ($('p-caja-compra')) $('p-caja-compra').value = caja.precio_compra || '';
      if ($('p-caja-barras')) $('p-caja-barras').value = caja.codigo_barras || '';
      setProductoCajaVisible();
      calcMargen();
    }
  }
  renderCodigosAlternativosProducto();
  productoGuardando = false;
  if ($('modal-save-btn')) $('modal-save-btn').disabled = false;
  openModal('modal-producto');
}

window.openModalProducto = function(id) {
  solicitarClaveEdicionInventario(id || null, 'producto');
};

window.calcMargen = function() {
  const compra  = parseFloat($('p-compra').value) || 0;
  const venta   = parseFloat($('p-venta').value)  || 0;
  const display = $('margen-display');
  if (venta > 0 && compra > 0) {
    const ganancia = venta - compra;
    const pct = ((ganancia / compra) * 100).toFixed(1);
    $('margen-pct').textContent = pct + '%';
    $('margen-cop').textContent = fmtCOP(ganancia);
    $('margen-pct').style.color = ganancia >= 0 ? 'var(--teal)' : 'var(--red,#ff6b6b)';
    $('margen-cop').style.color = ganancia >= 0 ? 'var(--green)' : 'var(--red,#ff6b6b)';
    display.style.display = 'block';
  } else if (venta > 0) {
    $('margen-pct').textContent = '—';
    $('margen-cop').textContent = fmtCOP(venta);
    display.style.display = 'block';
  } else {
    display.style.display = 'none';
  }
};

function renderCodigosAlternativosProducto() {
  const cont = $('p-alt-barras-list');
  if (!cont) return;
  if (codigosAlternativosProductoModal.length === 0) {
    cont.innerHTML = '<div class="alt-code-empty">Sin códigos alternativos.</div>';
    return;
  }
  cont.innerHTML = codigosAlternativosProductoModal.map(codigo => `
    <div class="alt-code-chip">
      <span>${escapeHtml(codigo)}</span>
      <button type="button" title="Quitar código" onclick="quitarCodigoAlternativoProducto('${escapeJsString(codigo)}')">×</button>
    </div>
  `).join('');
}

window.agregarCodigoAlternativoProducto = function() {
  const input = $('p-alt-barras-input');
  const agregado = agregarCodigoAlternativoDesdeValor(input?.value || '', 'manual');
  if (agregado && input) input.value = '';
};

function agregarCodigoAlternativoDesdeValor(valor, origen = 'manual') {
  const codigo = limpiarCodigo(valor || '');
  const principal = limpiarCodigo($('p-barras')?.value || '');
  const caja = limpiarCodigo($('p-caja-barras')?.value || '');
  if (!codigo) {
    showMsg('modal-msg', 'Escribe un código alternativo válido.', 'warn');
    return false;
  }
  if (principal && codigo === principal) {
    showMsg('modal-msg', 'Ese código ya está como código principal.', 'warn');
    return false;
  }
  if (caja && codigo === caja) {
    showMsg('modal-msg', 'Ese codigo ya esta como codigo de caja.', 'warn');
    return false;
  }
  if (codigosAlternativosProductoModal.includes(codigo)) {
    showMsg('modal-msg', 'Ese código alternativo ya está agregado.', 'warn');
    return false;
  }
  const repetido = productoConCodigo(codigo, editandoProductoId);
  if (repetido) {
    showMsg('modal-msg', `Ese código ya está asignado a: ${escapeHtml(repetido.nombre || 'otro producto')}.`, 'error');
    return false;
  }
  codigosAlternativosProductoModal.push(codigo);
  renderCodigosAlternativosProducto();
  if (origen === 'scanner') showMsg('modal-msg', `Código alternativo agregado: ${codigo}`, 'ok');
  return true;
}

window.quitarCodigoAlternativoProducto = function(codigo) {
  const limpio = limpiarCodigo(codigo);
  codigosAlternativosProductoModal = codigosAlternativosProductoModal.filter(item => item !== limpio);
  renderCodigosAlternativosProducto();
};

async function validarCodigosProductoModal(codigoPrincipal, codigosAlternativos, codigoCaja = '') {
  const vistos = new Set();
  const revisar = [];
  const agregar = codigo => {
    const limpio = limpiarCodigo(codigo);
    if (!limpio) return;
    if (vistos.has(limpio)) {
      throw new Error(`El código ${limpio} está repetido dentro del producto.`);
    }
    vistos.add(limpio);
    revisar.push(limpio);
  };

  agregar(codigoPrincipal);
  codigosAlternativos.forEach(agregar);
  agregar(codigoCaja);

  if (revisar.length === 0) return;
  showMsg('modal-msg', 'Revisando códigos de barras...', 'ok');
  for (const codigo of revisar) {
    const repetido = await productoDuplicadoPorCodigoFirebase(codigo, editandoProductoId);
    if (repetido) {
      throw new Error(`El código ${codigo} ya está asignado a: ${repetido.nombre || 'otro producto'}.`);
    }
  }
}

async function guardarProductoInterno() {
  const nombre       = $('p-nombre').value.trim();
  const precio_venta = parseFloat($('p-venta').value);
  const codigoBarras = limpiarCodigo($('p-barras').value.trim() || '');
  const altPendiente = limpiarCodigo($('p-alt-barras-input')?.value || '');
  if (altPendiente && !codigosAlternativosProductoModal.includes(altPendiente)) {
    codigosAlternativosProductoModal.push(altPendiente);
    if ($('p-alt-barras-input')) $('p-alt-barras-input').value = '';
  }
  codigosAlternativosProductoModal = codigosAlternativosProducto({ codigos_alternativos: codigosAlternativosProductoModal });
  renderCodigosAlternativosProducto();
  if (!nombre || isNaN(precio_venta)) {
    showMsg('modal-msg', 'Nombre y precio de venta son obligatorios.', 'error');
    return;
  }

  const cajaActiva = Boolean($('p-caja-activa')?.checked);
  const cajaUnidades = parseFloat($('p-caja-unidades')?.value) || 0;
  const cajaPrecioVenta = parseFloat($('p-caja-venta')?.value) || 0;
  const cajaPrecioCompra = parseFloat($('p-caja-compra')?.value) || 0;
  const cajaCodigo = limpiarCodigo($('p-caja-barras')?.value || '');
  if (cajaActiva && (cajaUnidades <= 0 || cajaPrecioVenta <= 0)) {
    showMsg('modal-msg', 'Para vender por caja indica unidades por caja y precio de venta.', 'error');
    return;
  }
  if (cajaActiva && !Number.isInteger(cajaUnidades)) {
    showMsg('modal-msg', 'Las unidades por caja deben ser un numero entero.', 'error');
    return;
  }

  try {
    await validarCodigosProductoModal(codigoBarras, codigosAlternativosProductoModal, cajaActiva ? cajaCodigo : '');
  } catch (e) {
    showMsg('modal-msg', escapeHtml(e.message || 'Hay un código de barras repetido.'), 'error');
    return;
  }

  const data = {
    nombre,
    categoria:     $('p-categoria').value.trim() || '',
    precio_compra: parseFloat($('p-compra').value) || 0,
    precio_venta,
    stock:         parseFloat($('p-stock').value) || 0,
    stock_minimo:  parseFloat($('p-stockmin').value) || 5,
    codigo_barras: codigoBarras,
    codigos_alternativos: [...codigosAlternativosProductoModal],
    unidad:        $('p-unidad').value,
    caja_activa: cajaActiva,
    caja_unidades: cajaActiva ? cajaUnidades : 0,
    caja_precio_venta: cajaActiva ? cajaPrecioVenta : 0,
    caja_precio_compra: cajaActiva ? cajaPrecioCompra : 0,
    caja_codigo_barras: cajaActiva ? cajaCodigo : ''
  };

  if (editandoProductoId) {
    await updateDoc(doc(db(), 'productos', editandoProductoId), data);
    // Actualizar en caché local sin re-leer Firestore
    const idx = _productosCache?.findIndex(p => p.id === editandoProductoId);
    if (idx !== undefined && idx >= 0) _productosCache[idx] = { id: editandoProductoId, ...data };
    showMsg('inv-msg', 'Producto actualizado correctamente.', 'ok');
  } else {
    data.fecha_creacion = serverTimestamp();
    const ref = await addDoc(collection(db(), 'productos'), data);
    // Agregar al caché local
    if (_productosCache) _productosCache.push({ id: ref.id, ...data });
    showMsg('inv-msg', 'Producto creado correctamente.', 'ok');
  }
  productos = _productosCache || [];
  closeModal('modal-producto');
  renderInventarioPaginado();
  actualizarCategoriasCodigo();
  if ($('tab-auditoria')?.classList.contains('active')) loadAuditoria(true);
}

window.guardarProducto = async function() {
  if (productoGuardando) return;
  const saveBtn = $('modal-save-btn');
  productoGuardando = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = editandoProductoId ? 'Actualizando...' : 'Guardando...';
  }

  try {
    await guardarProductoInterno();
  } catch (e) {
    console.warn('No se pudo guardar producto:', e.message || e);
    showMsg('modal-msg', 'No se pudo guardar. Revisa la conexion e intenta de nuevo.', 'error');
  } finally {
    productoGuardando = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = editandoProductoId ? 'Actualizar' : 'Guardar';
    }
  }
};

function setScannerMsg(text, type = 'ok') {
  const el = $('scanner-msg');
  if (!el) return;
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
}

function limpiarVistaScanner() {
  $('scanner-frame')?.classList.remove('quagga-mode');
  const target = $('scanner-quagga');
  if (target) target.innerHTML = '';
}

function programarFallbackScanner(engine, ms, fn) {
  if (scannerFallbackTimer) clearTimeout(scannerFallbackTimer);
  scannerFallbackTimer = setTimeout(async () => {
    scannerFallbackTimer = null;
    if (!scannerActive || scannerEngine !== engine) return;
    await fn();
  }, ms);
}

function detenerCamaraNativa() {
  if (scannerNativeTimer) clearTimeout(scannerNativeTimer);
  scannerNativeTimer = null;
  if (scannerNativeStream) {
    scannerNativeStream.getTracks().forEach(track => track.stop());
    scannerNativeStream = null;
  }
  const video = $('scanner-video');
  if (video?.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
}

function detenerQuaggaScanner() {
  if (!window.Quagga) return;
  try {
    if (scannerQuaggaHandler) window.Quagga.offDetected(scannerQuaggaHandler);
    window.Quagga.stop();
  } catch (e) {
    console.warn('No se pudo detener Quagga:', e.message || e);
  }
  scannerQuaggaHandler = null;
}

function detenerZxingScanner() {
  if (scannerControls?.stop) scannerControls.stop();
  scannerControls = null;
  scannerReader = null;
}

function detenerEscanerBarras() {
  scannerActive = false;
  scannerEngine = '';
  if (scannerFallbackTimer) clearTimeout(scannerFallbackTimer);
  scannerFallbackTimer = null;
  detenerZxingScanner();
  detenerCamaraNativa();
  detenerQuaggaScanner();
  limpiarVistaScanner();
  resetConfirmacionScanner();
}

window.cerrarEscanerBarras = function() {
  detenerEscanerBarras();
  closeModal('modal-scanner');
};

function codigoDesdeResultadoScanner(result) {
  const texto = result?.codeResult?.code || (result?.getText ? result.getText() : (result?.text || String(result || '')));
  return limpiarCodigo(texto);
}

function scannerMsgTarget(destino = scannerDestino) {
  if (destino === 'inventario') return 'inv-msg';
  if (destino === 'venta') return 'venta-msg';
  return 'modal-msg';
}

function ocultarRetryScanner() {
  const overlay = $('scanner-retry-overlay');
  if (overlay) overlay.classList.remove('show');
  if (scannerRetryTimer) clearTimeout(scannerRetryTimer);
  scannerRetryTimer = null;
}

function mostrarRetryScanner(text = 'La lectura no fue estable.') {
  const overlay = $('scanner-retry-overlay');
  if (overlay) {
    const msg = overlay.querySelector('span');
    if (msg) msg.textContent = text;
    overlay.classList.add('show');
  }
  setScannerMsg('Lectura inestable. Vuelve a intentar.', 'warn');
  if (scannerRetryTimer) clearTimeout(scannerRetryTimer);
  scannerRetryTimer = setTimeout(ocultarRetryScanner, 900);
}

function resetConfirmacionScanner() {
  scannerLecturaPendiente = null;
  ocultarRetryScanner();
}

function scannerRequiereLecturaEstable() {
  const viewportMovil = window.matchMedia?.('(max-width: 900px)')?.matches || window.innerWidth <= 900;
  const tactil = window.matchMedia?.('(pointer: coarse)')?.matches || (navigator.maxTouchPoints || 0) > 0;
  return Boolean(viewportMovil && tactil);
}

function lecturaScannerAceptada(codigo, motor) {
  const limpio = limpiarCodigo(codigo);
  if (!/^[A-Z0-9._-]{4,32}$/.test(limpio)) {
    mostrarRetryScanner('Codigo demasiado corto o raro.');
    return false;
  }
  if (!scannerRequiereLecturaEstable()) return true;

  const ahora = Date.now();
  const previa = scannerLecturaPendiente;
  if (!previa || previa.codigo !== limpio || (ahora - previa.lastAt) > 1800) {
    if (previa && previa.codigo !== limpio) {
      mostrarRetryScanner('La camara detecto dos codigos distintos.');
    } else {
      setScannerMsg('Mantén fijo el codigo para confirmar la lectura...', 'warn');
    }
    scannerLecturaPendiente = { codigo: limpio, count: 1, lastAt: ahora };
    return false;
  }

  scannerLecturaPendiente = { codigo: limpio, count: previa.count + 1, lastAt: ahora };
  const lecturasNecesarias = 3;
  if (scannerLecturaPendiente.count < lecturasNecesarias) {
    setScannerMsg(`Confirmando lectura ${scannerLecturaPendiente.count}/${lecturasNecesarias}...`, 'warn');
    return false;
  }
  return true;
}

function completarEscaneoBarras(codigo, motor = 'lector') {
  const limpio = limpiarCodigo(codigo);
  if (!scannerActive || !limpio) return false;
  if (!lecturaScannerAceptada(limpio, motor)) return false;
  if (scannerDestino === 'inventario') {
    aplicarCodigoEscaneadoInventario(limpio, motor);
  } else if (scannerDestino === 'venta') {
    const input = $('venta-buscar');
    input.value = limpio;
    const producto = productoConCodigo(limpio);
    if (producto) {
      $('venta-sugerencias').innerHTML = '';
      showMsg('venta-msg', `Producto escaneado: ${producto.nombre} (${motor})`, 'ok');
      if (productoTieneCaja(producto)) {
        abrirModalPresentacionVenta({ ...producto, _tipo: 'producto' }, codigoEsCajaProducto(producto, limpio) ? 'caja' : 'unidad');
      } else {
        window.abrirModalCantidad({ ...producto, _tipo: 'producto' });
      }
    } else {
      window.buscarProductoVenta();
      showMsg('venta-msg', `Codigo escaneado: ${limpio}. No hay producto exacto.`, 'warn');
    }
  } else if (scannerDestino === 'producto_alt') {
    const input = $('p-alt-barras-input');
    if (input) input.value = limpio;
    agregarCodigoAlternativoDesdeValor(limpio, 'scanner');
  } else {
    $('p-barras').value = limpio;
    showMsg('modal-msg', `Codigo escaneado: ${limpio} (${motor})`, 'ok');
  }
  window.cerrarEscanerBarras();
  return true;
}

function crearLectorScanner() {
  const zxing = window.ZXingBrowser;
  try {
    if (zxing?.DecodeHintType && zxing?.BarcodeFormat) {
      const hints = new Map();
      const formatos = [
        zxing.BarcodeFormat.CODE_128,
        zxing.BarcodeFormat.CODE_39,
        zxing.BarcodeFormat.EAN_13,
        zxing.BarcodeFormat.EAN_8,
        zxing.BarcodeFormat.UPC_A,
        zxing.BarcodeFormat.UPC_E
      ].filter(Boolean);
      if (zxing.DecodeHintType.TRY_HARDER !== undefined) {
        hints.set(zxing.DecodeHintType.TRY_HARDER, true);
      }
      if (zxing.DecodeHintType.POSSIBLE_FORMATS !== undefined && formatos.length > 0) {
        hints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, formatos);
      }
      return new zxing.BrowserMultiFormatReader(hints, 200);
    }
  } catch (e) {
    console.warn('No se pudieron aplicar hints al escaner:', e.message || e);
  }
  return new zxing.BrowserMultiFormatReader();
}

function constraintsScanner() {
  return {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920, min: 640 },
      height: { ideal: 1080, min: 480 },
      focusMode: { ideal: 'continuous' }
    },
    audio: false
  };
}

function formatosDetectorNativo() {
  return ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e'];
}

async function crearDetectorNativo() {
  if (!('BarcodeDetector' in window)) return null;
  let formats = formatosDetectorNativo();
  try {
    if (window.BarcodeDetector.getSupportedFormats) {
      const soportados = await window.BarcodeDetector.getSupportedFormats();
      formats = formats.filter(f => soportados.includes(f));
    }
    return formats.length > 0
      ? new window.BarcodeDetector({ formats })
      : new window.BarcodeDetector();
  } catch (e) {
    try {
      return new window.BarcodeDetector();
    } catch (err) {
      console.warn('BarcodeDetector no esta disponible:', err.message || err);
      return null;
    }
  }
}

async function mejorarEnfoqueScanner(video) {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  if (!track?.getCapabilities || !track?.applyConstraints) return;

  const caps = track.getCapabilities();
  const advanced = {};
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    advanced.focusMode = 'continuous';
  }
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
    advanced.exposureMode = 'continuous';
  }
  if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) {
    advanced.whiteBalanceMode = 'continuous';
  }
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const objetivo = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 1.4));
    advanced.zoom = objetivo;
  }

  if (Object.keys(advanced).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [advanced] });
  } catch (e) {
    console.warn('No se pudieron mejorar ajustes de camara:', e.message || e);
  }
}

async function iniciarDetectorNativo(onResult) {
  const detector = await crearDetectorNativo();
  if (!detector) return false;

  detenerQuaggaScanner();
  detenerZxingScanner();
  limpiarVistaScanner();

  const video = $('scanner-video');
  scannerEngine = 'native';
  setScannerMsg('Probando lector nativo de la camara...', 'ok');

  try {
    scannerNativeStream = await navigator.mediaDevices.getUserMedia(constraintsScanner());
    video.srcObject = scannerNativeStream;
    await video.play().catch(() => {});
    await mejorarEnfoqueScanner(video);
  } catch (e) {
    detenerCamaraNativa();
    console.warn('No se pudo iniciar detector nativo:', e.message || e);
    return false;
  }

  const detectar = async () => {
    if (!scannerActive || scannerEngine !== 'native') return;
    try {
      const encontrados = await detector.detect(video);
      const codigo = limpiarCodigo(encontrados?.[0]?.rawValue || '');
      if (codigo) {
        const aceptado = onResult(codigo, 'nativo');
        if (aceptado) return;
      }
    } catch (e) {
      console.warn('Detector nativo fallo:', e.message || e);
    }
    scannerNativeTimer = setTimeout(detectar, 180);
  };

  detectar();
  return true;
}

function configQuaggaScanner(target) {
  return {
    inputStream: {
      name: 'Live',
      type: 'LiveStream',
      target,
      constraints: {
        facingMode: 'environment',
        width: { min: 640, ideal: 1920 },
        height: { min: 480, ideal: 1080 },
        aspectRatio: { min: 1, max: 2 }
      }
    },
    locator: {
      patchSize: 'medium',
      halfSample: false
    },
    numOfWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
    frequency: 12,
    locate: true,
    decoder: {
      readers: [
        'ean_reader',
        'ean_8_reader',
        'upc_reader',
        'upc_e_reader',
        'code_128_reader',
        'code_39_reader',
        'code_93_reader'
      ]
    }
  };
}

async function iniciarQuaggaScanner(onResult) {
  if (!window.Quagga) return false;

  detenerZxingScanner();
  detenerCamaraNativa();
  limpiarVistaScanner();
  resetConfirmacionScanner();

  const frame = $('scanner-frame');
  const target = $('scanner-quagga');
  if (!frame || !target) return false;
  frame.classList.add('quagga-mode');
  target.innerHTML = '';
  scannerEngine = 'quagga';
  setScannerMsg('Usando Quagga2 para codigos de barras...', 'ok');

  try {
    await new Promise((resolve, reject) => {
      window.Quagga.init(configQuaggaScanner(target), err => err ? reject(err) : resolve());
    });
    scannerQuaggaHandler = data => {
      const codigo = codigoDesdeResultadoScanner(data);
      if (codigo) onResult(codigo, 'Quagga2');
    };
    window.Quagga.onDetected(scannerQuaggaHandler);
    window.Quagga.start();
    const video = target.querySelector('video');
    if (video) await mejorarEnfoqueScanner(video);
    programarFallbackScanner('quagga', 12000, async () => {
      setScannerMsg('Probando lector ZXing de respaldo...', 'ok');
      const inicioZxing = await iniciarZxingScanner(onResult);
      if (!inicioZxing && scannerActive) {
        detenerEscanerBarras();
        closeModal('modal-scanner');
        showMsg('modal-msg', 'No se pudo abrir un lector de codigos. Usa el campo manual.', 'error');
      }
    });
    return true;
  } catch (e) {
    console.warn('No se pudo iniciar Quagga2:', e.message || e);
    detenerQuaggaScanner();
    limpiarVistaScanner();
    return false;
  }
}

async function iniciarZxingScanner(onResult) {
  if (!window.ZXingBrowser?.BrowserMultiFormatReader) return false;

  detenerQuaggaScanner();
  detenerCamaraNativa();
  limpiarVistaScanner();
  resetConfirmacionScanner();
  const video = $('scanner-video');
  scannerEngine = 'zxing';
  scannerReader = crearLectorScanner();
  setScannerMsg('Usando lector ZXing de respaldo...', 'ok');

  try {
    scannerControls = await scannerReader.decodeFromConstraints(
      constraintsScanner(),
      video,
      result => {
        const codigo = codigoDesdeResultadoScanner(result);
        if (codigo) onResult(codigo, 'ZXing');
      }
    );
    await mejorarEnfoqueScanner(video);
    return true;
  } catch (e) {
    try {
      scannerControls = await scannerReader.decodeFromVideoDevice(
        undefined,
        video,
        result => {
          const codigo = codigoDesdeResultadoScanner(result);
          if (codigo) onResult(codigo, 'ZXing');
        }
      );
      await mejorarEnfoqueScanner(video);
      return true;
    } catch (err) {
      console.warn('No se pudo iniciar escaner:', err.message || err);
      detenerZxingScanner();
      return false;
    }
  }
}

window.abrirEscanerBarras = async function(destino = 'producto') {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMsg(scannerMsgTarget(destino), 'Este navegador no permite abrir la camara.', 'error');
    return;
  }

  scannerDestino = destino;
  scannerActive = true;
  resetConfirmacionScanner();
  openModal('modal-scanner');
  setScannerMsg('Abriendo camara...', 'ok');

  const onResult = (codigo, motor) => completarEscaneoBarras(codigo, motor);

  const inicioNativo = await iniciarDetectorNativo(onResult);
  if (inicioNativo) {
    programarFallbackScanner('native', 4500, async () => {
      const inicioQuagga = await iniciarQuaggaScanner(onResult);
      if (!inicioQuagga && scannerActive) {
        const inicioZxing = await iniciarZxingScanner(onResult);
        if (!inicioZxing && scannerActive) {
          detenerEscanerBarras();
          closeModal('modal-scanner');
          showMsg(scannerMsgTarget(), 'No se pudo abrir un lector de codigos. Usa el campo manual.', 'error');
        }
      }
    });
    return;
  }

  const inicioQuagga = await iniciarQuaggaScanner(onResult);
  if (inicioQuagga) return;

  const inicioZxing = await iniciarZxingScanner(onResult);
  if (inicioZxing) return;

  detenerEscanerBarras();
  closeModal('modal-scanner');
  showMsg(scannerMsgTarget(), 'No se pudo abrir un lector de codigos. Usa el campo manual.', 'error');
};

window.abrirEscanerInventario = function() {
  window.abrirEscanerBarras('inventario');
};

window.abrirEscanerVenta = function() {
  window.abrirEscanerBarras('venta');
};

window.abrirEscanerAlternativoProducto = function() {
  window.abrirEscanerBarras('producto_alt');
};

async function eliminarProductoConfirmado(id) {
  if (!confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) return;
  await deleteDoc(doc(db(), 'productos', id));
  if (_productosCache) {
    const idx = _productosCache.findIndex(p => p.id === id);
    if (idx >= 0) _productosCache.splice(idx, 1);
  }
  productos = _productosCache || [];
  showMsg('inv-msg', 'Producto eliminado.', 'warn');
  renderInventarioPaginado();
  if ($('tab-auditoria')?.classList.contains('active')) loadAuditoria(true);
}

window.eliminarProducto = function(id) {
  solicitarClaveEdicionInventario(id, 'eliminar');
};

/* ═══════════════════════════════════════════════════════
   MODAL ENTRADA DE INVENTARIO
═══════════════════════════════════════════════════════ */
async function abrirModalEntradaFormulario(id) {
  entradaProductoId = id;
  const p = productos.find(x => x.id === id);
  $('entrada-prod-nombre').textContent = p ? `${p.nombre} — Stock actual: ${p.stock} ${p.unidad}` : '';
  $('ent-cantidad').value = '';
  $('ent-precio').value   = p ? p.precio_compra : '';
  $('ent-nota').value     = '';

  // Historial — solo últimas 10 entradas (subcolección, lecturas acotadas)
  const snap = await getDocs(
    query(collection(db(), 'productos', id, 'entradas'), orderBy('fecha', 'desc'), limit(10))
  );
  const entradas = snap.docs.map(d => d.data());
  const tbody = $('ent-historial-body');
  tbody.innerHTML = entradas.length === 0
    ? '<tr><td colspan="4" class="empty">Sin historial</td></tr>'
    : entradas.map(e => `
        <tr>
          <td>${fmtFecha(e.fecha)}</td>
          <td>+${e.cantidad}</td>
          <td>${e.precio_compra ? fmtCOP(e.precio_compra) : '—'}</td>
          <td style="color:var(--muted)">${e.nota || '—'}</td>
        </tr>`).join('');
  openModal('modal-entrada');
}

window.openModalEntrada = function(id) {
  solicitarClaveEdicionInventario(id, 'entrada');
};

window.guardarEntrada = async function() {
  const cantidad = parseFloat($('ent-cantidad').value);
  if (!cantidad || cantidad <= 0) { alert('Ingresa una cantidad válida'); return; }

  const precio_compra = parseFloat($('ent-precio').value) || null;
  const nota          = $('ent-nota').value.trim() || null;

  await addDoc(collection(db(), 'productos', entradaProductoId, 'entradas'), {
    cantidad,
    precio_compra: precio_compra || 0,
    nota: nota || '',
    fecha: serverTimestamp()
  });

  const prodRef  = doc(db(), 'productos', entradaProductoId);
  const prodSnap = await getDoc(prodRef);
  const stockActual = prodSnap.data().stock || 0;
  const update = { stock: stockActual + cantidad };
  if (precio_compra) update.precio_compra = precio_compra;
  await updateDoc(prodRef, update);

  // Actualizar caché local
  const idx = _productosCache?.findIndex(p => p.id === entradaProductoId);
  if (idx !== undefined && idx >= 0) {
    _productosCache[idx].stock = stockActual + cantidad;
    if (precio_compra) _productosCache[idx].precio_compra = precio_compra;
  }
  productos = _productosCache || [];

  closeModal('modal-entrada');
  showMsg('inv-msg', `Entrada de ${cantidad} unidades registrada.`, 'ok');
  renderInventarioPaginado();
};

/* ═══════════════════════════════════════════════════════
   VENTAS / CARRITO
═══════════════════════════════════════════════════════ */
window.buscarProductoVenta = async function() {
  const q    = $('venta-buscar').value.trim();
  const cont = $('venta-sugerencias');
  if (q.length < 1) { cont.innerHTML = ''; return; }

  // Usa caché — no llama Firestore
  const qLow = q.toLowerCase();
  const qCode = limpiarCodigo(q);
  const prods = productos
    .filter(p =>
      (p.nombre || '').toLowerCase().includes(qLow) ||
      (qCode && codigosProducto(p).some(codigo => codigo.includes(qCode)))
    )
    .slice(0, 6)
    .map(p => ({ ...p, _tipo: 'producto' }));

  const anchs = anchetas
    .filter(a => a.nombre.toLowerCase().includes(qLow))
    .slice(0, 4)
    .map(a => ({ ...a, _tipo: 'ancheta' }));

  const todos = [...prods, ...anchs];

  if (todos.length === 0) {
    cont.innerHTML = '<div class="sugerencias-list"><div class="sugerencia-item" style="color:var(--muted)">Sin resultados</div></div>';
    return;
  }

  cont.innerHTML = `<div class="sugerencias-list">${todos.map(item => {
    if (item._tipo === 'ancheta') {
      return `<div class="sugerencia-item" onclick='abrirModalCantidadAncheta(${JSON.stringify(item)})'>
        <div>
          <div>🎁 ${item.nombre}</div>
          <div class="sug-stock">${(item.items||[]).length} productos · Ancheta</div>
        </div>
        <span class="sug-precio">${fmtCOP(item.precio_venta)}</span>
      </div>`;
    }
    return `<div class="sugerencia-item" onclick='abrirModalCantidad(${JSON.stringify(item)})'>
      <div>
        <div>${item.nombre}</div>
        <div class="sug-stock">${item.stock} ${item.unidad} disponibles${productoTieneCaja(item) ? ' - caja disponible' : ''}</div>
      </div>
      <span class="sug-precio">${fmtCOP(item.precio_venta)}</span>
    </div>`;
  }).join('')}</div>`;
};

function abrirModalPresentacionVenta(p, sugerida = 'unidad') {
  productoPresentacionPendiente = p;
  const caja = configCajaProducto(p);
  $('mpv-nombre').textContent = p.nombre;
  $('mpv-stock').textContent = `Stock actual: ${fmt(p.stock)} ${p.unidad || 'unidades'}`;
  $('mpv-unidad-precio').textContent = fmtCOP(p.precio_venta || 0);
  $('mpv-caja-precio').textContent = fmtCOP(caja.precio_venta || 0);
  $('mpv-caja-detalle').textContent = `Descuenta ${fmt(caja.unidades)} unidades por caja`;
  $('mpv-unidad')?.classList.toggle('recommended', sugerida !== 'caja');
  $('mpv-caja')?.classList.toggle('recommended', sugerida === 'caja');
  $('venta-sugerencias').innerHTML = '';
  openModal('modal-presentacion-venta');
}

window.seleccionarPresentacionVenta = function(tipo) {
  const p = productoPresentacionPendiente;
  if (!p) return;
  productoPresentacionPendiente = null;
  closeModal('modal-presentacion-venta');
  abrirModalCantidadProducto(p, tipo === 'caja' ? 'caja' : 'unidad');
};

function abrirModalCantidadProducto(p, presentacion = 'unidad') {
  productoParaCarrito = p;
  anchetaParaCarrito  = null;
  presentacionParaCarrito = presentacion === 'caja' && productoTieneCaja(p) ? 'caja' : 'unidad';
  const caja = configCajaProducto(p);
  if (presentacionParaCarrito === 'caja') {
    const cajasDisponibles = caja.unidades > 0 ? Math.floor((p.stock || 0) / caja.unidades) : 0;
    $('mcant-nombre').textContent = `${p.nombre} - Caja`;
    $('mcant-label').textContent  = 'Cantidad (cajas)';
    $('mcant-stock').textContent  = `${cajasDisponibles} cajas (${fmt(p.stock)} unidades)`;
    $('mcant-val').min = 1;
    $('mcant-val').step = 1;
  } else {
    $('mcant-nombre').textContent = p.nombre;
    $('mcant-label').textContent  = `Cantidad (${p.unidad})`;
    $('mcant-stock').textContent  = `${p.stock} ${p.unidad}`;
    $('mcant-val').min = 0.01;
    $('mcant-val').step = 0.01;
  }
  $('mcant-val').value = 1;
  $('venta-sugerencias').innerHTML = '';
  openModal('modal-cantidad');
}

window.abrirModalCantidad = function(p, sugerida = null) {
  if (productoTieneCaja(p) && !sugerida) {
    abrirModalPresentacionVenta(p, 'unidad');
    return;
  }
  abrirModalCantidadProducto(p, sugerida || 'unidad');
};

window.abrirModalCantidadAncheta = function(a) {
  anchetaParaCarrito  = a;
  productoParaCarrito = null;
  $('mcant-nombre').textContent = '🎁 ' + a.nombre;
  $('mcant-label').textContent  = 'Cantidad de anchetas';
  $('mcant-stock').textContent  = 'Sin límite de stock definido';
  $('mcant-val').value = 1;
  $('venta-sugerencias').innerHTML = '';
  openModal('modal-cantidad');
};

window.confirmarAgregarCarrito = function() {
  const cant = parseFloat($('mcant-val').value);
  if (!cant || cant <= 0) { alert('Cantidad inválida'); return; }

  if (anchetaParaCarrito) {
    const a = anchetaParaCarrito;
    const costoUnitario = costoAncheta(a);
    const existing = carrito.find(c => c._ancheta_id === a.id);
    if (existing) {
      existing.cantidad += cant;
      existing.precio_compra = costoUnitario;
    }
    else {
      carrito.push({
        _ancheta_id:     a.id,
        _ancheta_items:  a.items,
        producto_id:     null,
        nombre_producto: '🎁 ' + a.nombre,
        cantidad:        cant,
        precio_unitario: a.precio_venta,
        precio_compra:   costoUnitario,
        unidad:          'unidades'
      });
    }
    anchetaParaCarrito = null;
  } else if (productoParaCarrito) {
    const presentacion = presentacionParaCarrito === 'caja' && productoTieneCaja(productoParaCarrito) ? 'caja' : 'unidad';
    const caja = configCajaProducto(productoParaCarrito);
    if (presentacion === 'caja' && !Number.isInteger(cant)) { alert('La cantidad de cajas debe ser un numero entero'); return; }
    const stockSolicitado = presentacion === 'caja' ? cant * caja.unidades : cant;
    const existing = carrito.find(c => c.producto_id === productoParaCarrito.id && (c.presentacion || 'unidad') === presentacion);
    const stockYaReservado = stockEnCarritoProducto(productoParaCarrito.id, existing || null);
    if (stockYaReservado + stockSolicitado > productoParaCarrito.stock) { alert('Stock insuficiente'); return; }
    if (existing) {
      const nuevaCantidad = existing.cantidad + cant;
      const nuevoStockSolicitado = stockCantidadPorPresentacion(existing, nuevaCantidad);
      if (stockYaReservado + nuevoStockSolicitado > productoParaCarrito.stock) { alert('Stock insuficiente'); return; }
      existing.cantidad += cant;
      existing.stock_cantidad = nuevoStockSolicitado;
    }
    else {
      const esCaja = presentacion === 'caja';
      carrito.push({
        producto_id:     productoParaCarrito.id,
        nombre_producto: esCaja ? `${productoParaCarrito.nombre} (Caja x${fmt(caja.unidades)})` : productoParaCarrito.nombre,
        cantidad:        cant,
        precio_unitario: esCaja ? caja.precio_venta : productoParaCarrito.precio_venta,
        precio_compra:   esCaja ? caja.precio_compra : (productoParaCarrito.precio_compra || 0),
        unidad:          esCaja ? 'cajas' : productoParaCarrito.unidad,
        presentacion,
        caja_unidades:   esCaja ? caja.unidades : 1,
        stock_cantidad:  stockSolicitado
      });
    }
    productoParaCarrito = null;
    presentacionParaCarrito = 'unidad';
  }

  closeModal('modal-cantidad');
  $('venta-buscar').value = '';
  renderCarrito();
};

function renderCarrito() {
  const cont = $('carrito-items');
  if (carrito.length === 0) {
    cont.innerHTML = '<div class="empty" style="padding:24px">Carrito vacío</div>';
  } else {
    cont.innerHTML = carrito.map((item, i) => `
      <div class="cart-item">
        <div class="cart-item-main">
          <div class="cart-item-name">${item.nombre_producto}</div>
          <div class="cart-item-meta">${textoMetaCarrito(item)}</div>
        </div>
        <input class="cart-item-qty" type="number" min="0.01" step="0.01" value="${item.cantidad}"
          onchange="actualizarCantCarrito(${i}, this.value)"/>
        <div class="cart-item-sub">${fmtCOP(item.cantidad * item.precio_unitario)}</div>
        <button class="cart-item-del" onclick="eliminarCarrito(${i})">✕</button>
      </div>`).join('');
  }
  recalcCarrito();
}

window.actualizarCantCarrito = function(i, val) {
  const v = parseFloat(val);
  if (v > 0) {
    const item = carrito[i];
    if (item && !item._ancheta_id) {
      const p = productos.find(x => x.id === item.producto_id);
      const stockSolicitado = stockCantidadPorPresentacion(item, v);
      const stockOtrosItems = stockEnCarritoProducto(item.producto_id, item);
      if (p && stockOtrosItems + stockSolicitado > p.stock) { alert('Stock insuficiente'); renderCarrito(); return; }
      item.stock_cantidad = stockSolicitado;
    }
    carrito[i].cantidad = v;
  }
  renderCarrito();
};
window.eliminarCarrito  = function(i) { carrito.splice(i, 1); renderCarrito(); };
window.limpiarCarrito   = function() {
  carrito = [];
  productoParaCarrito = null;
  anchetaParaCarrito = null;
  presentacionParaCarrito = 'unidad';
  $('cart-descuento').value    = '';
  $('cart-efectivo').value     = '';
  $('cart-vuelto').textContent = '—';
  renderCarrito();
};

window.recalcCarrito = function() {
  const sub     = carrito.reduce((s, c) => s + c.cantidad * c.precio_unitario, 0);
  $('cart-sub').textContent = fmtCOP(sub);
  const descVal = parseFloat($('cart-descuento').value) || 0;
  const tipo    = $('cart-desc-tipo').value;
  const desc    = tipo === 'pct' ? (sub * descVal / 100) : descVal;
  const total   = Math.max(0, sub - desc);
  $('cart-total').textContent = fmtCOP(total);
  calcVuelto();
  return { sub, desc, total };
};

window.calcVuelto = function() {
  const totalText = $('cart-total').textContent.replace(/[^0-9]/g, '');
  const total     = parseInt(totalText) || 0;
  const efectivo  = parseFloat($('cart-efectivo').value) || 0;
  if (efectivo > 0) {
    const vuelto = efectivo - total;
    $('cart-vuelto').textContent = fmtCOP(vuelto);
    $('cart-vuelto').style.color = vuelto >= 0 ? 'var(--green)' : 'var(--red)';
  } else {
    $('cart-vuelto').textContent = '—';
  }
};

window.actualizarMedioPago = function() {
  const val = document.querySelector('input[name="medio_pago"]:checked')?.value || 'efectivo';
  ['efectivo','nequi','daviplata'].forEach(mp => {
    const btn = document.getElementById('mp-btn-' + mp);
    if (!btn) return;
    if (mp === val) {
      btn.style.border     = '2px solid var(--teal)';
      btn.style.background = 'rgba(0,201,167,0.1)';
      btn.style.color      = 'var(--teal)';
    } else {
      btn.style.border     = '2px solid var(--border)';
      btn.style.background = 'transparent';
      btn.style.color      = 'var(--muted)';
    }
  });
  const bloqueEfectivo = document.getElementById('bloque-efectivo');
  if (bloqueEfectivo) bloqueEfectivo.style.display = val === 'efectivo' ? 'block' : 'none';
};

window.confirmarVenta = async function() {
  if (carrito.length === 0) { alert('El carrito está vacío'); return; }

  const sub      = carrito.reduce((s, c) => s + c.cantidad * c.precio_unitario, 0);
  const descVal  = parseFloat($('cart-descuento').value) || 0;
  const tipo     = $('cart-desc-tipo').value;
  const desc     = tipo === 'pct' ? (sub * descVal / 100) : descVal;
  const total    = Math.max(0, sub - desc);
  const ganancia = total - costoItems(carrito);
  const efectivo = parseFloat($('cart-efectivo').value) || null;
  const medio_pago = document.querySelector('input[name="medio_pago"]:checked')?.value || 'efectivo';
  const ahora    = new Date();
  const resumen  = carrito.map(c => `${c.nombre_producto} x${c.cantidad}`).join(', ');
  const fechaKey = fechaLocal(ahora);

  await asegurarResumenDia(fechaKey);
  const nuevaVentaRef = doc(collection(db(), 'ventas'));
  const ventaData = {
    items:             carrito.map(c => ({ ...c })),
    productos_resumen: resumen,
    subtotal:          sub,
    descuento:         desc,
    total,
    ganancia_total:    ganancia,
    medio_pago,
    efectivo:          efectivo || 0,
    vuelto:            efectivo ? efectivo - total : 0,
    anulada:           false,
    fecha:             serverTimestamp(),
    fecha_key:         fechaKey
  };
  const stockNecesario = stockNecesarioDesdeItems(carrito);
  const nuevosStocks = {};

  try {
    await runTransaction(db(), async tx => {
      const productosTx = [];
      for (const [productoId, cantidad] of stockNecesario.entries()) {
        const prodRef = doc(db(), 'productos', productoId);
        const prodSnap = await tx.get(prodRef);
        if (!prodSnap.exists()) throw new Error('Producto no encontrado durante la venta.');
        const data = prodSnap.data();
        const stockActual = data.stock || 0;
        if (stockActual < cantidad) {
          throw new Error(`Stock insuficiente para ${data.nombre || 'un producto'}. Disponible: ${stockActual}`);
        }
        productosTx.push({ ref: prodRef, id: productoId, stock: stockActual, cantidad });
      }

      tx.set(nuevaVentaRef, ventaData);
      productosTx.forEach(p => {
        const nuevoStock = p.stock - p.cantidad;
        nuevosStocks[p.id] = nuevoStock;
        tx.update(p.ref, { stock: nuevoStock });
      });
    });
  } catch (e) {
    alert(e.message || 'No se pudo registrar la venta.');
    return;
  }

  if (_productosCache) {
    Object.entries(nuevosStocks).forEach(([id, stock]) => {
      const idx = _productosCache.findIndex(p => p.id === id);
      if (idx >= 0) _productosCache[idx].stock = stock;
    });
    productos = _productosCache;
  }
  const ventaLocal = { id: nuevaVentaRef.id, ...ventaData, fecha: ahora };
  agregarVentaCache(fechaKey, ventaLocal);
  aplicarResumenLocal(fechaKey, { totalDelta: total, countDelta: 1, gananciaDelta: ganancia });
  ajustarResumenDia(fechaKey, { totalDelta: total, countDelta: 1, gananciaDelta: ganancia });

  showMsg('venta-msg', `Venta registrada. Total: ${fmtCOP(total)}`, 'ok');
  if (confirm('Venta registrada. Â¿Descargar factura PDF?')) {
    await imprimirFactura(nuevaVentaRef.id);
  }
  limpiarCarrito();
};

/* ═══════════════════════════════════════════════════════
   FACTURA
═══════════════════════════════════════════════════════ */
window.imprimirFactura = async function(ventaId) {
  const ventaSnap = await getDoc(doc(db(), 'ventas', ventaId));
  if (!ventaSnap.exists()) { alert('Venta no encontrada'); return; }
  const v = ventaSnap.data();

  // Usar caché de ajustes
  let aj = _ajustesCache;
  if (!aj) {
    const ajSnap = await getDoc(doc(db(), 'ajustes', 'negocio'));
    aj = ajSnap.exists() ? ajSnap.data() : {};
    _ajustesCache = aj;
  }

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <title>Factura</title>
    <style>
      body { font-family: monospace; max-width: 320px; margin: 0 auto; padding: 16px; font-size: 13px; }
      h2   { text-align: center; margin: 0 0 4px; }
      p    { margin: 2px 0; text-align: center; color: #555; font-size: 11px; }
      hr   { border: none; border-top: 1px dashed #999; margin: 10px 0; }
      table { width: 100%; border-collapse: collapse; }
      td   { padding: 3px 0; }
      .right { text-align: right; }
      .total { font-size: 16px; font-weight: bold; }
      .anulada { color: red; text-align: center; font-weight: bold; font-size: 15px; }
    </style>
  </head><body>
    <h2>${aj.nombre_negocio || 'Miscelánea'}</h2>
    ${aj.nit ? `<p>NIT: ${aj.nit}</p>` : ''}
    <p>${aj.direccion || ''}</p>
    <p>${aj.telefono  || ''}</p>
    <hr/>
    ${v.anulada ? '<p class="anulada">⚠ VENTA ANULADA</p><hr/>' : ''}
    <p>Fecha: ${fmtFechaHora(v.fecha)}</p>
    <p>Pago: ${labelMedioPago(v.medio_pago)}</p>
    <hr/>
    <table>
      <tr><td><strong>Producto</strong></td><td class="right"><strong>Cant.</strong></td><td class="right"><strong>Precio</strong></td><td class="right"><strong>Subtotal</strong></td></tr>
      ${(v.items || []).map(i => `<tr>
        <td>${i.nombre_producto}</td>
        <td class="right">${i.cantidad}</td>
        <td class="right">${fmtCOP(i.precio_unitario)}</td>
        <td class="right">${fmtCOP(i.cantidad * i.precio_unitario)}</td>
      </tr>`).join('')}
    </table>
    <hr/>
    ${v.descuento > 0 ? `<p>Descuento: -${fmtCOP(v.descuento)}</p>` : ''}
    <p class="total">TOTAL: ${fmtCOP(v.total)}</p>
    ${v.efectivo > 0 ? `<p>Efectivo: ${fmtCOP(v.efectivo)} · Vuelto: ${fmtCOP(v.vuelto)}</p>` : ''}
    <hr/>
    <p>¡Gracias por su compra!</p>
    <script>window.onload=()=>{ window.print(); }<\/script>
  </body></html>`);
  win.document.close();
};

/* ═══════════════════════════════════════════════════════
   CALENDARIO
═══════════════════════════════════════════════════════ */
window.renderCalendario = async function() {
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  $('cal-label').textContent = `${meses[calMes-1]} ${calAnio}`;

  const ventasPorDia = {};
  const resumenesMes = await getResumenesMes(calAnio, calMes);
  resumenesMes.forEach(r => {
    if ((r.num_ventas || 0) <= 0) return;
    ventasPorDia[r.fecha] = {
      total: r.total_ventas || 0,
      num_ventas: r.num_ventas || 0
    };
  });

  const primerDia = new Date(calAnio, calMes - 1, 1).getDay();
  const diasEnMes = new Date(calAnio, calMes, 0).getDate();
  const hoy       = new Date();
  const esHoy     = d => hoy.getFullYear() === calAnio && hoy.getMonth()+1 === calMes && hoy.getDate() === d;

  let html = `<div class="cal-grid">
    ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
    ${Array(primerDia).fill('<div class="cal-cell empty"></div>').join('')}`;

  for (let d = 1; d <= diasEnMes; d++) {
    const key  = `${calAnio}-${String(calMes).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const info = ventasPorDia[key];
    const cls  = ['cal-cell', info ? 'has-sales' : '', esHoy(d) ? 'today' : ''].filter(Boolean).join(' ');
    html += `<div class="${cls}" onclick="verVentasDia('${key}', ${d})">
      <div class="cal-day-num">${d}</div>
      ${info ? `<div class="cal-total">${fmtCOP(info.total)}</div><div class="cal-txs">${info.num_ventas} venta${info.num_ventas>1?'s':''}</div>` : ''}
    </div>`;
  }
  html += '</div>';
  $('cal-grid').innerHTML = html;
  $('cal-detalle').style.display = 'none';
};

window.verVentasDia = async function(fecha, dia) {
  const todasVentas = await getVentasPorFecha(fecha);
  $('cal-detalle-titulo').textContent = `Ventas del ${dia}`;
  const tbody = $('cal-detalle-body');
  if (todasVentas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin ventas este día</td></tr>';
  } else {
    tbody.innerHTML = todasVentas.map((v, i) => {
      const anulada   = v.anulada === true;
      const rowStyle  = anulada ? 'opacity:0.45;text-decoration:line-through' : '';
      const btnAnular = anulada
        ? `<span style="color:var(--red,#ff6b6b);font-size:11px;font-weight:600">ANULADA</span>`
        : `<button class="btn-icon del" onclick="anularVenta('${v.id}')">Anular</button>`;
      return `<tr style="${rowStyle}">
        <td>#${i + 1}</td>
        <td>${fmtHora(v.fecha)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen || '—'}</td>
        <td><span class="badge" style="font-size:11px">${labelMedioPago(v.medio_pago)}</span></td>
        <td>${v.descuento > 0 ? fmtCOP(v.descuento) : '—'}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td style="display:flex;gap:6px;align-items:center">
          <button class="btn-icon" onclick="imprimirFactura('${v.id}')">PDF</button>
          ${btnAnular}
        </td>
      </tr>`;
    }).join('');
  }
  $('cal-detalle').style.display = 'block';
  $('cal-detalle').scrollIntoView({ behavior: 'smooth' });
};

window.cambiarMes = function(delta) {
  calMes += delta;
  if (calMes > 12) { calMes = 1; calAnio++; }
  if (calMes < 1)  { calMes = 12; calAnio--; }
  renderCalendario();
};

/* ═══════════════════════════════════════════════════════
   INFORMES
═══════════════════════════════════════════════════════ */
window.cargarInformes = async function() {
  const desde = $('inf-desde').value;
  const hasta = $('inf-hasta').value;
  if (!desde || !hasta) { alert('Selecciona un rango de fechas'); return; }

  const todasVentas = await getVentasRango(desde, hasta);
  const ventas = todasVentas.filter(v => !v.anulada);
  const total  = ventas.reduce((s, v) => s + (v.total || 0), 0);

  $('inf-num').textContent   = ventas.length;
  $('inf-total').textContent = fmtCOP(total);
  $('inf-resumen').style.display = 'grid';

  const cont = $('inf-lista');
  if (todasVentas.length === 0) {
    cont.innerHTML = '<div class="empty">Sin ventas en el período seleccionado</div>';
    return;
  }
  cont.innerHTML = todasVentas.map(v => {
    const anulada    = v.anulada === true;
    const cardStyle  = anulada ? 'opacity:0.5' : '';
    const badgeAn    = anulada ? `<span style="color:var(--red,#ff6b6b);font-size:11px;font-weight:700;margin-left:8px">ANULADA</span>` : '';
    const btnAnular  = anulada ? '' : `<button class="btn-icon del" onclick="anularVenta('${v.id}')">Anular</button>`;
    return `
    <div class="inf-venta-card" style="${cardStyle}">
      <div class="inf-venta-header">
        <div>
          <span class="inf-venta-id">Venta</span>
          <span class="inf-venta-hora" style="margin-left:12px">${fmtFechaHora(v.fecha)}</span>
          ${badgeAn}
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="badge" style="font-size:11px">${labelMedioPago(v.medio_pago)}</span>
          <span class="inf-venta-total" style="${anulada ? 'text-decoration:line-through' : ''}">${fmtCOP(v.total)}</span>
          <button class="btn-icon" onclick="imprimirFactura('${v.id}')">PDF</button>
          ${btnAnular}
        </div>
      </div>
      <div class="inf-venta-items">${v.productos_resumen || '—'}</div>
      ${v.descuento > 0 ? `<div class="inf-venta-desc">Descuento aplicado: ${fmtCOP(v.descuento)}</div>` : ''}
    </div>`;
  }).join('');
};

/* ═══════════════════════════════════════════════════════
   CIERRE DEL DÍA
═══════════════════════════════════════════════════════ */
window.ejecutarCierre = async function() {
  const todasVentas = await getVentasHoy();
  const ventas = todasVentas.filter(v => !v.anulada);
  if (ventas.length === 0) { alert('No hay ventas válidas registradas hoy.'); return; }

  const total         = ventas.reduce((s, v) => s + (v.total || 0), 0);
  const transacciones = ventas.length;
  const desglose      = {};

  ventas.forEach(v => {
    (v.items || []).forEach(item => {
      const k = item.nombre_producto;
      if (!desglose[k]) desglose[k] = { vendido: 0, ganancia: 0 };
      desglose[k].vendido  += item.cantidad;
      desglose[k].ganancia += item.cantidad * ((item.precio_unitario || 0) - (item.precio_compra || 0));
    });
  });

  const detalle    = Object.entries(desglose).map(([nombre, d]) => ({ nombre, ...d }));
  const ganancia   = detalle.reduce((s, d) => s + d.ganancia, 0);
  const masVendidoItem = [...detalle].sort((a, b) => b.vendido - a.vendido)[0] || null;
  const masVendido = masVendidoItem?.nombre || '---';
  const masVendidoCantidad = masVendidoItem?.vendido || 0;
  const hoy        = fechaLocal();

  await setDoc(doc(db(), 'cierres', hoy), {
    fecha: hoy, total_ventas: total,
    num_transacciones: transacciones,
    ganancia_total: ganancia, detalle,
    producto_mas_vendido: masVendido,
    producto_mas_vendido_cantidad: masVendidoCantidad,
    creado: serverTimestamp()
  });

  $('cierre-resultado').style.display = 'block';
  $('cierre-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon green">$</div><div class="stat-data"><span class="stat-val">${fmtCOP(total)}</span><span class="stat-label">Total ventas</span></div></div>
    <div class="stat-card"><div class="stat-icon blue">◎</div><div class="stat-data"><span class="stat-val">${transacciones}</span><span class="stat-label">Transacciones</span></div></div>
    <div class="stat-card"><div class="stat-icon teal">↑</div><div class="stat-data"><span class="stat-val">${fmtCOP(ganancia)}</span><span class="stat-label">Ganancia</span></div></div>
    <div class="stat-card"><div class="stat-icon amber">★</div><div class="stat-data"><span class="stat-val" style="font-size:1rem">${masVendido}</span><span class="stat-label">Mas vendido (${fmt(masVendidoCantidad)})</span></div></div>
  `;

  const tbody = $('cierre-detalle-body');
  tbody.innerHTML = detalle.length === 0
    ? '<tr><td colspan="3" class="empty">Sin datos</td></tr>'
    : detalle.map(d => `<tr><td>${d.nombre}</td><td>${d.vendido}</td><td style="color:var(--green)">${fmtCOP(d.ganancia)}</td></tr>`).join('');

  _cierresCache = null;
  _cierresCargadoEn = 0;
  loadCierreHistorial();
};

async function loadCierreHistorial() {
  let cierres = _cierresCache;
  if (!cierres || (Date.now() - _cierresCargadoEn) > CACHE_TTL_MS) {
    const snap = await getDocs(query(collection(db(), 'cierres'), orderBy('fecha', 'desc')));
    cierres = snap.docs.map(d => d.data());
    _cierresCache = cierres;
    _cierresCargadoEn = Date.now();
  }
  const tbody   = $('cierre-historial-body');
  tbody.innerHTML = cierres.length === 0
    ? '<tr><td colspan="5" class="empty">Sin cierres registrados</td></tr>'
    : cierres.map(c => `
        <tr>
          <td>${c.fecha}</td>
          <td style="color:var(--teal)">${fmtCOP(c.total_ventas)}</td>
          <td>${c.num_transacciones}</td>
          <td style="color:var(--green)">${fmtCOP(c.ganancia_total)}</td>
          <td>${escapeHtml(c.producto_mas_vendido || '---')}${c.producto_mas_vendido_cantidad ? ` (${fmt(c.producto_mas_vendido_cantidad)})` : ''}</td>
        </tr>`).join('');
}

/* ═══════════════════════════════════════════════════════
   AJUSTES
═══════════════════════════════════════════════════════ */
async function loadAjustes() {
  let data = _ajustesCache;
  if (!data) {
    const snap = await getDoc(doc(db(), 'ajustes', 'negocio'));
    data = snap.exists() ? snap.data() : {};
    _ajustesCache = data;
  }
  $('aj-nombre').value    = data.nombre_negocio || '';
  $('aj-nit').value       = data.nit || '';
  $('aj-direccion').value = data.direccion || '';
  $('aj-telefono').value  = data.telefono  || '';
}

window.guardarAjustes = async function() {
  const data = {
    nombre_negocio: $('aj-nombre').value.trim(),
    nit:            $('aj-nit').value.trim(),
    direccion:      $('aj-direccion').value.trim(),
    telefono:       $('aj-telefono').value.trim()
  };
  await setDoc(doc(db(), 'ajustes', 'negocio'), data);
  _ajustesCache = data;
  showMsg('ajustes-msg', 'Ajustes guardados correctamente.', 'ok');
};

/* ═══════════════════════════════════════════════════════
   RESPALDO BASE DE DATOS
═══════════════════════════════════════════════════════ */
const BACKUP_COLLECTIONS = [
  'productos',
  'anchetas',
  'ventas',
  'resumenes_diarios',
  'cierres',
  'ajustes',
  'etiquetas_codigos',
  'auditoria_ignorados'
];
const BACKUP_PRODUCT_SUBCOLLECTIONS = ['entradas'];
const PRODUCTOS_EXPORT_FIELDS = [
  'id',
  'nombre',
  'categoria',
  'precio_compra',
  'precio_venta',
  'stock',
  'stock_minimo',
  'codigo_barras',
  'codigos_alternativos',
  'unidad',
  'caja_activa',
  'caja_unidades',
  'caja_precio_venta',
  'caja_precio_compra',
  'caja_codigo_barras'
];
let backupImportFormato = 'json';
let backupImportPendiente = null;

function cerrarBackupMenus() {
  document.querySelectorAll('.backup-menu.open').forEach(menu => menu.classList.remove('open'));
}

window.toggleBackupMenu = function(tipo) {
  const targetId = tipo === 'import' ? 'backup-import-menu' : 'backup-export-menu';
  const target = $(targetId);
  if (!target) return;
  const abierto = target.classList.contains('open');
  cerrarBackupMenus();
  if (!abierto) target.classList.add('open');
};

window.prepararImportarRespaldo = function(formato = 'json') {
  backupImportFormato = formato;
  const input = $('backup-import-file');
  if (!input) return;
  input.value = '';
  const accepts = {
    json: '.json,application/json',
    xlsx: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel',
    csv: '.csv,text/csv'
  };
  input.accept = accepts[formato] || accepts.json;
  cerrarBackupMenus();
  input.click();
};

function descargarBlob(nombre, contenido, tipo) {
  const blob = contenido instanceof Blob ? contenido : new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function serializarValorRespaldo(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { __type: 'date', iso: value.toISOString() };
  if (typeof value?.toDate === 'function' && typeof value.seconds === 'number') {
    return {
      __type: 'timestamp',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds || 0
    };
  }
  if (Array.isArray(value)) return value.map(serializarValorRespaldo);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializarValorRespaldo(v)]));
  }
  return value;
}

function restaurarValorRespaldo(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(restaurarValorRespaldo);
  if (typeof value === 'object') {
    if (value.__type === 'timestamp' && typeof value.seconds === 'number') {
      return new Timestamp(value.seconds, value.nanoseconds || 0);
    }
    if (value.__type === 'date' && value.iso) return new Date(value.iso);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restaurarValorRespaldo(v)]));
  }
  return value;
}

async function exportarColeccionRespaldo(nombre) {
  const snap = await getDocs(collection(db(), nombre));
  const docs = [];
  for (const d of snap.docs) {
    const item = { id: d.id, data: serializarValorRespaldo(d.data()) };
    if (nombre === 'productos') {
      item.subcollections = {};
      for (const sub of BACKUP_PRODUCT_SUBCOLLECTIONS) {
        const subSnap = await getDocs(collection(db(), 'productos', d.id, sub));
        item.subcollections[sub] = subSnap.docs.map(sd => ({
          id: sd.id,
          data: serializarValorRespaldo(sd.data())
        }));
      }
    }
    docs.push(item);
  }
  return docs;
}

function descargarJsonRespaldo(data) {
  descargarBlob(
    `sistemahibrido-respaldo-${fechaLocal()}-${Date.now()}.json`,
    JSON.stringify(data, null, 2),
    'application/json;charset=utf-8'
  );
}

function contarDocsRespaldo(backup) {
  let total = 0;
  const collections = backup?.collections || {};
  BACKUP_COLLECTIONS.forEach(nombre => {
    (collections[nombre] || []).forEach(item => {
      total++;
      if (item.subcollections) {
        Object.values(item.subcollections).forEach(arr => { total += Array.isArray(arr) ? arr.length : 0; });
      }
    });
  });
  return total;
}

function productoFilaExportacion(p) {
  const caja = configCajaProducto(p);
  return {
    id: p.id || '',
    nombre: p.nombre || '',
    categoria: p.categoria || '',
    precio_compra: numeroSeguro(p.precio_compra),
    precio_venta: numeroSeguro(p.precio_venta),
    stock: numeroSeguro(p.stock),
    stock_minimo: numeroSeguro(p.stock_minimo),
    codigo_barras: limpiarCodigo(p.codigo_barras || ''),
    codigos_alternativos: codigosAlternativosProducto(p).join(', '),
    unidad: p.unidad || 'unidades',
    caja_activa: caja.activa ? 'si' : 'no',
    caja_unidades: caja.activa ? caja.unidades : '',
    caja_precio_venta: caja.activa ? caja.precio_venta : '',
    caja_precio_compra: caja.activa ? caja.precio_compra : '',
    caja_codigo_barras: caja.activa ? caja.codigo_barras : ''
  };
}

async function productosParaExportar() {
  const lista = await getProductos(true);
  productos = lista;
  return lista.map(productoFilaExportacion);
}

function csvEscape(value) {
  const texto = String(value ?? '');
  return /[;"\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function descargarCsvProductos(filas) {
  const encabezado = PRODUCTOS_EXPORT_FIELDS.join(';');
  const lineas = filas.map(row => PRODUCTOS_EXPORT_FIELDS.map(campo => csvEscape(row[campo])).join(';'));
  descargarBlob(
    `sistemahibrido-productos-${fechaLocal()}-${Date.now()}.csv`,
    '\ufeff' + [encabezado, ...lineas].join('\r\n'),
    'text/csv;charset=utf-8'
  );
}

function descargarExcelProductos(filas) {
  if (!window.XLSX?.utils) {
    throw new Error('No se cargo la libreria de Excel.');
  }
  const wb = window.XLSX.utils.book_new();
  const ws = window.XLSX.utils.json_to_sheet(filas, { header: PRODUCTOS_EXPORT_FIELDS });
  window.XLSX.utils.book_append_sheet(wb, ws, 'productos');
  window.XLSX.writeFile(wb, `sistemahibrido-productos-${fechaLocal()}-${Date.now()}.xlsx`);
}

function detectarFormatoArchivo(file) {
  const nombre = (file?.name || '').toLowerCase();
  if (nombre.endsWith('.xlsx') || nombre.endsWith('.xls')) return 'xlsx';
  if (nombre.endsWith('.csv')) return 'csv';
  return backupImportFormato || 'json';
}

function normalizarHeaderImportacion(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function valorFilaImportacion(row, aliases) {
  const normalizado = {};
  Object.entries(row || {}).forEach(([k, v]) => {
    normalizado[normalizarHeaderImportacion(k)] = v;
  });
  for (const alias of aliases) {
    const key = normalizarHeaderImportacion(alias);
    if (normalizado[key] !== undefined && normalizado[key] !== null && String(normalizado[key]).trim() !== '') {
      return normalizado[key];
    }
  }
  return undefined;
}

function numeroImportacion(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  let texto = String(value).trim().replace(/[^\d,.-]/g, '');
  if (!texto) return undefined;
  const coma = texto.lastIndexOf(',');
  const punto = texto.lastIndexOf('.');
  if (coma >= 0 && punto >= 0) {
    texto = coma > punto
      ? texto.replace(/\./g, '').replace(',', '.')
      : texto.replace(/,/g, '');
  } else if (coma >= 0) {
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(texto)) {
    texto = texto.replace(/\./g, '');
  }
  const n = Number(texto);
  return Number.isFinite(n) ? n : undefined;
}

function textoImportacion(value) {
  if (value === undefined || value === null) return undefined;
  const texto = String(value).trim();
  return texto ? texto : undefined;
}

function booleanImportacion(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return booleanCajaActiva(value);
}

function codigosAlternativosImportacion(value, codigoPrincipal = '') {
  const principal = limpiarCodigo(codigoPrincipal);
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,\n;|]+/);
  const vistos = new Set(principal ? [principal] : []);
  return raw
    .map(limpiarCodigo)
    .filter(codigo => {
      if (!codigo || vistos.has(codigo)) return false;
      vistos.add(codigo);
      return true;
    });
}

function normalizarProductoImportacion(row) {
  const id = textoImportacion(valorFilaImportacion(row, ['id', 'doc_id', 'documento_id']));
  const nombre = textoImportacion(valorFilaImportacion(row, ['nombre', 'producto', 'name']));
  const categoria = textoImportacion(valorFilaImportacion(row, ['categoria', 'categoría', 'category']));
  const unidad = textoImportacion(valorFilaImportacion(row, ['unidad', 'unit']));
  const codigo = limpiarCodigo(valorFilaImportacion(row, ['codigo_barras', 'codigo barras', 'codigo', 'código', 'barcode', 'ean']) || '');
  const alternativos = codigosAlternativosImportacion(
    valorFilaImportacion(row, ['codigos_alternativos', 'codigos alternativos', 'codigo_alternativo', 'codigo alternativo', 'barcodes_alt', 'alternate_barcodes']),
    codigo
  );
  const data = {};

  if (nombre !== undefined) data.nombre = nombre;
  if (categoria !== undefined) data.categoria = categoria;
  if (unidad !== undefined) data.unidad = unidad;
  if (codigo) data.codigo_barras = codigo;
  if (alternativos.length > 0) data.codigos_alternativos = alternativos;

  const compra = numeroImportacion(valorFilaImportacion(row, ['precio_compra', 'p_compra', 'compra', 'costo']));
  const venta = numeroImportacion(valorFilaImportacion(row, ['precio_venta', 'p_venta', 'venta', 'precio']));
  const stock = numeroImportacion(valorFilaImportacion(row, ['stock', 'cantidad', 'existencias']));
  const cajaActiva = booleanImportacion(valorFilaImportacion(row, ['caja_activa', 'venta_caja_activa', 'aplica_caja', 'vende_caja']));
  const cajaUnidades = numeroImportacion(valorFilaImportacion(row, ['caja_unidades', 'unidades_por_caja', 'unidades caja', 'unds caja']));
  const cajaVenta = numeroImportacion(valorFilaImportacion(row, ['caja_precio_venta', 'precio_venta_caja', 'venta_caja']));
  const cajaCompra = numeroImportacion(valorFilaImportacion(row, ['caja_precio_compra', 'precio_compra_caja', 'compra_caja']));
  const cajaCodigo = limpiarCodigo(valorFilaImportacion(row, ['caja_codigo_barras', 'codigo_barras_caja', 'codigo caja', 'barcode caja']) || '');
  const stockMin = numeroImportacion(valorFilaImportacion(row, ['stock_minimo', 'stock minimo', 'minimo', 'mínimo', 'min']));

  if (compra !== undefined) data.precio_compra = compra;
  if (venta !== undefined) data.precio_venta = venta;
  if (stock !== undefined) data.stock = stock;
  if (stockMin !== undefined) data.stock_minimo = stockMin;
  if (cajaActiva !== undefined) data.caja_activa = cajaActiva;
  if (cajaUnidades !== undefined) data.caja_unidades = cajaUnidades;
  if (cajaVenta !== undefined) data.caja_precio_venta = cajaVenta;
  if (cajaCompra !== undefined) data.caja_precio_compra = cajaCompra;
  if (cajaCodigo) data.caja_codigo_barras = cajaCodigo;
  if (data.caja_activa === undefined && (cajaUnidades !== undefined || cajaVenta !== undefined || cajaCodigo)) {
    data.caja_activa = (cajaUnidades || 0) > 0 && (cajaVenta || 0) > 0;
  }

  return { id, codigo, nombre, categoria, data };
}

function keyNombreCategoria(nombre, categoria) {
  return `${String(nombre || '').trim().toLowerCase()}|${String(categoria || '').trim().toLowerCase()}`;
}

function parseCsvProductos(text) {
  const sample = (text.split(/\r?\n/)[0] || '');
  const delimiter = (sample.match(/;/g) || []).length >= (sample.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.length > 1 || row[0]) rows.push(row);

  if (rows.length === 0) return [];
  const headers = rows.shift().map(h => h.replace(/^\ufeff/, '').trim());
  return rows
    .filter(r => r.some(c => String(c || '').trim()))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

async function filasDesdeArchivoProductos(file, formato) {
  if (formato === 'xlsx') {
    if (!window.XLSX?.read) throw new Error('No se cargo la libreria de Excel.');
    const buffer = await file.arrayBuffer();
    const wb = window.XLSX.read(buffer, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    return window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  }
  if (formato === 'csv') {
    return parseCsvProductos(await file.text());
  }

  const json = JSON.parse(await file.text());
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.productos)) return json.productos;
  if (Array.isArray(json.items)) return json.items;
  return null;
}

function analizarImportacionProductos(filas, existentes, origen = 'archivo') {
  if (!Array.isArray(filas) || filas.length === 0) {
    return { origen, operaciones: [], errores: ['El archivo no tiene productos para importar.'], sinCambios: 0 };
  }

  const byId = new Map(existentes.map(p => [p.id, p]));
  const byCode = new Map();
  const byNameCat = new Map();
  existentes.forEach(p => {
    codigosProducto(p).forEach(code => {
      if (code && !byCode.has(code)) byCode.set(code, p);
    });
    const key = keyNombreCategoria(p.nombre, p.categoria);
    if (key !== '|' && !byNameCat.has(key)) byNameCat.set(key, p);
  });

  const operaciones = [];
  const errores = [];
  const idsArchivo = new Map();
  const codigosArchivo = new Map();
  let sinCambios = 0;

  filas.forEach((row, index) => {
    const parsed = normalizarProductoImportacion(row);
    if (!parsed.id && !parsed.codigo && !parsed.nombre && Object.keys(parsed.data).length === 0) return;
    const codigosParsed = [parsed.codigo, parsed.data.caja_codigo_barras, ...(parsed.data.codigos_alternativos || [])]
      .map(limpiarCodigo)
      .filter(Boolean);
    if (parsed.id) {
      if (idsArchivo.has(parsed.id)) {
        errores.push(`Fila ${index + 2}: id repetido con fila ${idsArchivo.get(parsed.id)}.`);
        return;
      }
      idsArchivo.set(parsed.id, index + 2);
    }
    for (const codigoArchivo of codigosParsed) {
      if (codigosArchivo.has(codigoArchivo)) {
        errores.push(`Fila ${index + 2}: codigo ${codigoArchivo} repetido con fila ${codigosArchivo.get(codigoArchivo)}.`);
        return;
      }
      codigosArchivo.set(codigoArchivo, index + 2);
    }

    let target = parsed.id ? byId.get(parsed.id) : null;
    const codigoExistente = codigosParsed.find(codigo => byCode.has(codigo));
    const productoPorCodigo = codigoExistente ? byCode.get(codigoExistente) : null;
    if (target && productoPorCodigo && productoPorCodigo.id !== target.id) {
      errores.push(`Fila ${index + 2}: codigo ${codigoExistente} ya pertenece a ${productoPorCodigo.nombre}.`);
      return;
    }
    if (!target && productoPorCodigo) target = productoPorCodigo;
    if (!target && parsed.nombre) target = byNameCat.get(keyNombreCategoria(parsed.nombre, parsed.categoria));

    if (!target && !parsed.nombre) {
      errores.push(`Fila ${index + 2}: falta nombre para crear producto.`);
      return;
    }

    const data = { ...parsed.data };
    if (target) {
      if (Object.keys(data).length === 0) {
        sinCambios++;
        return;
      }
      operaciones.push({
        tipo: 'actualizar',
        id: target.id,
        nombre: data.nombre || target.nombre || parsed.nombre || 'Producto',
        data
      });
    } else {
      operaciones.push({
        tipo: 'crear',
        id: parsed.id || null,
        nombre: data.nombre || parsed.nombre || 'Producto nuevo',
        data: {
          nombre: data.nombre || parsed.nombre,
          categoria: data.categoria || '',
          precio_compra: data.precio_compra ?? 0,
          precio_venta: data.precio_venta ?? 0,
          stock: data.stock ?? 0,
          stock_minimo: data.stock_minimo ?? 5,
          codigo_barras: data.codigo_barras || '',
          codigos_alternativos: data.codigos_alternativos || [],
          unidad: data.unidad || 'unidades',
          fecha_creacion: serverTimestamp()
        }
      });
    }
  });

  return { origen, operaciones, errores, sinCambios };
}

function mostrarBackupHtml(html) {
  const el = $('backup-msg');
  if (el) el.innerHTML = html;
}

function renderPreviewImportacionProductos(analisis) {
  backupImportPendiente = null;

  if (analisis.errores.length > 0) {
    mostrarBackupHtml(`<div class="msg error">
      <strong>No se importo nada.</strong><br/>
      ${analisis.errores.slice(0, 6).map(e => `<div>${escapeHtml(e)}</div>`).join('')}
      ${analisis.errores.length > 6 ? `<div>Y ${analisis.errores.length - 6} error(es) mas.</div>` : ''}
    </div>`);
    console.warn('Errores de importacion de productos:', analisis.errores);
    return;
  }

  const crear = analisis.operaciones.filter(op => op.tipo === 'crear').length;
  const actualizar = analisis.operaciones.filter(op => op.tipo === 'actualizar').length;
  if (analisis.operaciones.length === 0) {
    showMsg('backup-msg', 'No hay cambios para importar.', 'warn');
    return;
  }

  backupImportPendiente = { tipo: 'productos', analisis };
  const muestra = analisis.operaciones.slice(0, 8).map(op =>
    `<div>${op.tipo === 'crear' ? 'Crear' : 'Actualizar'}: <strong>${escapeHtml(op.nombre)}</strong></div>`
  ).join('');
  mostrarBackupHtml(`<div class="msg ok">
    <strong>Previsualizacion lista: ${analisis.operaciones.length} producto(s).</strong><br/>
    Nuevos: ${crear}. Actualizados: ${actualizar}. Sin cambios: ${analisis.sinCambios}.<br/>
    <div style="margin-top:8px">${muestra}${analisis.operaciones.length > 8 ? `<div>Y ${analisis.operaciones.length - 8} mas.</div>` : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn-primary" onclick="confirmarImportacionPendiente()">Confirmar importacion</button>
      <button class="btn-secondary" onclick="cancelarImportacionPendiente()">Cancelar</button>
    </div>
  </div>`);
}

function actualizarProductosCacheImportacion(aplicadas) {
  if (!_productosCache) return;
  aplicadas.forEach(op => {
    const idx = _productosCache.findIndex(p => p.id === op.id);
    if (idx >= 0) {
      _productosCache[idx] = { ..._productosCache[idx], ...op.data };
    } else {
      _productosCache.push({ id: op.id, ...op.data });
    }
  });
  productos = _productosCache;
  _productosCargadoEn = Date.now();
}

async function aplicarImportacionProductos(analisis) {
  const operaciones = analisis.operaciones;

  let batch = writeBatch(db());
  let ops = 0;
  const aplicadas = [];
  for (const op of operaciones) {
    const ref = op.tipo === 'crear'
      ? (op.id ? doc(db(), 'productos', op.id) : doc(collection(db(), 'productos')))
      : doc(db(), 'productos', op.id);
    batch.set(ref, op.data, { merge: true });
    aplicadas.push({ ...op, id: ref.id });
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = writeBatch(db());
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  actualizarProductosCacheImportacion(aplicadas);
  renderInventarioPaginado();
  if ($('tab-auditoria')?.classList.contains('active')) renderAuditoria(calcularAuditoria());
  if ($('tab-dashboard')?.classList.contains('active')) loadDashboard();
  actualizarCategoriasCodigo();
  const crear = operaciones.filter(op => op.tipo === 'crear').length;
  const actualizar = operaciones.filter(op => op.tipo === 'actualizar').length;
  showMsg('backup-msg', `Productos importados: ${crear} nuevos, ${actualizar} actualizados.`, 'ok');
}

async function importarProductosDesdeFilas(filas, origen = 'archivo') {
  showMsg('backup-msg', 'Preparando previsualizacion...', 'ok');
  const existentes = await getProductos(true);
  const analisis = analizarImportacionProductos(filas, existentes, origen);
  renderPreviewImportacionProductos(analisis);
}

async function exportarRespaldoJsonCompleto() {
  showMsg('backup-msg', 'Preparando respaldo JSON completo...', 'ok');
  try {
    const backup = {
      sistema: 'sistemahibrido',
      version: 1,
      exportado_en: new Date().toISOString(),
      collections: {}
    };

    for (const nombre of BACKUP_COLLECTIONS) {
      backup.collections[nombre] = await exportarColeccionRespaldo(nombre);
    }

    descargarJsonRespaldo(backup);
    showMsg('backup-msg', `Respaldo exportado: ${contarDocsRespaldo(backup)} registros.`, 'ok');
  } catch (e) {
    console.warn('No se pudo exportar respaldo:', e.message || e);
    showMsg('backup-msg', 'No se pudo exportar el respaldo.', 'error');
  }
}

window.exportarRespaldoBaseDatos = async function(formato = 'json') {
  cerrarBackupMenus();
  if (formato === 'json') {
    await exportarRespaldoJsonCompleto();
    return;
  }
  try {
    showMsg('backup-msg', 'Preparando productos...', 'ok');
    const filas = await productosParaExportar();
    if (formato === 'xlsx') descargarExcelProductos(filas);
    else descargarCsvProductos(filas);
    showMsg('backup-msg', `Productos exportados: ${filas.length}.`, 'ok');
  } catch (e) {
    console.warn('No se pudieron exportar productos:', e.message || e);
    showMsg('backup-msg', 'No se pudieron exportar los productos.', 'error');
  }
};

async function importarDocsRespaldo(backup) {
  const collections = backup.collections || {};
  let batch = writeBatch(db());
  let ops = 0;
  let total = 0;

  const commitSiNecesario = async (forzar = false) => {
    if (ops > 0 && (forzar || ops >= 450)) {
      await batch.commit();
      batch = writeBatch(db());
      ops = 0;
    }
  };

  const agregarSet = async (ref, data) => {
    batch.set(ref, restaurarValorRespaldo(data || {}), { merge: true });
    ops++;
    total++;
    await commitSiNecesario();
  };

  for (const nombre of BACKUP_COLLECTIONS) {
    const items = Array.isArray(collections[nombre]) ? collections[nombre] : [];
    for (const item of items) {
      if (!item?.id) continue;
      await agregarSet(doc(db(), nombre, item.id), item.data);

      if (nombre === 'productos' && item.subcollections) {
        for (const sub of BACKUP_PRODUCT_SUBCOLLECTIONS) {
          const subItems = Array.isArray(item.subcollections[sub]) ? item.subcollections[sub] : [];
          for (const subItem of subItems) {
            if (!subItem?.id) continue;
            await agregarSet(doc(db(), 'productos', item.id, sub, subItem.id), subItem.data);
          }
        }
      }
    }
  }

  await commitSiNecesario(true);
  return total;
}

/* ═══════════════════════════════════════════════════════
   IMPORTACION RESPALDO
═══════════════════════════════════════════════════════ */
async function aplicarImportacionJsonCompleta(backup) {
  showMsg('backup-msg', 'Importando respaldo en Firebase...', 'ok');
  const importados = await importarDocsRespaldo(backup);
  invalidarProductos();
  _anchetasCache = null;
  _ajustesCache = null;
  _cierresCache = null;
  auditoriaIgnoradosCargados = false;
  invalidarVentasCache();
  productos = await getProductos(true);
  anchetas = await getAnchetas(true);
  renderInventarioPaginado();
  if ($('tab-dashboard')?.classList.contains('active')) loadDashboard();
  showMsg('backup-msg', `Respaldo importado: ${importados} registros.`, 'ok');
}

window.confirmarImportacionPendiente = async function() {
  const pendiente = backupImportPendiente;
  if (!pendiente) {
    showMsg('backup-msg', 'No hay una importacion pendiente.', 'warn');
    return;
  }
  backupImportPendiente = null;
  try {
    if (pendiente.tipo === 'json') await aplicarImportacionJsonCompleta(pendiente.backup);
    else if (pendiente.tipo === 'productos') await aplicarImportacionProductos(pendiente.analisis);
  } catch (e) {
    console.warn('No se pudo confirmar importacion:', e.message || e);
    showMsg('backup-msg', 'No se pudo importar. Revisa conexion y formato.', 'error');
  }
};

window.cancelarImportacionPendiente = function() {
  backupImportPendiente = null;
  showMsg('backup-msg', 'Importacion cancelada. No se cambio nada en Firebase.', 'warn');
};

async function importarRespaldoJsonCompleto(file) {
  showMsg('backup-msg', 'Leyendo respaldo...', 'ok');
  const backup = JSON.parse(await file.text());
  if (backup?.sistema !== 'sistemahibrido' || !backup.collections) {
    showMsg('backup-msg', 'El archivo no parece ser un respaldo valido de SistemaHibrido.', 'error');
    return;
  }

  const total = contarDocsRespaldo(backup);
  backupImportPendiente = { tipo: 'json', backup };
  mostrarBackupHtml(`<div class="msg ok">
    <strong>Previsualizacion JSON completo</strong><br/>
    Registros que se van a crear o actualizar: ${total}.<br/>
    Colecciones incluidas: ${BACKUP_COLLECTIONS.filter(c => backup.collections?.[c]).join(', ')}.<br/>
    No se borraran registros que no esten en el archivo.
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn-primary" onclick="confirmarImportacionPendiente()">Confirmar importacion JSON</button>
      <button class="btn-secondary" onclick="cancelarImportacionPendiente()">Cancelar</button>
    </div>
  </div>`);
}

window.importarRespaldoBaseDatos = async function(event) {
  const input = event?.target;
  const file = input?.files?.[0];
  if (!file) return;

  const formato = detectarFormatoArchivo(file);
  try {
    if (formato === 'json') {
      const text = await file.text();
      const json = JSON.parse(text);
      if (json?.sistema === 'sistemahibrido' && json.collections) {
        const jsonFile = new File([text], file.name, { type: file.type || 'application/json' });
        await importarRespaldoJsonCompleto(jsonFile);
      } else {
        const filas = Array.isArray(json) ? json : (json.productos || json.items || null);
        await importarProductosDesdeFilas(filas, 'JSON productos');
      }
    } else {
      showMsg('backup-msg', `Leyendo ${formato === 'xlsx' ? 'Excel' : 'CSV'}...`, 'ok');
      const filas = await filasDesdeArchivoProductos(file, formato);
      await importarProductosDesdeFilas(filas, formato === 'xlsx' ? 'Excel' : 'CSV');
    }
  } catch (e) {
    console.warn('No se pudo importar archivo:', e.message || e);
    showMsg('backup-msg', 'No se pudo importar el archivo. Revisa el formato.', 'error');
  } finally {
    if (input) input.value = '';
  }
};

/* ANCHETAS */
let editandoAnchetaId = null;
let itemsAncheta      = [];

async function loadAnchetas() {
  anchetas = await getAnchetas(true);   // forzar recarga solo al entrar al tab
  renderAnchetas();
}

function renderAnchetas() {
  const tbody = $('anch-body');
  if (anchetas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No hay anchetas registradas</td></tr>';
    return;
  }
  tbody.innerHTML = anchetas.map(a => `
    <tr>
      <td><strong>${a.nombre}</strong></td>
      <td style="color:var(--muted);font-size:0.85rem">${(a.items||[]).map(i=>`${i.nombre_producto} x${i.cantidad}`).join(', ')}</td>
      <td><strong style="color:var(--teal)">${fmtCOP(a.precio_venta)}</strong></td>
      <td style="display:flex;gap:6px">
        <button class="btn-icon" onclick="openModalAncheta('${a.id}')">Editar</button>
        <button class="btn-icon del" onclick="eliminarAncheta('${a.id}')">Eliminar</button>
      </td>
    </tr>`).join('');
}

window.openModalAncheta = function(id) {
  editandoAnchetaId = id || null;
  $('anch-modal-titulo').textContent = id ? 'Editar Ancheta' : 'Nueva Ancheta';
  $('anch-msg').innerHTML = '';

  if (id) {
    const a = anchetas.find(x => x.id === id);
    if (a) {
      $('anch-nombre').value = a.nombre;
      $('anch-precio').value = a.precio_venta;
      itemsAncheta = [...(a.items || [])];
    }
  } else {
    $('anch-nombre').value = '';
    $('anch-precio').value = '';
    itemsAncheta = [];
  }
  renderItemsAncheta();
  openModal('modal-ancheta');
};

function renderItemsAncheta() {
  const cont = $('anch-items-lista');
  cont.innerHTML = itemsAncheta.length === 0
    ? '<div class="empty" style="padding:12px">Sin productos aún</div>'
    : itemsAncheta.map((it, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="flex:1">${it.nombre_producto}</span>
          <input type="number" min="1" value="${it.cantidad}" style="width:70px"
            onchange="actualizarCantAncheta(${i}, this.value)"/>
          <button class="btn-icon del" onclick="quitarItemAncheta(${i})">✕</button>
        </div>`).join('');
}

window.actualizarCantAncheta = function(i, val) {
  const v = parseFloat(val);
  if (v > 0) itemsAncheta[i].cantidad = v;
};
window.quitarItemAncheta = function(i) { itemsAncheta.splice(i, 1); renderItemsAncheta(); };

window.buscarProductoAncheta = function() {
  const q    = $('anch-buscar').value.trim();
  const cont = $('anch-sugerencias');
  if (q.length < 1) { cont.innerHTML = ''; return; }
  const filtrados = productos.filter(p => p.nombre.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  cont.innerHTML = filtrados.length === 0
    ? '<div style="color:var(--muted);padding:8px">Sin resultados</div>'
    : filtrados.map(p => `
        <div class="sugerencia-item" onclick="agregarProductoAncheta('${p.id}','${p.nombre.replace(/'/g,"\\'")}')">
          <span>${p.nombre}</span>
          <span class="sug-stock">${p.stock} ${p.unidad}</span>
        </div>`).join('');
};

window.agregarProductoAncheta = function(pid, nombre) {
  const existe = itemsAncheta.find(i => i.producto_id === pid);
  if (existe) { existe.cantidad += 1; }
  else { itemsAncheta.push({ producto_id: pid, nombre_producto: nombre, cantidad: 1 }); }
  $('anch-buscar').value = '';
  $('anch-sugerencias').innerHTML = '';
  renderItemsAncheta();
};

window.guardarAncheta = async function() {
  const nombre       = $('anch-nombre').value.trim();
  const precio_venta = parseFloat($('anch-precio').value);
  if (!nombre || isNaN(precio_venta)) { showMsg('anch-msg', 'Nombre y precio son obligatorios.', 'error'); return; }
  if (itemsAncheta.length === 0)      { showMsg('anch-msg', 'Agrega al menos un producto.', 'error'); return; }

  const data = { nombre, precio_venta, items: itemsAncheta };
  if (editandoAnchetaId) {
    await updateDoc(doc(db(), 'anchetas', editandoAnchetaId), data);
    showMsg('anch-list-msg', 'Ancheta actualizada.', 'ok');
  } else {
    data.fecha_creacion = serverTimestamp();
    await addDoc(collection(db(), 'anchetas'), data);
    showMsg('anch-list-msg', 'Ancheta creada.', 'ok');
  }
  invalidarAnchetas();
  anchetas = await getAnchetas(true);
  closeModal('modal-ancheta');
  renderAnchetas();
};

window.eliminarAncheta = async function(id) {
  if (!confirm('¿Eliminar esta ancheta?')) return;
  await deleteDoc(doc(db(), 'anchetas', id));
  invalidarAnchetas();
  anchetas = anchetas.filter(a => a.id !== id);
  if (_anchetasCache) _anchetasCache = _anchetasCache.filter(a => a.id !== id);
  showMsg('anch-list-msg', 'Ancheta eliminada.', 'warn');
  renderAnchetas();
};

/* ═══════════════════════════════════════════════════════
   CÓDIGOS DE BARRAS
═══════════════════════════════════════════════════════ */
function productoCodigoSeleccionado() {
  return productos.find(p => p.id === codigoProductoId) || null;
}

function limpiarCodigo(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
}

function codigosAlternativosProducto(p) {
  const raw = p?.codigos_alternativos ?? p?.codigosAlternativos ?? p?.codigo_alternativo ?? p?.codigos_extra ?? '';
  const lista = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[,\n;|]+/);
  const vistos = new Set();
  return lista
    .map(limpiarCodigo)
    .filter(codigo => {
      if (!codigo || vistos.has(codigo)) return false;
      vistos.add(codigo);
      return true;
    });
}

function codigosProducto(p, incluirPrincipal = true, incluirCaja = true) {
  const vistos = new Set();
  const lista = [];
  const agregar = codigo => {
    const limpio = limpiarCodigo(codigo);
    if (!limpio || vistos.has(limpio)) return;
    vistos.add(limpio);
    lista.push(limpio);
  };
  if (incluirPrincipal) agregar(p?.codigo_barras || '');
  if (incluirCaja) agregar(codigoCajaProducto(p));
  codigosAlternativosProducto(p).forEach(agregar);
  return lista;
}

function productoTieneCodigo(p, codigo) {
  const buscado = limpiarCodigo(codigo);
  return !!buscado && codigosProducto(p).includes(buscado);
}

function productoConCodigo(codigo, exceptoId = null) {
  const buscado = limpiarCodigo(codigo);
  if (!buscado) return null;
  return productos.find(p => p.id !== exceptoId && productoTieneCodigo(p, buscado)) || null;
}

async function productoDuplicadoPorCodigoFirebase(codigo, exceptoId = null) {
  const buscado = limpiarCodigo(codigo);
  if (!buscado) return null;

  const local = productoConCodigo(buscado, exceptoId);
  if (local) return local;

  const consultas = [
    query(collection(db(), 'productos'), where('codigo_barras', '==', buscado), limit(3)),
    query(collection(db(), 'productos'), where('codigos_alternativos', 'array-contains', buscado), limit(3)),
    query(collection(db(), 'productos'), where('caja_codigo_barras', '==', buscado), limit(3))
  ];
  const snaps = await Promise.all(consultas.map(q => getDocs(q)));
  for (const snap of snaps) {
    const docRepetido = snap.docs.find(d => d.id !== exceptoId);
    if (docRepetido) return { id: docRepetido.id, ...docRepetido.data() };
  }
  return null;
}

function codigoProductoActual(p) {
  return limpiarCodigo(p?.codigo_barras || '');
}

function etiquetasCodigoRef() {
  return collection(db(), 'etiquetas_codigos');
}

function codigosOcupados() {
  const usados = new Set();
  productos.forEach(p => {
    codigosProducto(p).forEach(codigo => usados.add(codigo));
  });
  etiquetasCodigo.forEach(item => {
    const codigo = limpiarCodigo(item.codigo);
    if (codigo) usados.add(codigo);
  });
  return usados;
}

function categoriaKeyCodigo(categoria) {
  return String(categoria || '').trim().toLowerCase();
}

function categoriasCodigoDisponibles() {
  const mapa = new Map();
  productos.forEach(p => {
    const nombre = String(p.categoria || '').trim();
    const key = categoriaKeyCodigo(nombre);
    if (key && !mapa.has(key)) mapa.set(key, nombre);
  });
  return [...mapa.entries()]
    .map(([key, nombre]) => ({ key, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function categoriaCodigoSeleccionada() {
  return $('cod-categoria-filtro')?.value || '';
}

function categoriaCodigoNombre(key = categoriaCodigoSeleccionada()) {
  if (!key) return 'todas las categorias';
  const opt = [...($('cod-categoria-filtro')?.options || [])].find(o => o.value === key);
  return opt?.textContent || key;
}

function mostrarNombreLoteCodigoSeleccionado() {
  return $('cod-lote-mostrar-nombre')?.value === 'con';
}

function textoModoNombreEtiqueta(mostrarNombre) {
  return mostrarNombre ? 'con nombre' : 'sin nombre';
}

function actualizarCategoriasCodigo(preferida = categoriaCodigoSeleccionada()) {
  const select = $('cod-categoria-filtro');
  if (!select) return;
  const categorias = categoriasCodigoDisponibles();
  select.innerHTML = '<option value="">Todas las categorias</option>' +
    categorias.map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.nombre)}</option>`).join('');
  select.value = categorias.some(c => c.key === preferida) ? preferida : '';
}

window.actualizarResumenCodigoCategoria = function() {
  const categoria = categoriaCodigoSeleccionada();
  const total = productos.filter(p => codigosProducto(p).length === 0 && productoPasaCategoriaCodigo(p, categoria)).length;
  showMsg('cod-msg', `${total} producto(s) sin codigo en ${categoriaCodigoNombre(categoria)}.`, 'ok');
};

function productoPasaCategoriaCodigo(p, categoriaKey) {
  return !categoriaKey || categoriaKeyCodigo(p.categoria) === categoriaKey;
}

function siguienteCodigoSecuencial(usados = codigosOcupados()) {
  let mayor = 0;
  usados.forEach(codigo => {
    const limpio = limpiarCodigo(codigo);
    if (/^\d{5,6}$/.test(limpio)) mayor = Math.max(mayor, parseInt(limpio, 10) || 0);
  });

  let n = mayor + 1;
  let codigo = '';
  do {
    codigo = String(n).padStart(COD_SEQ_DIGITS, '0');
    n++;
  } while (productoConCodigo(codigo) || usados.has(codigo));
  return codigo;
}

function codigoUsadoEnOtraEtiqueta(codigo, productoId) {
  const buscado = limpiarCodigo(codigo);
  if (!buscado) return false;
  return etiquetasCodigo.some(item =>
    limpiarCodigo(item.codigo) === buscado && item.producto_id !== productoId);
}

function etiquetasPendientesDeProducto(productoId, codigo = '') {
  const buscado = limpiarCodigo(codigo);
  return etiquetasCodigo.filter(item =>
    item.producto_id === productoId && (!buscado || limpiarCodigo(item.codigo) === buscado));
}

function datosEtiquetaCodigo(p, codigo, mostrarNombre = false) {
  return {
    producto_id: p.id,
    nombre: p.nombre,
    codigo,
    precio_venta: p.precio_venta || 0,
    guardado_en_producto: true,
    mostrar_nombre: mostrarNombre
  };
}

function cantidadEtiquetaLoteSegura(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(100, n));
}

function codigoOcupadoPorOtro(codigo, productoId) {
  return !!productoConCodigo(codigo, productoId) || codigoUsadoEnOtraEtiqueta(codigo, productoId);
}

function construirPreviewCodigosFaltantes(faltantes) {
  const usados = codigosOcupados();
  return faltantes.map(p => {
    const codigo = crearCodigoUnico(usados);
    usados.add(codigo);
    return {
      productoId: p.id,
      nombre: p.nombre,
      categoria: p.categoria || '',
      precio_venta: p.precio_venta || 0,
      codigo,
      cantidad: 1
    };
  });
}

function construirPreviewEtiquetasExistentes(lista) {
  return lista.map(p => ({
    productoId: p.id,
    nombre: p.nombre,
    categoria: p.categoria || '',
    precio_venta: p.precio_venta || 0,
    codigo: codigoProductoActual(p),
    cantidad: 1
  }));
}

function totalEtiquetasPreview() {
  return (codigosLotePreview?.items || []).reduce((total, item) =>
    total + cantidadEtiquetaLoteSegura(item.cantidad), 0);
}

function expandirEtiquetasPreview(items, mostrarNombre) {
  const etiquetas = [];
  items.forEach(item => {
    const cantidad = cantidadEtiquetaLoteSegura(item.cantidad);
    for (let i = 0; i < cantidad; i++) {
      etiquetas.push({
        producto_id: item.productoId,
        nombre: item.nombre,
        codigo: item.codigo,
        precio_venta: item.precio_venta || 0,
        guardado_en_producto: true,
        mostrar_nombre: mostrarNombre
      });
    }
  });
  return etiquetas;
}

async function guardarEtiquetasExistentesPreview(items, mostrarNombre) {
  const etiquetas = expandirEtiquetasPreview(items, mostrarNombre);
  const operaciones = [];
  const nuevas = [];

  etiquetas.forEach(etiqueta => {
    const ref = doc(etiquetasCodigoRef());
    operaciones.push({
      tipo: 'set',
      ref,
      data: { ...etiqueta, creado: serverTimestamp() }
    });
    nuevas.push({ id: ref.id, ...etiqueta });
  });

  await commitOperacionesCodigo(operaciones);
  etiquetasCodigo.push(...nuevas);
  etiquetasCodigoCargadas = true;
  renderEtiquetasCodigo();
  return { productos: items.length, totalEtiquetas: nuevas.length };
}

function renderPreviewCodigosLote() {
  const tbody = $('cod-preview-lote-body');
  const resumen = $('cod-preview-lote-resumen');
  if (!tbody || !resumen || !codigosLotePreview) return;

  const items = codigosLotePreview.items || [];
  const modoNombre = textoModoNombreEtiqueta(codigosLotePreview.mostrarNombre);
  const alcance = codigosLotePreview.alcance || '';
  const esExistente = codigosLotePreview.tipo === 'existentes';
  const titulo = $('cod-preview-lote-titulo');
  const btn = $('cod-preview-lote-confirmar');
  if (titulo) titulo.textContent = esExistente ? 'Generar etiquetas existentes' : 'Previsualizar codigos';
  if (btn) btn.textContent = esExistente ? 'Guardar etiquetas' : 'Confirmar generacion';
  resumen.textContent = esExistente
    ? `${items.length} producto(s) con codigo${alcance}. Etiquetas ${modoNombre}. Total etiquetas: ${totalEtiquetasPreview()}.`
    : `${items.length} producto(s)${alcance}. Etiquetas ${modoNombre}. Total etiquetas: ${totalEtiquetasPreview()}.`;

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No hay productos en esta previsualizacion</td></tr>';
    return;
  }

  tbody.innerHTML = items.map((item, i) => `
    <tr>
      <td><strong>${escapeHtml(item.nombre)}</strong></td>
      <td>${escapeHtml(item.categoria || 'Sin categoria')}</td>
      <td><span class="barcode-batch-code">${escapeHtml(item.codigo)}</span></td>
      <td>
        <input class="barcode-batch-qty" type="number" min="0" max="100" value="${cantidadEtiquetaLoteSegura(item.cantidad)}" onchange="actualizarCantidadPreviewCodigo(${i}, this.value)" oninput="actualizarCantidadPreviewCodigo(${i}, this.value)"/>
      </td>
      <td><button class="btn-icon del" onclick="quitarProductoPreviewCodigo(${i})">Quitar</button></td>
    </tr>
  `).join('');
}

function abrirPreviewCodigosFaltantes(faltantes, opciones) {
  const items = construirPreviewCodigosFaltantes(faltantes);
  codigosLotePreview = { ...opciones, items };
  if ($('cod-preview-lote-msg')) $('cod-preview-lote-msg').innerHTML = '';
  renderPreviewCodigosLote();
  openModal('modal-codigos-preview');
}

function abrirPreviewEtiquetasExistentes(lista, opciones) {
  const items = construirPreviewEtiquetasExistentes(lista);
  codigosLotePreview = { ...opciones, tipo: 'existentes', items };
  if ($('cod-preview-lote-msg')) $('cod-preview-lote-msg').innerHTML = '';
  renderPreviewCodigosLote();
  openModal('modal-codigos-preview');
}

window.actualizarCantidadPreviewCodigo = function(index, value) {
  if (!codigosLotePreview?.items?.[index]) return;
  codigosLotePreview.items[index].cantidad = cantidadEtiquetaLoteSegura(value);
  const resumen = $('cod-preview-lote-resumen');
  if (resumen) {
    const modoNombre = textoModoNombreEtiqueta(codigosLotePreview.mostrarNombre);
    const alcance = codigosLotePreview.alcance || '';
    resumen.textContent = `${codigosLotePreview.items.length} producto(s)${alcance}. Etiquetas ${modoNombre}. Total etiquetas: ${totalEtiquetasPreview()}.`;
  }
};

window.quitarProductoPreviewCodigo = function(index) {
  if (!codigosLotePreview?.items) return;
  codigosLotePreview.items.splice(index, 1);
  renderPreviewCodigosLote();
};

function crearCodigoUnico(usados = codigosOcupados()) {
  return siguienteCodigoSecuencial(usados);
}

function actualizarCodigoLocal(productoId, codigo) {
  const aplicar = lista => {
    const idx = lista?.findIndex(p => p.id === productoId);
    if (idx !== undefined && idx >= 0) lista[idx] = { ...lista[idx], codigo_barras: codigo };
  };
  aplicar(productos);
  aplicar(_productosCache);
}

function renderSvgCodigo(svgId, codigo, opciones = {}) {
  const svg = $(svgId);
  if (!svg) return;
  svg.innerHTML = '';
  if (!codigo) return;

  if (!window.JsBarcode) {
    svg.classList.add('barcode-error');
    return;
  }

  try {
    window.JsBarcode(svg, codigo, {
      format: 'CODE128',
      displayValue: false,
      lineColor: '#0e0f11',
      background: '#ffffff',
      width: opciones.width || 2,
      height: opciones.height || 72,
      margin: opciones.margin ?? 8
    });
    svg.classList.remove('barcode-error');
  } catch (e) {
    svg.innerHTML = '';
    svg.classList.add('barcode-error');
  }
}

function renderCodigosBarras() {
  const p = productoCodigoSeleccionado();
  if ($('cod-producto-nombre')) $('cod-producto-nombre').value = p ? p.nombre : '';
  if ($('cod-valor') && p && !$('cod-valor').value) $('cod-valor').value = codigoProductoActual(p);
  actualizarCategoriasCodigo();
  actualizarPreviewCodigo();
  renderEtiquetasCodigo();
  cargarEtiquetasCodigo();
}

window.filtrarProductosCodigo = function() {
  const input = $('cod-search');
  const cont = $('cod-sugerencias');
  if (!input || !cont) return;

  const q = input.value.trim().toLowerCase();
  const qCode = limpiarCodigo(input.value);
  if (q.length < 1) { cont.innerHTML = ''; return; }

  const encontrados = productos
    .filter(p =>
      (p.nombre || '').toLowerCase().includes(q) ||
      (p.categoria || '').toLowerCase().includes(q) ||
      (qCode && codigosProducto(p).some(codigo => codigo.includes(qCode))))
    .slice(0, 8);

  cont.innerHTML = encontrados.length === 0
    ? '<div class="empty barcode-empty">Sin productos</div>'
    : `<div class="sugerencias-list">${encontrados.map(p => {
        const codigo = codigoProductoActual(p) || 'Sin código';
        return `<div class="sugerencia-item" onclick="seleccionarProductoCodigo('${escapeJsString(p.id)}')">
          <span>${escapeHtml(p.nombre)}</span>
          <span class="sug-stock">${escapeHtml(codigo)}</span>
        </div>`;
      }).join('')}</div>`;
};

window.seleccionarProductoCodigo = function(id) {
  codigoProductoId = id;
  const p = productoCodigoSeleccionado();
  $('cod-search').value = '';
  $('cod-sugerencias').innerHTML = '';
  $('cod-producto-nombre').value = p ? p.nombre : '';
  $('cod-valor').value = codigoProductoActual(p);
  actualizarPreviewCodigo();
};

window.actualizarPreviewCodigo = function() {
  const input = $('cod-valor');
  const codigo = limpiarCodigo(input?.value || '');
  if (input && input.value !== codigo) input.value = codigo;

  const p = productoCodigoSeleccionado();
  const nombre = p ? p.nombre : 'Sin producto';
  if ($('cod-preview-name')) $('cod-preview-name').textContent = nombre;
  if ($('cod-preview-value')) $('cod-preview-value').textContent = codigo || '---';
  renderSvgCodigo('cod-preview-svg', codigo);
};

window.generarCodigoProducto = async function() {
  if (!codigoProductoId) {
    showMsg('cod-msg', 'Selecciona un producto antes de generar el código.', 'error');
    return;
  }
  showMsg('cod-msg', 'Revisando codigos existentes...', 'ok');
  try {
    const [prods] = await Promise.all([
      getProductos(true),
      cargarEtiquetasCodigo(true)
    ]);
    productos = prods;
    actualizarCategoriasCodigo();
  } catch (e) {
    console.warn('No se pudieron revisar codigos antes de generar:', e.message || e);
    showMsg('cod-msg', 'No se pudo revisar Firebase antes de generar.', 'error');
    return;
  }
  if (!productoCodigoSeleccionado()) {
    showMsg('cod-msg', 'El producto seleccionado ya no existe.', 'error');
    return;
  }
  $('cod-valor').value = crearCodigoUnico();
  actualizarPreviewCodigo();
  showMsg('cod-msg', 'Código generado. Puedes guardarlo en el producto o dejarlo como etiqueta pendiente.', 'ok');
};

window.guardarCodigoProducto = async function() {
  const p = productoCodigoSeleccionado();
  if (!p) {
    showMsg('cod-msg', 'Selecciona un producto para guardar el código.', 'error');
    return;
  }

  const codigo = limpiarCodigo($('cod-valor').value);
  if (!codigo) {
    showMsg('cod-msg', 'Escribe o genera un código válido.', 'error');
    return;
  }

  const repetido = productoConCodigo(codigo, p.id);
  if (repetido) {
    showMsg('cod-msg', `Ese código ya está en ${repetido.nombre}.`, 'error');
    return;
  }
  if (codigoUsadoEnOtraEtiqueta(codigo, p.id)) {
    showMsg('cod-msg', 'Ese código ya está en etiquetas pendientes de otro producto.', 'error');
    return;
  }

  await updateDoc(doc(db(), 'productos', p.id), { codigo_barras: codigo });
  actualizarCodigoLocal(p.id, codigo);
  showMsg('cod-msg', 'Código guardado en el producto.', 'ok');
  actualizarPreviewCodigo();
};

window.agregarEtiquetaCodigo = async function() {
  const p = productoCodigoSeleccionado();
  if (!p) {
    showMsg('cod-msg', 'Selecciona un producto para añadir etiquetas.', 'error');
    return;
  }

  const codigo = limpiarCodigo($('cod-valor').value);
  if (!codigo) {
    showMsg('cod-msg', 'Escribe o genera un código válido.', 'error');
    return;
  }

  if (productoConCodigo(codigo, p.id)) {
    showMsg('cod-msg', 'Ese código ya está asignado a otro producto.', 'error');
    return;
  }
  if (codigoUsadoEnOtraEtiqueta(codigo, p.id)) {
    showMsg('cod-msg', 'Ese código ya está en etiquetas pendientes de otro producto.', 'error');
    return;
  }

  const cantidad = Math.max(1, Math.min(100, parseInt($('cod-cantidad').value, 10) || 1));
  const guardadoEnProducto = codigoProductoActual(p) === codigo;
  const mostrarNombre = $('cod-mostrar-nombre')?.value === 'con';
  const batch = writeBatch(db());
  const nuevas = [];
  for (let i = 0; i < cantidad; i++) {
    const ref = doc(etiquetasCodigoRef());
    const etiqueta = {
      producto_id: p.id,
      nombre: p.nombre,
      codigo,
      precio_venta: p.precio_venta || 0,
      guardado_en_producto: guardadoEnProducto,
      mostrar_nombre: mostrarNombre
    };
    batch.set(ref, { ...etiqueta, creado: serverTimestamp() });
    nuevas.push({ id: ref.id, ...etiqueta });
  }
  try {
    await batch.commit();
  } catch (e) {
    showMsg('cod-msg', 'No se pudieron guardar las etiquetas en Firebase.', 'error');
    return;
  }
  etiquetasCodigo.push(...nuevas);
  etiquetasCodigoCargadas = true;
  renderEtiquetasCodigo();
  showMsg('cod-msg', `${cantidad} etiqueta${cantidad > 1 ? 's' : ''} añadida${cantidad > 1 ? 's' : ''}.`, 'ok');
};

function etiquetaCodigoHtml(item, i, modo = 'lista') {
  const svgId = modo === 'print' ? `cod-print-svg-${i}` : `cod-label-svg-${i}`;
  const quitar = modo === 'print' ? '' : `<button class="btn-icon del" onclick="quitarEtiquetaCodigo(${i})">Quitar</button>`;
  const borrarCodigo = modo === 'print' ? '' : `<button class="btn-icon del" onclick="borrarCodigoEtiqueta(${i})">Borrar codigo</button>`;
  const acciones = modo === 'print' ? '' : `<div class="barcode-label-buttons">${quitar}${borrarCodigo}</div>`;
  const pendiente = modo === 'print' || item.guardado_en_producto !== false ? '' : '<span class="badge badge-bajo" style="font-size:0.68rem">Pendiente</span>';
  const mostrarNombre = item.mostrar_nombre === true;
  const nombreEstado = modo === 'print' || !mostrarNombre ? '' : '<span class="badge badge-ok" style="font-size:0.68rem">Con nombre</span>';
  return `<div class="barcode-label-card ${mostrarNombre ? 'barcode-label-with-name' : ''}">
    <div class="barcode-label-top">
      <strong>${escapeHtml(item.nombre)}</strong>
      ${pendiente}
      ${nombreEstado}
      ${acciones}
    </div>
    <svg id="${svgId}" class="barcode-svg small" role="img" aria-label="Código de barras ${escapeHtml(item.codigo)}"></svg>
    <div class="barcode-label-bottom">
      <span>${escapeHtml(item.codigo)}</span>
      <span>${fmtCOP(item.precio_venta)}</span>
    </div>
  </div>`;
}

async function cargarEtiquetasCodigo(forzar = false) {
  if (etiquetasCodigoCargadas && !forzar) return etiquetasCodigo;

  const cont = $('cod-etiquetas-lista');
  if (cont) cont.innerHTML = '<div class="empty">Cargando etiquetas pendientes...</div>';

  try {
    const snap = await getDocs(query(etiquetasCodigoRef(), orderBy('creado', 'asc')));
    etiquetasCodigo = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    etiquetasCodigoCargadas = true;
    renderEtiquetasCodigo();
    return etiquetasCodigo;
  } catch (e) {
    console.warn('No se pudieron cargar etiquetas pendientes:', e.message || e);
    if (cont) cont.innerHTML = '<div class="empty">No se pudieron cargar las etiquetas pendientes</div>';
    return etiquetasCodigo;
  }
}

window.actualizarEtiquetasCodigo = async function() {
  await cargarEtiquetasCodigo(true);
  showMsg('cod-msg', 'Etiquetas actualizadas desde Firebase.', 'ok');
};

async function prepararCodigosFaltantes() {
  const categoriaKey = categoriaCodigoSeleccionada();
  const categoriaNombre = categoriaCodigoNombre(categoriaKey);
  showMsg('cod-msg', 'Revisando Firebase antes de generar...', 'ok');
  try {
    const [prods] = await Promise.all([
      getProductos(true),
      cargarEtiquetasCodigo(true)
    ]);
    productos = prods;
    actualizarCategoriasCodigo(categoriaKey);
    return {
      faltantes: productos.filter(p => codigosProducto(p).length === 0 && productoPasaCategoriaCodigo(p, categoriaKey)),
      categoriaKey,
      categoriaNombre
    };
  } catch (e) {
    console.warn('No se pudieron revisar productos para codigos:', e.message || e);
    showMsg('cod-msg', 'No se pudo revisar Firebase antes de generar codigos.', 'error');
    return null;
  }
}

async function commitOperacionesCodigo(operaciones) {
  const MAX_OPS = 450;
  for (let i = 0; i < operaciones.length; i += MAX_OPS) {
    const batch = writeBatch(db());
    operaciones.slice(i, i + MAX_OPS).forEach(op => {
      if (op.tipo === 'set' && op.options) batch.set(op.ref, op.data, op.options);
      if (op.tipo === 'set' && !op.options) batch.set(op.ref, op.data);
      if (op.tipo === 'update') batch.update(op.ref, op.data);
      if (op.tipo === 'delete') batch.delete(op.ref);
    });
    await batch.commit();
  }
}

async function procesarLoteCodigosFaltantes(lote, opciones = {}) {
  if (!lote || lote.length === 0) return { procesados: 0, nuevasEtiquetas: [] };

  const mostrarNombre = opciones.mostrarNombre === true;
  const usados = codigosOcupados();
  const operaciones = [];
  const nuevasEtiquetas = [];
  const etiquetasActualizadas = [];
  const etiquetasEliminadas = new Set();
  const actualizados = [];

  lote.forEach(item => {
    const p = item.producto || productos.find(x => x.id === item.productoId) || item;
    if (!p?.id) return;
    const cantidad = cantidadEtiquetaLoteSegura(item.cantidad ?? 1);
    if (cantidad <= 0) return;
    let codigo = limpiarCodigo(item.codigo || '');
    if (!codigo || codigoOcupadoPorOtro(codigo, p.id) || usados.has(codigo)) {
      codigo = crearCodigoUnico(usados);
    }
    usados.add(codigo);
    const etiqueta = datosEtiquetaCodigo(p, codigo, mostrarNombre);
    const etiquetasExistentes = etiquetasPendientesDeProducto(p.id);

    for (let i = 0; i < cantidad; i++) {
      const existente = etiquetasExistentes[i];
      if (existente?.id) {
        operaciones.push({
          tipo: 'set',
          ref: doc(db(), 'etiquetas_codigos', existente.id),
          data: {
            ...etiqueta,
            actualizado: serverTimestamp()
          },
          options: { merge: true }
        });
        etiquetasActualizadas.push({ id: existente.id, ...etiqueta });
      } else {
        const ref = doc(etiquetasCodigoRef());
        operaciones.push({
          tipo: 'set',
          ref,
          data: { ...etiqueta, creado: serverTimestamp() }
        });
        nuevasEtiquetas.push({ id: ref.id, ...etiqueta });
      }
    }

    etiquetasExistentes.slice(cantidad).forEach(existente => {
      if (!existente.id) return;
      operaciones.push({
        tipo: 'delete',
        ref: doc(db(), 'etiquetas_codigos', existente.id)
      });
      etiquetasEliminadas.add(existente.id);
    });

    operaciones.push({
      tipo: 'update',
      ref: doc(db(), 'productos', p.id),
      data: { codigo_barras: codigo }
    });
    actualizados.push({ productoId: p.id, nombre: p.nombre, precio_venta: p.precio_venta || 0, codigo });
  });

  await commitOperacionesCodigo(operaciones);

  actualizados.forEach(item => actualizarCodigoLocal(item.productoId, item.codigo));
  const actualizadasMap = new Map(etiquetasActualizadas.map(item => [item.id, item]));
  etiquetasCodigo = etiquetasCodigo
    .filter(item => !etiquetasEliminadas.has(item.id))
    .map(item => {
      const actualizado = actualizadasMap.get(item.id);
      return actualizado
        ? { ...item, ...actualizado, guardado_en_producto: true }
        : item;
    });
  etiquetasCodigo.push(...nuevasEtiquetas);
  etiquetasCodigoCargadas = true;
  renderEtiquetasCodigo();
  renderInventarioPaginado();
  actualizarPreviewCodigo();

  return {
    procesados: actualizados.length,
    nuevasEtiquetas,
    totalEtiquetas: nuevasEtiquetas.length + etiquetasActualizadas.length,
    escrituras: operaciones.length
  };
}

window.generarLoteCodigosFaltantes = async function() {
  const prep = await prepararCodigosFaltantes();
  if (!prep) return;
  const { faltantes, categoriaKey, categoriaNombre } = prep;
  const alcance = categoriaKey ? ` en ${categoriaNombre}` : '';
  if (faltantes.length === 0) {
    showMsg('cod-msg', `No hay productos sin codigo de barras${alcance}.`, 'ok');
    return;
  }

  const lote = faltantes.slice(0, COD_BATCH_SIZE);
  const mostrarNombre = mostrarNombreLoteCodigoSeleccionado();
  abrirPreviewCodigosFaltantes(lote, {
    tipo: 'lote',
    mostrarNombre,
    categoriaKey,
    categoriaNombre,
    alcance,
    totalFaltantes: faltantes.length
  });
};

window.generarTodosCodigosFaltantes = async function() {
  const prep = await prepararCodigosFaltantes();
  if (!prep) return;
  const { faltantes, categoriaKey, categoriaNombre } = prep;
  const alcance = categoriaKey ? ` en ${categoriaNombre}` : '';
  if (faltantes.length === 0) {
    showMsg('cod-msg', `No hay productos sin codigo de barras${alcance}.`, 'ok');
    return;
  }

  const mostrarNombre = mostrarNombreLoteCodigoSeleccionado();
  abrirPreviewCodigosFaltantes(faltantes, {
    tipo: 'todos',
    mostrarNombre,
    categoriaKey,
    categoriaNombre,
    alcance,
    totalFaltantes: faltantes.length
  });
};

window.previsualizarEtiquetasCodigosExistentes = async function() {
  const categoriaKey = categoriaCodigoSeleccionada();
  const categoriaNombre = categoriaCodigoNombre(categoriaKey);
  const alcance = categoriaKey ? ` en ${categoriaNombre}` : '';
  const mostrarNombre = mostrarNombreLoteCodigoSeleccionado();

  showMsg('cod-msg', 'Preparando etiquetas existentes...', 'ok');
  try {
    productos = await getProductos(true);
    actualizarCategoriasCodigo(categoriaKey);
  } catch (e) {
    console.warn('No se pudo cargar inventario para imprimir:', e.message || e);
    showMsg('cod-msg', 'No se pudo cargar el inventario para imprimir.', 'error');
    return;
  }

  const imprimibles = productos
    .filter(p => codigoProductoActual(p) && productoPasaCategoriaCodigo(p, categoriaKey))
    .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')));

  if (imprimibles.length === 0) {
    showMsg('cod-msg', `No hay productos con codigo de barras${alcance}.`, 'warn');
    return;
  }

  abrirPreviewEtiquetasExistentes(imprimibles, {
    mostrarNombre,
    categoriaKey,
    categoriaNombre,
    alcance,
    totalFaltantes: imprimibles.length
  });
};

window.previsualizarImpresionCodigosExistentes = window.previsualizarEtiquetasCodigosExistentes;

window.confirmarPreviewCodigosLote = async function() {
  if (!codigosLotePreview?.items) {
    showMsg('cod-preview-lote-msg', 'No hay una previsualizacion activa.', 'error');
    return;
  }

  const items = codigosLotePreview.items
    .map(item => ({ ...item, cantidad: cantidadEtiquetaLoteSegura(item.cantidad) }))
    .filter(item => item.cantidad > 0);

  if (items.length === 0) {
    showMsg('cod-preview-lote-msg', 'Deja al menos un producto con una etiqueta.', 'error');
    return;
  }

  const btn = $('cod-preview-lote-confirmar');
  if (btn) btn.disabled = true;
  const esExistente = codigosLotePreview.tipo === 'existentes';
  showMsg('cod-preview-lote-msg', esExistente
    ? 'Guardando etiquetas existentes en Firebase...'
    : 'Guardando codigos y etiquetas en Firebase...', 'ok');

  try {
    if (esExistente) {
      const r = await guardarEtiquetasExistentesPreview(items, codigosLotePreview.mostrarNombre);
      const alcance = codigosLotePreview.alcance || '';
      closeModal('modal-codigos-preview');
      showMsg('cod-msg', `Listo: ${r.totalEtiquetas} etiqueta(s) existente(s) generada(s)${alcance}.`, 'ok');
      codigosLotePreview = null;
      return;
    }

    const r = await procesarLoteCodigosFaltantes(items, { mostrarNombre: codigosLotePreview.mostrarNombre });
    const alcance = codigosLotePreview.alcance || '';
    const modoNombre = textoModoNombreEtiqueta(codigosLotePreview.mostrarNombre);
    closeModal('modal-codigos-preview');
    showMsg('cod-msg', `Listo: ${r.procesados} producto(s), ${r.totalEtiquetas} etiqueta(s) ${modoNombre}${alcance}.`, 'ok');
    codigosLotePreview = null;
  } catch (e) {
    console.warn('No se pudo confirmar la previsualizacion de codigos:', e.message || e);
    showMsg('cod-preview-lote-msg', 'No se pudieron guardar los codigos en Firebase.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

async function borrarCodigoProductoCompleto(productoId, codigoObjetivo = '') {
  showMsg('cod-msg', 'Revisando etiquetas pendientes...', 'ok');
  try {
    const [prods] = await Promise.all([
      getProductos(true),
      cargarEtiquetasCodigo(true)
    ]);
    productos = prods;
  } catch (e) {
    showMsg('cod-msg', 'No se pudo revisar Firebase antes de borrar.', 'error');
    return;
  }

  const p = productos.find(x => x.id === productoId);
  if (!p) {
    showMsg('cod-msg', 'Producto no encontrado.', 'error');
    return;
  }

  const codigoActual = codigoProductoActual(p);
  const codigo = limpiarCodigo(codigoObjetivo || codigoActual || $('cod-valor')?.value);
  if (!codigo) {
    showMsg('cod-msg', 'Este producto no tiene codigo para borrar.', 'warn');
    return;
  }

  const borrarDelProducto = !codigoObjetivo || codigoActual === codigo;
  const relacionadas = etiquetasPendientesDeProducto(p.id, codigo);
  const accionProducto = borrarDelProducto ? 'el codigo del producto y' : 'solo';
  if (!confirm(`Borrar ${accionProducto} ${relacionadas.length} etiqueta(s) pendiente(s) con el codigo ${codigo}?`)) return;

  const batch = writeBatch(db());
  let operaciones = 0;
  if (borrarDelProducto) {
    batch.update(doc(db(), 'productos', p.id), { codigo_barras: '' });
    operaciones++;
  }
  relacionadas.forEach(item => {
    if (item.id) {
      batch.delete(doc(db(), 'etiquetas_codigos', item.id));
      operaciones++;
    }
  });

  if (operaciones === 0) {
    showMsg('cod-msg', 'No habia nada que borrar para ese codigo.', 'warn');
    return;
  }

  try {
    await batch.commit();
  } catch (e) {
    console.warn('No se pudo borrar codigo completo:', e.message || e);
    showMsg('cod-msg', 'No se pudo borrar el codigo en Firebase.', 'error');
    return;
  }

  if (borrarDelProducto) actualizarCodigoLocal(p.id, '');
  etiquetasCodigo = etiquetasCodigo.filter(item =>
    !(item.producto_id === p.id && limpiarCodigo(item.codigo) === codigo));
  etiquetasCodigoCargadas = true;
  if (codigoProductoId === p.id && borrarDelProducto) {
    const input = $('cod-valor');
    if (input) input.value = '';
  }
  renderEtiquetasCodigo();
  renderInventarioPaginado();
  actualizarPreviewCodigo();
  showMsg('cod-msg', borrarDelProducto
    ? 'Codigo borrado del producto y de etiquetas pendientes.'
    : 'Etiquetas pendientes borradas. El codigo actual del producto no se toco.', 'ok');
}

window.borrarCodigoProductoSeleccionado = async function() {
  const p = productoCodigoSeleccionado();
  if (!p) {
    showMsg('cod-msg', 'Selecciona un producto para borrar su codigo.', 'error');
    return;
  }
  await borrarCodigoProductoCompleto(p.id);
};

window.borrarCodigoEtiqueta = async function(i) {
  const item = etiquetasCodigo[i];
  if (!item) return;
  await borrarCodigoProductoCompleto(item.producto_id, item.codigo);
};

function renderEtiquetasCodigo() {
  const cont = $('cod-etiquetas-lista');
  if (!cont) return;

  if (etiquetasCodigo.length === 0) {
    cont.innerHTML = '<div class="empty">Sin etiquetas listas</div>';
    return;
  }

  cont.innerHTML = etiquetasCodigo.map((item, i) => etiquetaCodigoHtml(item, i)).join('');
  etiquetasCodigo.forEach((item, i) => renderSvgCodigo(`cod-label-svg-${i}`, item.codigo, { width: 1.5, height: 48, margin: 4 }));
}

window.quitarEtiquetaCodigo = async function(i) {
  const item = etiquetasCodigo[i];
  if (!item) return;
  etiquetasCodigo.splice(i, 1);
  renderEtiquetasCodigo();
  if (!item.id) return;
  try {
    await deleteDoc(doc(db(), 'etiquetas_codigos', item.id));
  } catch (e) {
    etiquetasCodigo.splice(i, 0, item);
    renderEtiquetasCodigo();
    showMsg('cod-msg', 'No se pudo quitar la etiqueta de Firebase.', 'error');
  }
};

window.limpiarEtiquetasCodigo = async function() {
  await cargarEtiquetasCodigo(true);
  if (etiquetasCodigo.length === 0) {
    renderEtiquetasCodigo();
    return;
  }
  if (!confirm('Limpiar todas las etiquetas pendientes en todos los PC?')) return;
  const batch = writeBatch(db());
  etiquetasCodigo.forEach(item => {
    if (item.id) batch.delete(doc(db(), 'etiquetas_codigos', item.id));
  });
  try {
    await batch.commit();
  } catch (e) {
    showMsg('cod-msg', 'No se pudieron limpiar las etiquetas en Firebase.', 'error');
    return;
  }
  etiquetasCodigo = [];
  etiquetasCodigoCargadas = true;
  renderEtiquetasCodigo();
  const sheet = $('cod-print-sheet');
  if (sheet) sheet.innerHTML = '';
};

function imprimirListaEtiquetasCodigo(lista) {
  if (!lista || lista.length === 0) {
    showMsg('cod-msg', 'No hay etiquetas para imprimir.', 'error');
    return;
  }

  const sheet = $('cod-print-sheet');
  sheet.innerHTML = lista.map((item, i) => etiquetaCodigoHtml(item, i, 'print')).join('');
  lista.forEach((item, i) => renderSvgCodigo(`cod-print-svg-${i}`, item.codigo, { width: 1.35, height: 50, margin: 0 }));

  document.body.classList.add('print-barcodes');
  setTimeout(() => window.print(), 120);
}

window.imprimirEtiquetasCodigo = function() {
  if (etiquetasCodigo.length === 0) {
    showMsg('cod-msg', 'Añade al menos una etiqueta antes de imprimir.', 'error');
    return;
  }

  const sheet = $('cod-print-sheet');
  sheet.innerHTML = etiquetasCodigo.map((item, i) => etiquetaCodigoHtml(item, i, 'print')).join('');
  etiquetasCodigo.forEach((item, i) => renderSvgCodigo(`cod-print-svg-${i}`, item.codigo, { width: 1.35, height: 50, margin: 0 }));

  document.body.classList.add('print-barcodes');
  setTimeout(() => window.print(), 120);
};

window.addEventListener('afterprint', () => {
  document.body.classList.remove('print-barcodes');
});

/* ═══════════════════════════════════════════════════════
   MODALS
═══════════════════════════════════════════════════════ */
window.openModal  = function(id) { $(id).classList.add('open'); };
window.closeModal = function(id) { $(id).classList.remove('open'); };

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target !== this) return;
    if (this.id === 'modal-scanner') window.cerrarEscanerBarras();
    else this.classList.remove('open');
  });
});

/* ═══════════════════════════════════════════════════════
   INIT  — UNA sola carga de productos y anchetas
═══════════════════════════════════════════════════════ */
window.initApp = async function() {
  const hoy = new Date().toISOString().split('T')[0];
  $('inf-desde').value = hoy;
  $('inf-hasta').value = hoy;

  // Carga paralela única al arrancar
  [productos, anchetas] = await Promise.all([getProductos(), getAnchetas()]);
  actualizarCategoriasCodigo();

  // Dashboard usa los mismos datos + ventas hoy (query fresca)
  loadDashboard();
  renderCarrito();
};
