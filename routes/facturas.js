const express = require('express');
const router = express.Router();
const db = require('../db/init');
const PDFDocument = require('pdfkit');

router.get('/:id', async (req, res) => {
  try {
    const venta = await db.get('SELECT * FROM ventas WHERE id = ?', [req.params.id]);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    const items = await db.all('SELECT * FROM venta_items WHERE venta_id = ?', [req.params.id]);

    const aj = await db.all('SELECT * FROM ajustes');
    const cfg = {};
    aj.forEach(r => cfg[r.clave] = r.valor);
    const nombre_negocio = cfg.nombre_negocio || 'Mi Tienda';
    const direccion      = cfg.direccion      || '';
    const telefono       = cfg.telefono       || '';

    const fmt = n => Math.round(n || 0).toLocaleString('es-CO');
    const doc = new PDFDocument({ margin: 40, size: [226, 600] });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=recibo-${venta.id}.pdf`);
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(14).text(nombre_negocio, { align: 'center' });
    doc.font('Helvetica').fontSize(8).text(direccion, { align: 'center' });
    doc.text(`Tel: ${telefono}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.text('--------------------------------', { align: 'center' });
    doc.moveDown(0.3);

    const fecha = new Date(venta.fecha);
    doc.text(`Fecha: ${fecha.toLocaleDateString('es-CO')}  Hora: ${fecha.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`, { align: 'center' });
    doc.text(`Recibo #${venta.id}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.text('--------------------------------', { align: 'center' });
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(8);
    for (const item of items) {
      const y = doc.y;
      doc.text(`${item.nombre_producto.substring(0, 18)}`, 40, y);
      doc.font('Helvetica').fontSize(8);
      doc.text(`  ${item.cantidad} x $${fmt(item.precio_unitario)} = $${fmt(item.subtotal)}`);
      doc.moveDown(0.3);
    }

    doc.moveDown(0.3);
    doc.text('--------------------------------', { align: 'center' });
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(9);
    doc.text(`Subtotal: $${fmt(venta.subtotal)}`);
    if (venta.descuento > 0) doc.text(`Descuento: -$${fmt(venta.descuento)}`);

    doc.font('Helvetica-Bold').fontSize(12);
    doc.text(`TOTAL: $${fmt(venta.total)}`);

    if (venta.efectivo) {
      doc.font('Helvetica').fontSize(9);
      doc.moveDown(0.4);
      doc.text(`Efectivo: $${fmt(venta.efectivo)}`);
      doc.text(`Vuelto:   $${fmt(venta.vuelto)}`);
    }

    doc.moveDown(0.5);
    doc.fontSize(8).text('Gracias por su compra!', { align: 'center' });
    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
