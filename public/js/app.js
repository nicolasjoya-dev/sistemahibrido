/* ════════════════════════════════════════════════════
   SistemaHíbrido — app.js  (Firestore edition)
   ════════════════════════════════════════════════════ */

// ── Firestore helpers (cargados desde index.html) ────
import {
  collection, doc, getDocs, getDoc, addDoc, setDoc,
  updateDoc, deleteDoc, query, where, orderBy,
  serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Esperar a que window.__db esté disponible (lo pone el módulo de Firebase en index.html)
function db() { return window.__db; }

// ── Utils ─────────────────────────────────────────────
const fmt    = n => Math.round(n || 0).toLocaleString('es-CO');
const fmtCOP = n => '$' + fmt(n);
const $      = id => document.getElementById(id);

function tsToDate(ts) {
  if (!ts) return new Date();
  if (ts instanceof Date) return ts;
  if (ts.toDate) return ts.toDate();          // Firestore Timestamp
  return new Date(ts);
}
function fmtHora(ts)      { return tsToDate(ts).toLocaleTimeString('es-CO',  { hour:'2-digit', minute:'2-digit' }); }
function fmtFecha(ts)     { return tsToDate(ts).toLocaleDateString('es-CO'); }
function fmtFechaHora(ts) { return fmtFecha(ts) + ' · ' + fmtHora(ts); }

// Clave de fecha local (Colombia) YYYY-MM-DD — sin conversión UTC
function fechaLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── State ─────────────────────────────────────────────
let productos = [];
let carrito   = [];
let editandoProductoId  = null;
let entradaProductoId   = null;
let productoParaCarrito = null;
let calAnio = new Date().getFullYear();
let calMes  = new Date().getMonth() + 1;

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
  if (name === 'dashboard') loadDashboard();
  if (name === 'inventario') loadInventario();
  if (name === 'calendario') renderCalendario();
  if (name === 'cierre')     loadCierreHistorial();
  if (name === 'ajustes')    loadAjustes();
};

// ── Messages ──────────────────────────────────────────
function showMsg(elId, text, type = 'ok') {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 3500);
}

/* ═══════════════════════════════════════════════════════
   PRODUCTOS
═══════════════════════════════════════════════════════ */

async function getProductos() {
  const snap = await getDocs(collection(db(), 'productos'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getProductosAlertas() {
  const todos = await getProductos();
  return todos.filter(p => p.stock <= p.stock_minimo);
}

/* ═══════════════════════════════════════════════════════
   VENTAS  (hoy y por fecha)
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
  // Comparamos fecha_key (string YYYY-MM-DD) directamente
  const snap = await getDocs(
    query(collection(db(), 'ventas'),
      where('fecha_key', '>=', desde),
      where('fecha_key', '<=', hasta),
      orderBy('fecha_key', 'desc'))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ═══════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════ */

async function loadDashboard() {
  const hoy = new Date();
  $('fecha-hoy').textContent = hoy.toLocaleDateString('es-CO', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const [prods, ventas] = await Promise.all([getProductos(), getVentasHoy()]);
  const alertas = prods.filter(p => p.stock <= p.stock_minimo);

  productos = prods;  // actualizar cache global

  $('d-productos').textContent  = prods.length;
  $('d-ventas-hoy').textContent = ventas.length;
  $('d-total-hoy').textContent  = fmtCOP(ventas.reduce((s, v) => s + (v.total || 0), 0));
  $('d-alertas').textContent    = alertas.length;

  const card = $('d-alertas-card');
  alertas.length > 0 ? card.classList.add('warn') : card.classList.remove('warn');

  // Alertas list
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

  // Ventas hoy
  const tbody = $('dash-ventas-body');
  if (ventas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin ventas hoy</td></tr>';
  } else {
    tbody.innerHTML = ventas.map((v, i) => `
      <tr>
        <td>#${i + 1}</td>
        <td>${fmtHora(v.fecha)}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen || '—'}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td><button class="btn-icon" onclick="imprimirFactura('${v.id}')">PDF</button></td>
      </tr>`).join('');
  }
}

/* ═══════════════════════════════════════════════════════
   INVENTARIO
═══════════════════════════════════════════════════════ */

async function loadInventario() {
  productos = await getProductos();
  renderInventario(productos);
}

function renderInventario(list) {
  const tbody = $('inv-body');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No hay productos registrados</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(p => {
    let estado, badge;
    if (p.stock === 0)                    { estado = 'Agotado'; badge = 'badge-agotado'; }
    else if (p.stock <= p.stock_minimo)   { estado = 'Bajo';    badge = 'badge-bajo'; }
    else                                  { estado = 'OK';      badge = 'badge-ok'; }
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

window.filtrarInventario = function() {
  const q = $('inv-search').value.toLowerCase();
  renderInventario(productos.filter(p =>
    p.nombre.toLowerCase().includes(q) ||
    (p.categoria || '').toLowerCase().includes(q) ||
    (p.codigo_barras || '').includes(q)
  ));
};

/* ═══════════════════════════════════════════════════════
   MODAL PRODUCTO  (crear / editar)
═══════════════════════════════════════════════════════ */

window.openModalProducto = function(id) {
  editandoProductoId = id || null;
  $('modal-titulo').textContent   = id ? 'Editar Producto' : 'Nuevo Producto';
  $('modal-save-btn').textContent = id ? 'Actualizar' : 'Guardar';
  $('modal-msg').innerHTML = '';
  $('margen-display') && ($('margen-display').style.display = 'none');
  ['p-nombre','p-categoria','p-compra','p-venta','p-stock','p-barras'].forEach(f => $(f).value = '');
  $('p-stockmin').value = 5;
  $('p-unidad').value = 'unidades';

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
  const compra = parseFloat($('p-compra').value) || 0;
  const venta  = parseFloat($('p-venta').value)  || 0;
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
    showMsg('inv-msg', 'Producto actualizado correctamente.', 'ok');
  } else {
    data.fecha_creacion = serverTimestamp();
    await addDoc(collection(db(), 'productos'), data);
    showMsg('inv-msg', 'Producto creado correctamente.', 'ok');
  }
  closeModal('modal-producto');
  loadInventario();
};

window.eliminarProducto = async function(id) {
  if (!confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) return;
  await deleteDoc(doc(db(), 'productos', id));
  showMsg('inv-msg', 'Producto eliminado.', 'warn');
  loadInventario();
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

  // Historial de entradas (subcolección del producto)
  const snap = await getDocs(
    query(collection(db(), 'productos', id, 'entradas'), orderBy('fecha', 'desc'))
  );
  const entradas = snap.docs.map(d => d.data());
  const tbody = $('ent-historial-body');
  if (entradas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin historial</td></tr>';
  } else {
    tbody.innerHTML = entradas.slice(0, 10).map(e => `
      <tr>
        <td>${fmtFecha(e.fecha)}</td>
        <td>+${e.cantidad}</td>
        <td>${e.precio_compra ? fmtCOP(e.precio_compra) : '—'}</td>
        <td style="color:var(--muted)">${e.nota || '—'}</td>
      </tr>`).join('');
  }
  openModal('modal-entrada');
};

window.guardarEntrada = async function() {
  const cantidad = parseFloat($('ent-cantidad').value);
  if (!cantidad || cantidad <= 0) { alert('Ingresa una cantidad válida'); return; }

  const precio_compra = parseFloat($('ent-precio').value) || null;
  const nota          = $('ent-nota').value.trim() || null;

  // 1. Guardar entrada en subcolección
  await addDoc(collection(db(), 'productos', entradaProductoId, 'entradas'), {
    cantidad,
    precio_compra: precio_compra || 0,
    nota: nota || '',
    fecha: serverTimestamp()
  });

  // 2. Actualizar stock (y precio_compra si se indicó)
  const prodRef = doc(db(), 'productos', entradaProductoId);
  const prodSnap = await getDoc(prodRef);
  const stockActual = prodSnap.data().stock || 0;
  const update = { stock: stockActual + cantidad };
  if (precio_compra) update.precio_compra = precio_compra;
  await updateDoc(prodRef, update);

  closeModal('modal-entrada');
  showMsg('inv-msg', `Entrada de ${cantidad} unidades registrada.`, 'ok');
  loadInventario();
};

/* ═══════════════════════════════════════════════════════
   VENTAS / CARRITO
═══════════════════════════════════════════════════════ */

window.buscarProductoVenta = function() {
  const q    = $('venta-buscar').value.trim();
  const cont = $('venta-sugerencias');
  if (q.length < 1) { cont.innerHTML = ''; return; }

  // Búsqueda local sobre cache de productos
  const filtrados = productos
    .filter(p => p.nombre.toLowerCase().includes(q.toLowerCase()) ||
                 (p.codigo_barras || '').includes(q))
    .slice(0, 8);

  if (filtrados.length === 0) {
    cont.innerHTML = '<div class="sugerencias-list"><div class="sugerencia-item" style="color:var(--muted)">Sin resultados</div></div>';
    return;
  }
  cont.innerHTML = `<div class="sugerencias-list">${filtrados.map(p => `
    <div class="sugerencia-item" onclick='abrirModalCantidad(${JSON.stringify(p)})'>
      <div>
        <div>${p.nombre}</div>
        <div class="sug-stock">${p.stock} ${p.unidad} disponibles</div>
      </div>
      <span class="sug-precio">${fmtCOP(p.precio_venta)}</span>
    </div>`).join('')}</div>`;
};

window.abrirModalCantidad = function(p) {
  productoParaCarrito = p;
  $('mcant-nombre').textContent = p.nombre;
  $('mcant-label').textContent  = `Cantidad (${p.unidad})`;
  $('mcant-stock').textContent  = `${p.stock} ${p.unidad}`;
  $('mcant-val').value = 1;
  $('venta-sugerencias').innerHTML = '';
  openModal('modal-cantidad');
};

window.confirmarAgregarCarrito = function() {
  const cant = parseFloat($('mcant-val').value);
  if (!cant || cant <= 0)             { alert('Cantidad inválida'); return; }
  if (cant > productoParaCarrito.stock) { alert('Stock insuficiente'); return; }

  const existing = carrito.find(c => c.producto_id === productoParaCarrito.id);
  if (existing) {
    existing.cantidad += cant;
  } else {
    carrito.push({
      producto_id:      productoParaCarrito.id,
      nombre_producto:  productoParaCarrito.nombre,
      cantidad:         cant,
      precio_unitario:  productoParaCarrito.precio_venta,
      precio_compra:    productoParaCarrito.precio_compra || 0,
      unidad:           productoParaCarrito.unidad
    });
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

window.eliminarCarrito = function(i) {
  carrito.splice(i, 1);
  renderCarrito();
};

window.limpiarCarrito = function() {
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

window.confirmarVenta = async function() {
  if (carrito.length === 0) { alert('El carrito está vacío'); return; }

  const sub     = carrito.reduce((s, c) => s + c.cantidad * c.precio_unitario, 0);
  const descVal = parseFloat($('cart-descuento').value) || 0;
  const tipo    = $('cart-desc-tipo').value;
  const desc    = tipo === 'pct' ? (sub * descVal / 100) : descVal;
  const total   = Math.max(0, sub - desc);
  const efectivo = parseFloat($('cart-efectivo').value) || null;
  const ahora   = new Date();

  const resumen = carrito.map(c => `${c.nombre_producto} x${c.cantidad}`).join(', ');

  // 1. Guardar venta
  const ventaRef = await addDoc(collection(db(), 'ventas'), {
    items:             carrito.map(c => ({ ...c })),
    productos_resumen: resumen,
    subtotal:          sub,
    descuento:         desc,
    total,
    efectivo:          efectivo || 0,
    vuelto:            efectivo ? efectivo - total : 0,
    fecha:             serverTimestamp(),
    fecha_key:         fechaLocal(ahora)   // para queries por día
  });

  // 2. Descontar stock de cada producto
  for (const item of carrito) {
    const prodRef  = doc(db(), 'productos', item.producto_id);
    const prodSnap = await getDoc(prodRef);
    if (prodSnap.exists()) {
      const nuevoStock = (prodSnap.data().stock || 0) - item.cantidad;
      await updateDoc(prodRef, { stock: Math.max(0, nuevoStock) });
    }
  }

  showMsg('venta-msg', `✓ Venta registrada. Total: ${fmtCOP(total)}`, 'ok');

  if (confirm('Venta registrada. ¿Descargar factura PDF?')) {
    await imprimirFactura(ventaRef.id);
  }

  limpiarCarrito();
  // Actualizar cache de productos
  productos = await getProductos();
};

/* ═══════════════════════════════════════════════════════
   FACTURA  (generación en navegador con window.print)
   — Sin servidor. Si quieres PDF real instala jsPDF.
═══════════════════════════════════════════════════════ */

window.imprimirFactura = async function(ventaId) {
  const ventaSnap = await getDoc(doc(db(), 'ventas', ventaId));
  if (!ventaSnap.exists()) { alert('Venta no encontrada'); return; }
  const v = ventaSnap.data();

  // Ajustes del negocio
  const ajSnap = await getDoc(doc(db(), 'ajustes', 'negocio'));
  const aj     = ajSnap.exists() ? ajSnap.data() : {};

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
    </style>
  </head><body>
    <h2>${aj.nombre_negocio || 'Miscelánea'}</h2>
    <p>${aj.direccion || ''}</p>
    <p>${aj.telefono  || ''}</p>
    <hr/>
    <p>Fecha: ${fmtFechaHora(v.fecha)}</p>
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

  // Traer ventas del mes completo
  const desde = `${calAnio}-${String(calMes).padStart(2,'0')}-01`;
  const hasta = `${calAnio}-${String(calMes).padStart(2,'0')}-31`;
  const ventas = await getVentasRango(desde, hasta);

  // Agrupar por día
  const ventasPorDia = {};
  ventas.forEach(v => {
    const key = v.fecha_key;
    if (!ventasPorDia[key]) ventasPorDia[key] = { total: 0, num_ventas: 0 };
    ventasPorDia[key].total      += v.total || 0;
    ventasPorDia[key].num_ventas += 1;
  });

  const primerDia  = new Date(calAnio, calMes - 1, 1).getDay();
  const diasEnMes  = new Date(calAnio, calMes, 0).getDate();
  const hoy        = new Date();
  const esHoy      = d => hoy.getFullYear() === calAnio && hoy.getMonth()+1 === calMes && hoy.getDate() === d;

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
  const ventas = await getVentasPorFecha(fecha);
  $('cal-detalle-titulo').textContent = `Ventas del ${dia}`;
  const tbody = $('cal-detalle-body');
  if (ventas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Sin ventas este día</td></tr>';
  } else {
    tbody.innerHTML = ventas.map((v, i) => `
      <tr>
        <td>#${i + 1}</td>
        <td>${fmtHora(v.fecha)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen || '—'}</td>
        <td>${v.descuento > 0 ? fmtCOP(v.descuento) : '—'}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td><button class="btn-icon" onclick="imprimirFactura('${v.id}')">PDF</button></td>
      </tr>`).join('');
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

  const ventas = await getVentasRango(desde, hasta);
  const total  = ventas.reduce((s, v) => s + (v.total || 0), 0);

  $('inf-num').textContent   = ventas.length;
  $('inf-total').textContent = fmtCOP(total);
  $('inf-resumen').style.display = 'grid';

  const cont = $('inf-lista');
  if (ventas.length === 0) {
    cont.innerHTML = '<div class="empty">Sin ventas en el período seleccionado</div>';
    return;
  }
  cont.innerHTML = ventas.map(v => `
    <div class="inf-venta-card">
      <div class="inf-venta-header">
        <div>
          <span class="inf-venta-id">Venta</span>
          <span class="inf-venta-hora" style="margin-left:12px">${fmtFechaHora(v.fecha)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="inf-venta-total">${fmtCOP(v.total)}</span>
          <button class="btn-icon" onclick="imprimirFactura('${v.id}')">PDF</button>
        </div>
      </div>
      <div class="inf-venta-items">${v.productos_resumen || '—'}</div>
      ${v.descuento > 0 ? `<div class="inf-venta-desc">Descuento aplicado: ${fmtCOP(v.descuento)}</div>` : ''}
    </div>`).join('');
};

/* ═══════════════════════════════════════════════════════
   CIERRE DEL DÍA
═══════════════════════════════════════════════════════ */

window.ejecutarCierre = async function() {
  const ventas = await getVentasHoy();
  if (ventas.length === 0) { alert('No hay ventas registradas hoy.'); return; }

  const total         = ventas.reduce((s, v) => s + (v.total || 0), 0);
  const transacciones = ventas.length;

  // Calcular ganancia y desglose por producto
  const desglose = {};
  ventas.forEach(v => {
    (v.items || []).forEach(item => {
      const k = item.nombre_producto;
      if (!desglose[k]) desglose[k] = { vendido: 0, ganancia: 0 };
      desglose[k].vendido  += item.cantidad;
      desglose[k].ganancia += item.cantidad * ((item.precio_unitario || 0) - (item.precio_compra || 0));
    });
  });

  const detalle   = Object.entries(desglose).map(([nombre, d]) => ({ nombre, ...d }));
  const ganancia  = detalle.reduce((s, d) => s + d.ganancia, 0);
  const masVendido = detalle.sort((a, b) => b.vendido - a.vendido)[0]?.nombre || '—';

  const hoy = fechaLocal();

  // Guardar cierre en Firestore
  await setDoc(doc(db(), 'cierres', hoy), {
    fecha:             hoy,
    total_ventas:      total,
    num_transacciones: transacciones,
    ganancia_total:    ganancia,
    detalle,
    creado:            serverTimestamp()
  });

  // Mostrar resultado
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
    : detalle.map(d => `
        <tr>
          <td>${d.nombre}</td>
          <td>${d.vendido}</td>
          <td style="color:var(--green)">${fmtCOP(d.ganancia)}</td>
        </tr>`).join('');

  loadCierreHistorial();
};

async function loadCierreHistorial() {
  const snap = await getDocs(
    query(collection(db(), 'cierres'), orderBy('fecha', 'desc'))
  );
  const cierres = snap.docs.map(d => d.data());
  const tbody   = $('cierre-historial-body');
  if (cierres.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin cierres registrados</td></tr>';
    return;
  }
  tbody.innerHTML = cierres.map(c => `
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
  const snap = await getDoc(doc(db(), 'ajustes', 'negocio'));
  if (!snap.exists()) return;
  const data = snap.data();
  $('aj-nombre').value    = data.nombre_negocio || '';
  $('aj-direccion').value = data.direccion || '';
  $('aj-telefono').value  = data.telefono  || '';
}

window.guardarAjustes = async function() {
  await setDoc(doc(db(), 'ajustes', 'negocio'), {
    nombre_negocio: $('aj-nombre').value.trim(),
    direccion:      $('aj-direccion').value.trim(),
    telefono:       $('aj-telefono').value.trim()
  });
  showMsg('ajustes-msg', 'Ajustes guardados correctamente.', 'ok');
};

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
   INIT  — llamado desde index.html tras autenticación
═══════════════════════════════════════════════════════ */

window.initApp = async function() {
  const hoy = new Date().toISOString().split('T')[0];
  $('inf-desde').value = hoy;
  $('inf-hasta').value = hoy;

  // Precargar productos en cache global
  productos = await getProductos();

  loadDashboard();
  renderCarrito();
};