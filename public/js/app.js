/* ════════════════════════════════════════════════════
   SistemaHíbrido — app.js
   ════════════════════════════════════════════════════ */

// ── Utils ─────────────────────────────────────────────
const fmt = n => Math.round(n || 0).toLocaleString('es-CO');
const fmtCOP = n => '$' + fmt(n);
const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────
let productos = [];
let carrito = [];
let editandoProductoId = null;
let entradaProductoId = null;
let productoParaCarrito = null;
let calAnio = new Date().getFullYear();
let calMes = new Date().getMonth() + 1;

// ── Connection status ─────────────────────────────────
function updateConnStatus() {
  const el = $('conn-status');
  if (navigator.onLine) {
    el.textContent = '● Online';
    el.classList.remove('offline');
  } else {
    el.textContent = '● Offline';
    el.classList.add('offline');
  }
}
window.addEventListener('online',  updateConnStatus);
window.addEventListener('offline', updateConnStatus);
updateConnStatus();

// ── API calls ─────────────────────────────────────────
async function api(method, url, body) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return await res.json();
  } catch (e) {
    console.error('API error', e);
    return null;
  }
}

// ── Navigation ────────────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('tab-' + name).classList.add('active');
  if (el) el.classList.add('active');
  // Load tab data
  if (name === 'dashboard') loadDashboard();
  if (name === 'inventario') loadInventario();
  if (name === 'ventas') setTimeout(() => { const f = $('venta-buscar'); if (f) f.focus(); }, 100);
  if (name === 'calendario') renderCalendario();
  if (name === 'cierre') loadCierreHistorial();
  if (name === 'ajustes') loadAjustes();
}

// ── Messages ──────────────────────────────────────────
function showMsg(elId, text, type = 'ok') {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 3500);
}

// ── DASHBOARD ─────────────────────────────────────────
async function loadDashboard() {
  const hoy = new Date();
  $('fecha-hoy').textContent = hoy.toLocaleDateString('es-CO', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const [prods, alertas, ventas] = await Promise.all([
    api('GET', '/api/productos'),
    api('GET', '/api/productos/alertas/stock'),
    api('GET', '/api/ventas')
  ]);

  if (!prods || !alertas || !ventas) return;

  $('d-productos').textContent = prods.length;
  $('d-ventas-hoy').textContent = ventas.length;
  $('d-total-hoy').textContent  = fmtCOP(ventas.reduce((s, v) => s + v.total, 0));
  $('d-alertas').textContent    = alertas.length;

  const card = $('d-alertas-card');
  if (alertas.length > 0) card.classList.add('warn'); else card.classList.remove('warn');

  // Alertas list
  const alertEl = $('dash-alertas-list');
  if (alertas.length === 0) {
    alertEl.innerHTML = '<div class="empty">✓ Todo el stock está en niveles normales</div>';
  } else {
    alertEl.innerHTML = alertas.map(p => {
      const tipo = p.stock === 0 ? 'agotado' : 'bajo';
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
    tbody.innerHTML = ventas.map(v => `
      <tr>
        <td>#${v.id}</td>
        <td>${new Date(v.fecha).toLocaleTimeString('es-CO', {hour:'2-digit',minute:'2-digit'})}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen || '—'}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td><a href="/api/facturas/${v.id}" target="_blank" class="btn-icon">PDF</a></td>
      </tr>`).join('');
  }
}

// ── INVENTARIO ────────────────────────────────────────
async function loadInventario() {
  productos = await api('GET', '/api/productos') || [];
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
    if (p.stock === 0)           { estado = 'agotado'; badge = 'badge-agotado'; }
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
        <button class="btn-icon" onclick="openModalProducto(${p.id})">Editar</button>
        <button class="btn-icon" onclick="openModalEntrada(${p.id})">+Stock</button>
        <button class="btn-icon del" onclick="eliminarProducto(${p.id})">Eliminar</button>
      </td>
    </tr>`;
  }).join('');
}

function filtrarInventario() {
  const q = $('inv-search').value.toLowerCase();
  renderInventario(productos.filter(p => p.nombre.toLowerCase().includes(q) || (p.categoria||'').toLowerCase().includes(q) || (p.codigo_barras||'').includes(q)));
}

// ── MODAL PRODUCTO ────────────────────────────────────
function openModalProducto(id) {
  editandoProductoId = id || null;
  $('modal-titulo').textContent = id ? 'Editar Producto' : 'Nuevo Producto';
  $('modal-save-btn').textContent = id ? 'Actualizar' : 'Guardar';
  $('modal-msg').innerHTML = '';
  ['p-nombre','p-categoria','p-compra','p-venta','p-stock','p-stockmin','p-barras','p-margen'].forEach(f => $(f).value = '');
  $('p-stockmin').value = 5;
  $('p-unidad').value = 'unidades';
  $('p-venta-sugerido').textContent = '';

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
      // Prefill margen if compra > 0
      if (p.precio_compra > 0 && p.precio_venta > 0) {
        const margen = Math.round(((p.precio_venta - p.precio_compra) / p.precio_compra) * 100);
        $('p-margen').value = margen;
        $('p-venta-sugerido').textContent = '';
      }
    }
  }
  openModal('modal-producto');
}

async function guardarProducto() {
  const nombre = $('p-nombre').value.trim();
  const precio_venta = parseFloat($('p-venta').value);
  if (!nombre || isNaN(precio_venta)) {
    showMsg('modal-msg', 'Nombre y precio de venta son obligatorios.', 'error');
    return;
  }
  const body = {
    nombre,
    categoria:     $('p-categoria').value.trim() || null,
    precio_compra: parseFloat($('p-compra').value) || 0,
    precio_venta,
    stock:         parseInt($('p-stock').value) || 0,
    stock_minimo:  parseInt($('p-stockmin').value) || 5,
    codigo_barras: $('p-barras').value.trim() || null,
    unidad:        $('p-unidad').value
  };

  if (editandoProductoId) {
    await api('PUT', `/api/productos/${editandoProductoId}`, body);
    showMsg('inv-msg', 'Producto actualizado correctamente.', 'ok');
  } else {
    await api('POST', '/api/productos', body);
    showMsg('inv-msg', 'Producto creado correctamente.', 'ok');
  }
  closeModal('modal-producto');
  loadInventario();
}

async function eliminarProducto(id) {
  if (!confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) return;
  await api('DELETE', `/api/productos/${id}`);
  showMsg('inv-msg', 'Producto eliminado.', 'warn');
  loadInventario();
}

// ── MARGEN DE GANANCIA ────────────────────────────────
function calcPrecioSugerido() {
  const compra = parseFloat($('p-compra').value) || 0;
  const margen = parseFloat($('p-margen').value) || 0;
  const el = $('p-venta-sugerido');
  if (compra > 0 && margen > 0) {
    const sugerido = Math.ceil(compra * (1 + margen / 100));
    el.textContent = `→ Sugerido: ${fmtCOP(sugerido)}`;
    el._sugerido = sugerido;
  } else {
    el.textContent = '';
    el._sugerido = null;
  }
}

function aplicarPrecioSugerido() {
  const sugerido = $('p-venta-sugerido')._sugerido;
  if (sugerido) $('p-venta').value = sugerido;
}

function calcEntradaSugerido() {
  const compra = parseFloat($('ent-precio').value) || 0;
  const margen = parseFloat($('ent-margen').value) || 0;
  const el = $('ent-venta-sugerido');
  if (compra > 0 && margen > 0) {
    const sugerido = Math.ceil(compra * (1 + margen / 100));
    el.textContent = `→ Nuevo P. Venta: ${fmtCOP(sugerido)}`;
    el._sugerido = sugerido;
  } else {
    el.textContent = '';
    el._sugerido = null;
  }
}

function aplicarEntradaSugerido() {
  const sugerido = $('ent-venta-sugerido')._sugerido;
  if (!sugerido) { alert('Ingresa precio de compra y margen primero'); return; }
  if (!confirm(`¿Actualizar el precio de venta a ${fmtCOP(sugerido)}?`)) return;
  // Store in a data attribute to be sent with the entrada
  $('ent-venta-sugerido')._aplicar = sugerido;
  alert(`✓ Se actualizará el precio de venta a ${fmtCOP(sugerido)} al guardar.`);
}

// ── MODAL ENTRADA INVENTARIO ──────────────────────────
async function openModalEntrada(id) {
  entradaProductoId = id;
  const p = productos.find(x => x.id === id);
  $('entrada-prod-nombre').textContent = p ? `${p.nombre} — Stock actual: ${p.stock} ${p.unidad}` : '';
  $('ent-cantidad').value = '';
  $('ent-precio').value   = p ? p.precio_compra : '';
  $('ent-nota').value     = '';
  $('ent-margen').value   = '';
  $('ent-venta-sugerido').textContent = '';
  $('ent-venta-sugerido')._sugerido = null;
  $('ent-venta-sugerido')._aplicar  = null;

  // Historial
  const entradas = await api('GET', `/api/productos/${id}/entradas`) || [];
  const tbody = $('ent-historial-body');
  if (entradas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin historial</td></tr>';
  } else {
    tbody.innerHTML = entradas.slice(0,10).map(e => `
      <tr>
        <td>${new Date(e.fecha).toLocaleDateString('es-CO')}</td>
        <td>+${e.cantidad}</td>
        <td>${e.precio_compra ? fmtCOP(e.precio_compra) : '—'}</td>
        <td style="color:var(--muted)">${e.nota || '—'}</td>
      </tr>`).join('');
  }
  openModal('modal-entrada');
}

async function guardarEntrada() {
  const cantidad = parseFloat($('ent-cantidad').value);
  if (!cantidad || cantidad <= 0) { alert('Ingresa una cantidad válida'); return; }
  await api('POST', `/api/productos/${entradaProductoId}/entrada`, {
    cantidad,
    precio_compra: parseFloat($('ent-precio').value) || null,
    nota: $('ent-nota').value.trim() || null
  });
  // If user chose to apply a new precio_venta from margen
  const nuevoPrecioVenta = $('ent-venta-sugerido')._aplicar;
  if (nuevoPrecioVenta) {
    const p = productos.find(x => x.id === entradaProductoId);
    if (p) {
      await api('PUT', `/api/productos/${entradaProductoId}`, {
        ...p,
        precio_venta: nuevoPrecioVenta,
        precio_compra: parseFloat($('ent-precio').value) || p.precio_compra
      });
    }
  }
  closeModal('modal-entrada');
  showMsg('inv-msg', `Entrada registrada${nuevoPrecioVenta ? ` · Precio venta actualizado a ${fmtCOP(nuevoPrecioVenta)}` : ''}.`, 'ok');
  loadInventario();
}

// ── VENTAS / CARRITO ──────────────────────────────────
async function buscarProductoVenta() {
  const q = $('venta-buscar').value.trim();
  const cont = $('venta-sugerencias');

  if (q.length < 1) { cont.innerHTML = ''; return; }

  // Barcode exact match
  if (/^\d{5,}$/.test(q)) {
    const p = await api('GET', `/api/productos/barcode/${q}`);
    if (p && p.id) { cont.innerHTML = ''; abrirModalCantidad(p); $('venta-buscar').value = ''; return; }
  }

  // Filter local
  const filtrados = (productos.length ? productos : await api('GET', '/api/productos') || [])
    .filter(p => p.nombre.toLowerCase().includes(q.toLowerCase()) || (p.codigo_barras||'').includes(q))
    .slice(0, 8);

  if (filtrados.length === 0) { cont.innerHTML = '<div class="sugerencias-list"><div class="sugerencia-item" style="color:var(--muted)">Sin resultados</div></div>'; return; }

  cont.innerHTML = `<div class="sugerencias-list">${filtrados.map(p => `
    <div class="sugerencia-item" onclick="abrirModalCantidad(${JSON.stringify(p).replace(/"/g,'&quot;')})">
      <div>
        <div>${p.nombre}</div>
        <div class="sug-stock">${p.stock} ${p.unidad} disponibles</div>
      </div>
      <span class="sug-precio">${fmtCOP(p.precio_venta)}</span>
    </div>`).join('')}</div>`;
}

function abrirModalCantidad(p) {
  productoParaCarrito = p;
  $('mcant-nombre').textContent = p.nombre;
  $('mcant-label').textContent  = `Cantidad (${p.unidad})`;
  $('mcant-stock').textContent  = `${p.stock} ${p.unidad}`;
  $('mcant-val').value = 1;
  $('venta-sugerencias').innerHTML = '';
  openModal('modal-cantidad');
}

function confirmarAgregarCarrito() {
  const cant = parseFloat($('mcant-val').value);
  if (!cant || cant <= 0) { alert('Cantidad inválida'); return; }
  if (cant > productoParaCarrito.stock) { alert('Stock insuficiente'); return; }

  const existing = carrito.find(c => c.producto_id === productoParaCarrito.id);
  if (existing) {
    existing.cantidad += cant;
  } else {
    carrito.push({
      producto_id: productoParaCarrito.id,
      nombre_producto: productoParaCarrito.nombre,
      cantidad: cant,
      precio_unitario: productoParaCarrito.precio_venta,
      unidad: productoParaCarrito.unidad
    });
  }
  closeModal('modal-cantidad');
  $('venta-buscar').value = '';
  renderCarrito();
}

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

function actualizarCantCarrito(i, val) {
  const v = parseFloat(val);
  if (v > 0) carrito[i].cantidad = v;
  renderCarrito();
}

function eliminarCarrito(i) {
  carrito.splice(i, 1);
  renderCarrito();
}

function limpiarCarrito() {
  carrito = [];
  $('cart-descuento').value = '';
  $('cart-efectivo').value  = '';
  $('cart-vuelto').textContent = '—';
  renderCarrito();
}

function recalcCarrito() {
  const sub = carrito.reduce((s, c) => s + c.cantidad * c.precio_unitario, 0);
  $('cart-sub').textContent = fmtCOP(sub);

  const descVal = parseFloat($('cart-descuento').value) || 0;
  const tipo = $('cart-desc-tipo').value;
  const desc = tipo === 'pct' ? (sub * descVal / 100) : descVal;

  const total = Math.max(0, sub - desc);
  $('cart-total').textContent = fmtCOP(total);
  calcVuelto();
  return { sub, desc, total };
}

function calcVuelto() {
  const { total } = recalcCarrito ? { total: parseFloat($('cart-total').textContent.replace(/[^0-9]/g,'')) } : { total: 0 };
  const efectivo = parseFloat($('cart-efectivo').value) || 0;
  if (efectivo > 0) {
    const vuelto = efectivo - total;
    $('cart-vuelto').textContent = fmtCOP(vuelto);
    $('cart-vuelto').style.color = vuelto >= 0 ? 'var(--green)' : 'var(--red)';
  } else {
    $('cart-vuelto').textContent = '—';
  }
}

async function confirmarVenta() {
  if (carrito.length === 0) { alert('El carrito está vacío'); return; }

  const sub = carrito.reduce((s, c) => s + c.cantidad * c.precio_unitario, 0);
  const descVal = parseFloat($('cart-descuento').value) || 0;
  const tipo = $('cart-desc-tipo').value;
  const desc = tipo === 'pct' ? (sub * descVal / 100) : descVal;
  const efectivo = parseFloat($('cart-efectivo').value) || null;

  const result = await api('POST', '/api/ventas', {
    items: carrito.map(c => ({ ...c })),
    descuento: desc,
    efectivo
  });

  if (!result || !result.id) { showMsg('venta-msg', 'Error al registrar la venta.', 'error'); return; }

  showMsg('venta-msg', `✓ Venta #${result.id} registrada. Total: ${fmtCOP(result.total)}`, 'ok');

  // Offer PDF
  if (confirm(`Venta registrada. ¿Descargar factura PDF?`)) {
    window.open(`/api/facturas/${result.id}`, '_blank');
  }

  limpiarCarrito();
  // Reload products to update stock
  productos = await api('GET', '/api/productos') || productos;
}

// ── CALENDARIO ────────────────────────────────────────
async function renderCalendario() {
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  $('cal-label').textContent = `${meses[calMes-1]} ${calAnio}`;

  const datos = await api('GET', `/api/ventas/calendario/mes?anio=${calAnio}&mes=${calMes}`) || [];
  const ventasPorDia = {};
  datos.forEach(d => { ventasPorDia[d.dia] = d; });

  const primerDia = new Date(calAnio, calMes - 1, 1).getDay();
  const diasEnMes = new Date(calAnio, calMes, 0).getDate();
  const hoy = new Date();
  const esHoy = (d) => hoy.getFullYear() === calAnio && hoy.getMonth()+1 === calMes && hoy.getDate() === d;

  let html = `<div class="cal-grid">
    ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
    ${Array(primerDia).fill('<div class="cal-cell empty"></div>').join('')}`;

  for (let d = 1; d <= diasEnMes; d++) {
    const key = `${calAnio}-${String(calMes).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const info = ventasPorDia[key];
    const clases = ['cal-cell', info ? 'has-sales' : '', esHoy(d) ? 'today' : ''].filter(Boolean).join(' ');
    html += `<div class="${clases}" onclick="verVentasDia('${key}', ${d})">
      <div class="cal-day-num">${d}</div>
      ${info ? `<div class="cal-total">${fmtCOP(info.total)}</div><div class="cal-txs">${info.num_ventas} venta${info.num_ventas>1?'s':''}</div>` : ''}
    </div>`;
  }
  html += '</div>';
  $('cal-grid').innerHTML = html;
  $('cal-detalle').style.display = 'none';
}

async function verVentasDia(fecha, dia) {
  const ventas = await api('GET', `/api/ventas?fecha=${fecha}`) || [];
  $('cal-detalle-titulo').textContent = `Ventas del ${dia}`;
  const tbody = $('cal-detalle-body');
  if (ventas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Sin ventas este día</td></tr>';
  } else {
    tbody.innerHTML = ventas.map(v => `
      <tr>
        <td>#${v.id}</td>
        <td>${new Date(v.fecha).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'})}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen||'—'}</td>
        <td>${v.descuento > 0 ? fmtCOP(v.descuento) : '—'}</td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td><a href="/api/facturas/${v.id}" target="_blank" class="btn-icon">PDF</a></td>
      </tr>`).join('');
  }
  $('cal-detalle').style.display = 'block';
  $('cal-detalle').scrollIntoView({ behavior: 'smooth' });
}

function cambiarMes(delta) {
  calMes += delta;
  if (calMes > 12) { calMes = 1; calAnio++; }
  if (calMes < 1)  { calMes = 12; calAnio--; }
  renderCalendario();
}

// ── INFORMES ──────────────────────────────────────────
async function cargarInformes() {
  const desde = $('inf-desde').value;
  const hasta = $('inf-hasta').value;
  if (!desde || !hasta) { alert('Selecciona un rango de fechas'); return; }

  const ventas = await api('GET', `/api/ventas?desde=${desde}&hasta=${hasta}`) || [];
  const total  = ventas.reduce((s, v) => s + v.total, 0);

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
          <span class="inf-venta-id">Venta #${v.id}</span>
          <span class="inf-venta-hora" style="margin-left:12px">${new Date(v.fecha).toLocaleDateString('es-CO')} · ${new Date(v.fecha).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="inf-venta-total">${fmtCOP(v.total)}</span>
          <a href="/api/facturas/${v.id}" target="_blank" class="btn-icon">PDF</a>
        </div>
      </div>
      <div class="inf-venta-items">${v.productos_resumen || '—'}</div>
      ${v.descuento > 0 ? `<div class="inf-venta-desc">Descuento aplicado: ${fmtCOP(v.descuento)}</div>` : ''}
    </div>`).join('');
}

// ── CIERRE DEL DÍA ────────────────────────────────────
async function ejecutarCierre() {
  const r = await api('POST', '/api/ventas/cierre/ejecutar');
  if (!r) return;

  $('cierre-resultado').style.display = 'block';
  $('cierre-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon green">$</div><div class="stat-data"><span class="stat-val">${fmtCOP(r.total)}</span><span class="stat-label">Total ventas</span></div></div>
    <div class="stat-card"><div class="stat-icon blue">◎</div><div class="stat-data"><span class="stat-val">${r.transacciones}</span><span class="stat-label">Transacciones</span></div></div>
    <div class="stat-card"><div class="stat-icon teal">↑</div><div class="stat-data"><span class="stat-val">${fmtCOP(r.ganancia)}</span><span class="stat-label">Ganancia</span></div></div>
    <div class="stat-card"><div class="stat-icon amber">★</div><div class="stat-data"><span class="stat-val" style="font-size:1rem">${r.masVendido||'—'}</span><span class="stat-label">Más vendido</span></div></div>
  `;

  const tbody = $('cierre-detalle-body');
  if (!r.detalle || r.detalle.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">Sin datos</td></tr>';
  } else {
    tbody.innerHTML = r.detalle.map(d => `
      <tr>
        <td>${d.nombre}</td>
        <td>${d.vendido}</td>
        <td style="color:var(--green)">${fmtCOP(d.ganancia)}</td>
      </tr>`).join('');
  }
  loadCierreHistorial();
}

async function loadCierreHistorial() {
  const cierres = await api('GET', '/api/ventas/cierre/historial') || [];
  const tbody = $('cierre-historial-body');
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

// ── AJUSTES ───────────────────────────────────────────
async function loadAjustes() {
  const data = await api('GET', '/api/ajustes');
  if (!data) return;
  $('aj-nombre').value    = data.nombre_negocio || '';
  $('aj-direccion').value = data.direccion || '';
  $('aj-telefono').value  = data.telefono || '';
}

async function guardarAjustes() {
  const body = {
    nombre_negocio: $('aj-nombre').value.trim(),
    direccion:      $('aj-direccion').value.trim(),
    telefono:       $('aj-telefono').value.trim()
  };
  await api('POST', '/api/ajustes', body);
  showMsg('ajustes-msg', 'Ajustes guardados correctamente.', 'ok');
}

// ── MODALS ────────────────────────────────────────────
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
});

// ── INIT ──────────────────────────────────────────────
(async function init() {
  // Set today's date in informe filters
  const hoy = new Date().toISOString().split('T')[0];
  $('inf-desde').value = hoy;
  $('inf-hasta').value = hoy;

  // Load products globally once
  productos = await api('GET', '/api/productos') || [];

  loadDashboard();
  renderCarrito();
})();