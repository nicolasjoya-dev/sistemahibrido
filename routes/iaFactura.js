const express = require('express');
const router  = express.Router();
const multer  = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/leer', upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: req.file.mimetype || 'image/jpeg',
                  data:      req.file.buffer.toString('base64')
                }
              },
              {
                text: `Factura de papelería colombiana. Extrae SOLO la tabla de productos.
Responde ÚNICAMENTE con JSON array sin texto extra ni markdown:
[{"codigo":"","nombre":"","cantidad":0,"precio_unitario":0}]
Si hay valores escritos a mano encima del impreso, úsalos.
Si no hay precio usa 0. Extrae todos los productos.`
              }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 1500 }
        })
      }
    );

    if (!resp.ok) {
      const e = await resp.json();
      throw new Error(e.error?.message || 'Error Gemini');
    }

    const data  = await resp.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const limpio = texto.replace(/```json|```/g, '').trim();
    const items  = JSON.parse(limpio);

    const productos = items.map(p => ({
      codigo_barras: p.codigo || '',
      nombre:        p.nombre || '',
      categoria:     'Papelería',
      precio_compra: p.precio_unitario || 0,
      precio_venta:  (p.precio_unitario || 0) + 10,
      stock:         p.cantidad || 0,
      stock_minimo:  Math.floor((p.cantidad || 0) / 3),
      unidad:        'unidades'
    }));

    res.json({ ok: true, productos });

  } catch (err) {
    console.error('IA error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;