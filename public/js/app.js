/* ════════════════════════════════════════════════════
   SistemaHíbrido — app.js
   ════════════════════════════════════════════════════ */

// ── Utils ─────────────────────────────────────────────
const fmt = n => Math.round(n || 0).toLocaleString('es-CO');
const fmtCOP = n => '$' + fmt(n);
const $ = id => document.getElementById(id);

// SQLite ahora guarda fechas en hora Colombia (UTC-5) directamente.
function parseDBDate(str) {
  if (!str) return new Date();
  if (str.endsWith('Z')) return new Date(str);
  return new Date(str.replace(' ', 'T'));
}
function fmtHora(str)  { return parseDBDate(str).toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'}); }
function fmtFecha(str) { return parseDBDate(str).toLocaleDateString('es-CO'); }
function fmtFechaHora(str) { return fmtFecha(str) + ' · ' + fmtHora(str); }

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

  const MEDIO_LABEL = { efectivo: '💵 Efectivo', nequi: '📱 Nequi', daviplata: '📲 Daviplata' };
  const MEDIO_COLOR = { efectivo: 'var(--green)', nequi: '#8b5cf6', daviplata: '#e1306c' };

  // Ventas hoy
  const tbody = $('dash-ventas-body');
  if (ventas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Sin ventas hoy</td></tr>';
  } else {
    tbody.innerHTML = ventas.map(v => `
      <tr>
        <td>#${v.id}</td>
        <td>${fmtHora(v.fecha)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.productos_resumen || '—'}</td>
        <td><span style="font-size:0.8rem;color:${MEDIO_COLOR[v.medio_pago||'efectivo']}">${MEDIO_LABEL[v.medio_pago||'efectivo']}</span></td>
        <td><strong style="color:var(--teal)">${fmtCOP(v.total)}</strong></td>
        <td style="display:flex;gap:6px;align-items:center">
          <a href="/api/facturas/${v.id}" target="_blank" class="btn-icon">PDF</a>
          <button class="btn-icon del" onclick="eliminarVenta(${v.id})">Anular</button>
        </td>
      </tr>`).join('');
  }
}

// ── ELIMINAR VENTA ────────────────────────────────────
async function eliminarVenta(id) {
  if (!confirm(`¿Anular la Venta #${id}? El stock de los productos será devuelto.`)) return;
  const r = await api('DELETE', `/api/ventas/${id}`);
  if (r && r.mensaje) {
    showMsg('dash-msg', `✓ Venta #${id} anulada. Stock devuelto.`, 'ok');
    loadDashboard();
  } else {
    showMsg('dash-msg', 'Error al anular la venta.', 'error');
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
  ['p-nombre','p-categoria','p-compra','p-venta','p-stock','p-stockmin','p-barras'].forEach(f => $(f).value = '');
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

// ── MODAL ENTRADA INVENTARIO ──────────────────────────
async function openModalEntrada(id) {
  entradaProductoId = id;
  const p = productos.find(x => x.id === id);
  $('entrada-prod-nombre').textContent = p ? `${p.nombre} — Stock actual: ${p.stock} ${p.unidad}` : '';
  $('ent-cantidad').value = '';
  $('ent-precio').value   = p ? p.precio_compra : '';
  $('ent-nota').value     = '';

  // Historial
  const entradas = await api('GET', `/api/productos/${id}/entradas`) || [];
  const tbody = $('ent-historial-body');
  if (entradas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin historial</td></tr>';
  } else {
    tbody.innerHTML = entradas.slice(0,10).map(e => `
      <tr>
        <td>${fmtFecha(e.fecha)}</td>
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
  closeModal('modal-entrada');
  showMsg('inv-msg', `Entrada de ${cantidad} unidades registrada.`, 'ok');
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
    cont.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.88rem">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:500">Producto</th>
          <th style="text-align:center;padding:8px 6px;color:var(--muted);font-weight:500">Cant.</th>
          <th style="text-align:right;padding:8px 12px;color:var(--muted);font-weight:500">Subtotal</th>
          <th style="width:28px"></th>
        </tr>
      </thead>
      <tbody>
        ${carrito.map((item, i) => `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:10px 12px">
            <div style="font-weight:500">${item.nombre_producto}</div>
            <div style="font-size:0.78rem;color:var(--muted)">${fmtCOP(item.precio_unitario)} / ${item.unidad}</div>
          </td>
          <td style="padding:10px 6px;text-align:center">
            <input type="number" min="0.01" step="0.01" value="${item.cantidad}"
              style="width:58px;text-align:center;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surface2,#1a1b1f);color:var(--text);font-size:0.88rem"
              onchange="actualizarCantCarrito(${i}, this.value)"/>
          </td>
          <td style="padding:10px 12px;text-align:right;font-weight:600;color:var(--teal)">${fmtCOP(item.cantidad * item.precio_unitario)}</td>
          <td style="padding:10px 6px">
            <button onclick="eliminarCarrito(${i})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;padding:2px 4px" title="Quitar">✕</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }
  recalcCarrito();
  actualizarMedioPago();
}

function actualizarMedioPago() {
  const radios = document.querySelectorAll('input[name="medio_pago"]');
  let mp = 'efectivo';
  radios.forEach(r => {
    const btn = document.getElementById('mp-btn-' + r.value);
    if (!btn) return;
    if (r.checked) {
      mp = r.value;
      const COLORS = { efectivo: 'var(--teal)', nequi: '#8b5cf6', daviplata: '#e1306c' };
      const c = COLORS[r.value] || 'var(--teal)';
      btn.style.borderColor = c;
      btn.style.color = c;
      btn.style.background = `rgba(${r.value==='efectivo'?'0,201,167':r.value==='nequi'?'139,92,246':'225,48,108'},0.1)`;
    } else {
      btn.style.borderColor = 'var(--border)';
      btn.style.color = 'var(--muted)';
      btn.style.background = 'transparent';
    }
  });
  const bloqueEfectivo = $('bloque-efectivo');
  if (bloqueEfectivo) bloqueEfectivo.style.display = mp === 'efectivo' ? 'block' : 'none';
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
  $('cart-efectivo') && ($('cart-efectivo').value = '');
  $('cart-vuelto') && ($('cart-vuelto').textContent = '—');
  if ($('cart-medio-pago')) $('cart-medio-pago').value = 'efectivo';
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
  const medio_pago = (document.querySelector('input[name="medio_pago"]:checked') || {}).value || 'efectivo';
  const efectivo = (medio_pago === 'efectivo' && $('cart-efectivo')) ? parseFloat($('cart-efectivo').value) || null : null;

  const result = await api('POST', '/api/ventas', {
    items: carrito.map(c => ({ ...c })),
    descuento: desc,
    efectivo,
    medio_pago
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
        <td>${fmtHora(v.fecha)}</td>
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

  const MEDIO_LABEL = { efectivo: '💵 Efectivo', nequi: '📱 Nequi', daviplata: '📲 Daviplata' };
  const MEDIO_COLOR = { efectivo: 'var(--green)', nequi: '#8b5cf6', daviplata: '#e1306c' };

  cont.innerHTML = ventas.map(v => `
    <div class="inf-venta-card">
      <div class="inf-venta-header">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="inf-venta-id">Venta #${v.id}</span>
          <span class="inf-venta-hora">${fmtFecha(v.fecha)} · ${fmtHora(v.fecha)}</span>
          <span style="font-size:0.8rem;font-weight:600;color:${MEDIO_COLOR[v.medio_pago||'efectivo']}">${MEDIO_LABEL[v.medio_pago||'efectivo']}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="inf-venta-total">${fmtCOP(v.total)}</span>
          <a href="/api/facturas/${v.id}" target="_blank" class="btn-icon">PDF</a>
          <button class="btn-icon del" onclick="eliminarVentaInforme(${v.id})">Anular</button>
        </div>
      </div>
      <div class="inf-venta-items">${v.productos_resumen || '—'}</div>
      ${v.descuento > 0 ? `<div class="inf-venta-desc">Descuento aplicado: ${fmtCOP(v.descuento)}</div>` : ''}
    </div>`).join('');
}

async function eliminarVentaInforme(id) {
  if (!confirm(`¿Anular la Venta #${id}? El stock de los productos será devuelto.`)) return;
  const r = await api('DELETE', `/api/ventas/${id}`);
  if (r && r.mensaje) cargarInformes();
  else alert('Error al anular la venta.');
}

// ── CIERRE DEL DÍA ────────────────────────────────────
async function ejecutarCierre() {
  const r = await api('POST', '/api/ventas/cierre/ejecutar');
  if (!r) return;

  $('cierre-resultado').style.display = 'block';

  const pmp = r.porMedioPago || {};
  const mpHtml = Object.entries({ efectivo:'💵 Efectivo', nequi:'📱 Nequi', daviplata:'📲 Daviplata' })
    .filter(([k]) => pmp[k] > 0)
    .map(([k, label]) => `<div style="display:flex;justify-content:space-between;font-size:0.88rem;margin-bottom:4px">
      <span style="color:var(--muted)">${label}</span>
      <strong>${fmtCOP(pmp[k])}</strong>
    </div>`).join('');

  $('cierre-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon green">$</div><div class="stat-data"><span class="stat-val">${fmtCOP(r.total)}</span><span class="stat-label">Total ventas</span></div></div>
    <div class="stat-card"><div class="stat-icon blue">◎</div><div class="stat-data"><span class="stat-val">${r.transacciones}</span><span class="stat-label">Transacciones</span></div></div>
    <div class="stat-card"><div class="stat-icon teal">↑</div><div class="stat-data"><span class="stat-val">${fmtCOP(r.ganancia)}</span><span class="stat-label">Ganancia</span></div></div>
    <div class="stat-card"><div class="stat-icon amber">★</div><div class="stat-data"><span class="stat-val" style="font-size:1rem">${r.masVendido||'—'}</span><span class="stat-label">Más vendido</span></div></div>
  `;

  if (mpHtml) {
    $('cierre-stats').insertAdjacentHTML('afterend', `
      <div class="panel" style="margin-bottom:20px">
        <div class="panel-title">💳 Desglose por Medio de Pago</div>
        <div style="padding:16px 20px">${mpHtml}</div>
      </div>`);
  }

  const tbody = $('cierre-detalle-body');
  const detalle = Array.isArray(r.detalle) ? r.detalle : (r.detalle?.productos || []);
  if (!detalle || detalle.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">Sin datos</td></tr>';
  } else {
    tbody.innerHTML = detalle.map(d => `
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