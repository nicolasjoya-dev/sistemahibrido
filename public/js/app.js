/* ════════════════════════════════════════════════════
   SistemaHíbrido — app.js  (Firestore optimizado)
   - Caché local para productos y anchetas
   - Inventario virtual con búsqueda local (no re-lee Firestore)
   - onSnapshot eliminado (era el mayor consumidor)
   - Anulación de ventas de anchetas corregida
   - Inventario paginado para soportar 2000+ productos
   ════════════════════════════════════════════════════ */

import {
  collection, doc, getDocs, getDoc, addDoc, setDoc,
  updateDoc, deleteDoc, query, where, orderBy,
  serverTimestamp, limit, startAfter
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

// ── State ─────────────────────────────────────────────
let productos = [];   // alias local del caché
let anchetas  = [];
let carrito   = [];
let editandoProductoId  = null;
let entradaProductoId   = null;
let productoParaCarrito = null;
let anchetaParaCarrito  = null;
let codigoProductoId    = null;
let etiquetasCodigo     = [];
let calAnio = new Date().getFullYear();
let calMes  = new Date().getMonth() + 1;

// Paginación inventario
const INV_PAGE_SIZE = 50;
let invPagina = 0;
let invFiltro = '';

// ── Connection status ─────────────────────────────────
function updateConnStatus() {
  const el = $('conn-status');
  if (navigator.onLine) { el.textContent = '● Online';  el.classList.remove('offline'); }
  else                  { el.textContent = '● Offline'; el.classList.add('offline'); }
}
window.addEventListener('online',  updateConnStatus);
window.addEventListener('offline', updateConnStatus);
updateConnStatus();

// ── Navigation ────────────────────────────────────────
window.switchTab = function(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('tab-' + name).classList.add('active');
  if (el) el.classList.add('active');
  // Solo carga desde Firestore en primera visita o tabs que siempre necesitan datos frescos
  if (name === 'dashboard')  loadDashboard();
  if (name === 'inventario') renderInventarioPaginado();   // usa caché
  if (name === 'calendario') renderCalendario();
  if (name === 'cierre')     loadCierreHistorial();
  if (name === 'ajustes')    loadAjustes();
  if (name === 'anchetas')   renderAnchetas();             // usa caché
  if (name === 'codigos')    renderCodigosBarras();
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
async function getVentasHoy() {
  const hoy = fechaLocal();
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '==', hoy),
      orderBy('fecha', 'desc'))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getVentasPorFecha(fechaStr) {
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '==', fechaStr),
      orderBy('fecha', 'desc'))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getVentasRango(desde, hasta) {
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '>=', desde),
      where('fecha_key', '<=', hasta),
      orderBy('fecha_key', 'desc'))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ═══════════════════════════════════════════════════════
   DASHBOARD  — una sola llamada paralela
═══════════════════════════════════════════════════════ */
async function loadDashboard() {
  const hoy = new Date();
  $('fecha-hoy').textContent = hoy.toLocaleDateString('es-CO', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // Paralelo: productos (caché) + ventas hoy (siempre fresco)
  const [prods, todasVentas] = await Promise.all([getProductos(), getVentasHoy()]);
  productos = prods;

  const ventas  = todasVentas.filter(v => !v.anulada);
  const alertas = prods.filter(p => p.stock <= p.stock_minimo);

  $('d-productos').textContent  = prods.length;
  $('d-ventas-hoy').textContent = ventas.length;
  $('d-total-hoy').textContent  = fmtCOP(ventas.reduce((s, v) => s + (v.total || 0), 0));
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

  const ventaSnap = await getDoc(doc(db(), 'ventas', ventaId));
  if (!ventaSnap.exists()) { alert('Venta no encontrada'); return; }
  const v = ventaSnap.data();
  if (v.anulada) { alert('Esta venta ya fue anulada.'); return; }

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
function renderInventarioPaginado() {
  const lista   = invFiltro
    ? productos.filter(p =>
        p.nombre.toLowerCase().includes(invFiltro) ||
        (p.categoria || '').toLowerCase().includes(invFiltro) ||
        (p.codigo_barras || '').includes(invFiltro))
    : productos;

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
  const lista  = invFiltro ? productos.filter(p => p.nombre.toLowerCase().includes(invFiltro)) : productos;
  const maxPag = Math.ceil(lista.length / INV_PAGE_SIZE) - 1;
  invPagina = Math.max(0, Math.min(pag, maxPag));
  renderInventarioPaginado();
};

window.filtrarInventario = function() {
  invFiltro = $('inv-search').value.toLowerCase().trim();
  invPagina = 0;
  renderInventarioPaginado();
};

/* ═══════════════════════════════════════════════════════
   MODAL PRODUCTO
═══════════════════════════════════════════════════════ */
window.openModalProducto = function(id) {
  editandoProductoId = id || null;
  $('modal-titulo').textContent   = id ? 'Editar Producto' : 'Nuevo Producto';
  $('modal-save-btn').textContent = id ? 'Actualizar' : 'Guardar';
  $('modal-msg').innerHTML = '';
  $('margen-display') && ($('margen-display').style.display = 'none');
  ['p-nombre','p-categoria','p-compra','p-venta','p-stock','p-barras'].forEach(f => $(f).value = '');
  $('p-stockmin').value = 5;
  $('p-unidad').value   = 'unidades';

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
      $('p-unidad').value    = p.unidad;
      calcMargen();
    }
  }
  openModal('modal-producto');
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

window.guardarProducto = async function() {
  const nombre       = $('p-nombre').value.trim();
  const precio_venta = parseFloat($('p-venta').value);
  if (!nombre || isNaN(precio_venta)) {
    showMsg('modal-msg', 'Nombre y precio de venta son obligatorios.', 'error');
    return;
  }
  const data = {
    nombre,
    categoria:     $('p-categoria').value.trim() || '',
    precio_compra: parseFloat($('p-compra').value) || 0,
    precio_venta,
    stock:         parseFloat($('p-stock').value) || 0,
    stock_minimo:  parseFloat($('p-stockmin').value) || 5,
    codigo_barras: $('p-barras').value.trim() || '',
    unidad:        $('p-unidad').value
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
};

window.eliminarProducto = async function(id) {
  if (!confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) return;
  await deleteDoc(doc(db(), 'productos', id));
  if (_productosCache) {
    const idx = _productosCache.findIndex(p => p.id === id);
    if (idx >= 0) _productosCache.splice(idx, 1);
  }
  productos = _productosCache || [];
  showMsg('inv-msg', 'Producto eliminado.', 'warn');
  renderInventarioPaginado();
};

/* ═══════════════════════════════════════════════════════
   MODAL ENTRADA DE INVENTARIO
═══════════════════════════════════════════════════════ */
window.openModalEntrada = async function(id) {
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
  const prods = productos
    .filter(p => p.nombre.toLowerCase().includes(qLow) || (p.codigo_barras || '').includes(q))
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
        <div class="sug-stock">${item.stock} ${item.unidad} disponibles</div>
      </div>
      <span class="sug-precio">${fmtCOP(item.precio_venta)}</span>
    </div>`;
  }).join('')}</div>`;
};

window.abrirModalCantidad = function(p) {
  productoParaCarrito = p;
  anchetaParaCarrito  = null;
  $('mcant-nombre').textContent = p.nombre;
  $('mcant-label').textContent  = `Cantidad (${p.unidad})`;
  $('mcant-stock').textContent  = `${p.stock} ${p.unidad}`;
  $('mcant-val').value = 1;
  $('venta-sugerencias').innerHTML = '';
  openModal('modal-cantidad');
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
    const existing = carrito.find(c => c._ancheta_id === a.id);
    if (existing) { existing.cantidad += cant; }
    else {
      carrito.push({
        _ancheta_id:     a.id,
        _ancheta_items:  a.items,
        producto_id:     null,
        nombre_producto: '🎁 ' + a.nombre,
        cantidad:        cant,
        precio_unitario: a.precio_venta,
        precio_compra:   0,
        unidad:          'unidades'
      });
    }
    anchetaParaCarrito = null;
  } else if (productoParaCarrito) {
    if (cant > productoParaCarrito.stock) { alert('Stock insuficiente'); return; }
    const existing = carrito.find(c => c.producto_id === productoParaCarrito.id);
    if (existing) { existing.cantidad += cant; }
    else {
      carrito.push({
        producto_id:     productoParaCarrito.id,
        nombre_producto: productoParaCarrito.nombre,
        cantidad:        cant,
        precio_unitario: productoParaCarrito.precio_venta,
        precio_compra:   productoParaCarrito.precio_compra || 0,
        unidad:          productoParaCarrito.unidad
      });
    }
    productoParaCarrito = null;
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
        <div class="cart-item-name">${item.nombre_producto}</div>
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
  if (v > 0) carrito[i].cantidad = v;
  renderCarrito();
};
window.eliminarCarrito  = function(i) { carrito.splice(i, 1); renderCarrito(); };
window.limpiarCarrito   = function() {
  carrito = [];
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
  const efectivo = parseFloat($('cart-efectivo').value) || null;
  const medio_pago = document.querySelector('input[name="medio_pago"]:checked')?.value || 'efectivo';
  const ahora    = new Date();
  const resumen  = carrito.map(c => `${c.nombre_producto} x${c.cantidad}`).join(', ');

  const ventaRef = await addDoc(collection(db(), 'ventas'), {
    items:             carrito.map(c => ({ ...c })),
    productos_resumen: resumen,
    subtotal:          sub,
    descuento:         desc,
    total,
    medio_pago,
    efectivo:          efectivo || 0,
    vuelto:            efectivo ? efectivo - total : 0,
    anulada:           false,
    fecha:             serverTimestamp(),
    fecha_key:         fechaLocal(ahora)
  });

  // Descontar stock — actualiza Firestore Y caché local en paralelo por producto
  const stockUpdates = [];
  for (const item of carrito) {
    if (item._ancheta_id) {
      for (const sub of (item._ancheta_items || [])) {
        stockUpdates.push(
          (async () => {
            const prodRef  = doc(db(), 'productos', sub.producto_id);
            const prodSnap = await getDoc(prodRef);
            if (prodSnap.exists()) {
              const nuevoStock = Math.max(0, (prodSnap.data().stock || 0) - (sub.cantidad * item.cantidad));
              await updateDoc(prodRef, { stock: nuevoStock });
              // Actualizar caché
              const idx = _productosCache?.findIndex(p => p.id === sub.producto_id);
              if (idx !== undefined && idx >= 0) _productosCache[idx].stock = nuevoStock;
            }
          })()
        );
      }
    } else {
      stockUpdates.push(
        (async () => {
          const prodRef  = doc(db(), 'productos', item.producto_id);
          const prodSnap = await getDoc(prodRef);
          if (prodSnap.exists()) {
            const nuevoStock = Math.max(0, (prodSnap.data().stock || 0) - item.cantidad);
            await updateDoc(prodRef, { stock: nuevoStock });
            const idx = _productosCache?.findIndex(p => p.id === item.producto_id);
            if (idx !== undefined && idx >= 0) _productosCache[idx].stock = nuevoStock;
          }
        })()
      );
    }
  }
  await Promise.all(stockUpdates);
  productos = _productosCache || [];

  showMsg('venta-msg', `✓ Venta registrada. Total: ${fmtCOP(total)}`, 'ok');
  if (confirm('Venta registrada. ¿Descargar factura PDF?')) {
    await imprimirFactura(ventaRef.id);
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

  const desde = `${calAnio}-${String(calMes).padStart(2,'0')}-01`;
  const hasta = `${calAnio}-${String(calMes).padStart(2,'0')}-31`;
  const todasVentas = await getVentasRango(desde, hasta);
  const ventas = todasVentas.filter(v => !v.anulada);

  const ventasPorDia = {};
  ventas.forEach(v => {
    const key = v.fecha_key;
    if (!ventasPorDia[key]) ventasPorDia[key] = { total: 0, num_ventas: 0 };
    ventasPorDia[key].total      += v.total || 0;
    ventasPorDia[key].num_ventas += 1;
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
  const masVendido = [...detalle].sort((a, b) => b.vendido - a.vendido)[0]?.nombre || '—';
  const hoy        = fechaLocal();

  await setDoc(doc(db(), 'cierres', hoy), {
    fecha: hoy, total_ventas: total,
    num_transacciones: transacciones,
    ganancia_total: ganancia, detalle,
    creado: serverTimestamp()
  });

  $('cierre-resultado').style.display = 'block';
  $('cierre-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon green">$</div><div class="stat-data"><span class="stat-val">${fmtCOP(total)}</span><span class="stat-label">Total ventas</span></div></div>
    <div class="stat-card"><div class="stat-icon blue">◎</div><div class="stat-data"><span class="stat-val">${transacciones}</span><span class="stat-label">Transacciones</span></div></div>
    <div class="stat-card"><div class="stat-icon teal">↑</div><div class="stat-data"><span class="stat-val">${fmtCOP(ganancia)}</span><span class="stat-label">Ganancia</span></div></div>
    <div class="stat-card"><div class="stat-icon amber">★</div><div class="stat-data"><span class="stat-val" style="font-size:1rem">${masVendido}</span><span class="stat-label">Más vendido</span></div></div>
  `;

  const tbody = $('cierre-detalle-body');
  tbody.innerHTML = detalle.length === 0
    ? '<tr><td colspan="3" class="empty">Sin datos</td></tr>'
    : detalle.map(d => `<tr><td>${d.nombre}</td><td>${d.vendido}</td><td style="color:var(--green)">${fmtCOP(d.ganancia)}</td></tr>`).join('');

  loadCierreHistorial();
};

async function loadCierreHistorial() {
  const snap    = await getDocs(query(collection(db(), 'cierres'), orderBy('fecha', 'desc')));
  const cierres = snap.docs.map(d => d.data());
  const tbody   = $('cierre-historial-body');
  tbody.innerHTML = cierres.length === 0
    ? '<tr><td colspan="4" class="empty">Sin cierres registrados</td></tr>'
    : cierres.map(c => `
        <tr>
          <td>${c.fecha}</td>
          <td style="color:var(--teal)">${fmtCOP(c.total_ventas)}</td>
          <td>${c.num_transacciones}</td>
          <td style="color:var(--green)">${fmtCOP(c.ganancia_total)}</td>
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
   ANCHETAS
═══════════════════════════════════════════════════════ */
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

function productoConCodigo(codigo, exceptoId = null) {
  const buscado = limpiarCodigo(codigo);
  if (!buscado) return null;
  return productos.find(p => limpiarCodigo(p.codigo_barras) === buscado && p.id !== exceptoId) || null;
}

function codigoProductoActual(p) {
  return limpiarCodigo(p?.codigo_barras || '');
}

function crearCodigoUnico() {
  let codigo = '';
  do {
    const tiempo = Date.now().toString(36).toUpperCase();
    const azar = Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, '0');
    codigo = `SH${tiempo}${azar}`;
  } while (productoConCodigo(codigo));
  return codigo;
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
  actualizarPreviewCodigo();
  renderEtiquetasCodigo();
}

window.filtrarProductosCodigo = function() {
  const input = $('cod-search');
  const cont = $('cod-sugerencias');
  if (!input || !cont) return;

  const q = input.value.trim().toLowerCase();
  if (q.length < 1) { cont.innerHTML = ''; return; }

  const encontrados = productos
    .filter(p =>
      p.nombre.toLowerCase().includes(q) ||
      (p.categoria || '').toLowerCase().includes(q) ||
      (p.codigo_barras || '').toLowerCase().includes(q))
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

window.generarCodigoProducto = function() {
  if (!codigoProductoId) {
    showMsg('cod-msg', 'Selecciona un producto antes de generar el código.', 'error');
    return;
  }
  $('cod-valor').value = crearCodigoUnico();
  actualizarPreviewCodigo();
  showMsg('cod-msg', 'Código generado. Guárdalo en el producto antes de imprimir.', 'ok');
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

  await updateDoc(doc(db(), 'productos', p.id), { codigo_barras: codigo });
  actualizarCodigoLocal(p.id, codigo);
  showMsg('cod-msg', 'Código guardado en el producto.', 'ok');
  actualizarPreviewCodigo();
};

window.agregarEtiquetaCodigo = function() {
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

  if (codigoProductoActual(p) !== codigo) {
    showMsg('cod-msg', 'Guarda el código en el producto antes de añadir etiquetas.', 'warn');
    return;
  }

  const cantidad = Math.max(1, Math.min(100, parseInt($('cod-cantidad').value, 10) || 1));
  for (let i = 0; i < cantidad; i++) {
    etiquetasCodigo.push({
      producto_id: p.id,
      nombre: p.nombre,
      codigo,
      precio_venta: p.precio_venta || 0
    });
  }
  renderEtiquetasCodigo();
  showMsg('cod-msg', `${cantidad} etiqueta${cantidad > 1 ? 's' : ''} añadida${cantidad > 1 ? 's' : ''}.`, 'ok');
};

function etiquetaCodigoHtml(item, i, modo = 'lista') {
  const svgId = modo === 'print' ? `cod-print-svg-${i}` : `cod-label-svg-${i}`;
  const quitar = modo === 'print' ? '' : `<button class="btn-icon del" onclick="quitarEtiquetaCodigo(${i})">Quitar</button>`;
  return `<div class="barcode-label-card">
    <div class="barcode-label-top">
      <strong>${escapeHtml(item.nombre)}</strong>
      ${quitar}
    </div>
    <svg id="${svgId}" class="barcode-svg small" role="img" aria-label="Código de barras ${escapeHtml(item.codigo)}"></svg>
    <div class="barcode-label-bottom">
      <span>${escapeHtml(item.codigo)}</span>
      <span>${fmtCOP(item.precio_venta)}</span>
    </div>
  </div>`;
}

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

window.quitarEtiquetaCodigo = function(i) {
  etiquetasCodigo.splice(i, 1);
  renderEtiquetasCodigo();
};

window.limpiarEtiquetasCodigo = function() {
  etiquetasCodigo = [];
  renderEtiquetasCodigo();
  const sheet = $('cod-print-sheet');
  if (sheet) sheet.innerHTML = '';
};

window.imprimirEtiquetasCodigo = function() {
  if (etiquetasCodigo.length === 0) {
    showMsg('cod-msg', 'Añade al menos una etiqueta antes de imprimir.', 'error');
    return;
  }

  const sheet = $('cod-print-sheet');
  sheet.innerHTML = etiquetasCodigo.map((item, i) => etiquetaCodigoHtml(item, i, 'print')).join('');
  etiquetasCodigo.forEach((item, i) => renderSvgCodigo(`cod-print-svg-${i}`, item.codigo, { width: 0.9, height: 32, margin: 1 }));

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
    if (e.target === this) this.classList.remove('open');
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

  // Dashboard usa los mismos datos + ventas hoy (query fresca)
  loadDashboard();
  renderCarrito();
};
