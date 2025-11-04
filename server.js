const express = require('express');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const QRCode = require('qrcode');
const { createCanvas } = require('canvas');
const JsBarcode = require('jsbarcode');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

class LabelGenerator {
  constructor() {
    this.stickerWidth = 58 * 2.83465;
    this.stickerHeight = 40 * 2.83465;
  }

  async generateBarcode(data) {
    try {
      const canvas = createCanvas(250, 100);
      JsBarcode(canvas, data, {
        format: "CODE128",
        width: 2,
        height: 60,
        displayValue: true,
        fontSize: 14,
        margin: 5
      });
      return canvas.toBuffer('image/png');
    } catch (err) {
      throw new Error(`Barcode generation failed: ${err.message}`);
    }
  }

  async generateQRCode(data) {
    try {
      const qrBuffer = await QRCode.toBuffer(data, {
        errorCorrectionLevel: 'M',
        type: 'png',
        width: 150,
        margin: 1
      });
      return qrBuffer;
    } catch (err) {
      throw new Error(`QR code generation failed: ${err.message}`);
    }
  }

  base64ToBuffer(base64String) {
    const base64Data = base64String.replace(/^data:application\/pdf;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  }

  async createStickersPagePdf(orderData) {
  const doc = new PDFDocument({
    size: [this.stickerWidth, this.stickerHeight],
    margins: { top: 0, bottom: 0, left: 0, right: 0 }
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const barcodeBuffer = await this.generateBarcode(orderData.product_barcode);
  const qrCodeBuffer = await this.generateQRCode(orderData.order_id);

  const padding = 5;
  
  // Smaller QR code (30mm instead of 35mm)
  const qrSize = 30 * 2.83465; // 30mm = ~85 points
  
  // QR code on the left
  doc.image(qrCodeBuffer, padding, padding, {
    width: qrSize,
    height: qrSize
  });

  // Rotate and place barcode vertically on the right
  doc.save();
  
  // Position for rotated barcode
  const barcodeX = this.stickerWidth - padding - 60; // 60 is rotated barcode width
  const barcodeY = padding;
  
  // Move to position and rotate 90 degrees
  doc.translate(barcodeX + 30, barcodeY) // Move to center of barcode area
     .rotate(90, { origin: [0, 0] });
  
  // Draw barcode (now vertical)
  doc.image(barcodeBuffer, -30, 0, {
    width: 60,
    height: this.stickerHeight - padding * 2 - 20
  });
  
  doc.restore();

  // Product code text at bottom
  doc.fontSize(7)
     .text(orderData.product_code || '', padding, this.stickerHeight - 15, {
       width: this.stickerWidth - padding * 2,
       align: 'center'
     });

  return new Promise((resolve, reject) => {
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(buffers);
      const pdfDoc = await PDFLibDocument.load(pdfBuffer);
      resolve(pdfDoc);
    });
    doc.on('error', reject);
    doc.end();
  });
}

  async createCompleteLabelPack(orderData, marketplaceLabel) {
  let marketplaceLabelBuffer;
  if (typeof marketplaceLabel === 'string') {
    marketplaceLabelBuffer = this.base64ToBuffer(marketplaceLabel);
  } else if (Buffer.isBuffer(marketplaceLabel)) {
    marketplaceLabelBuffer = marketplaceLabel;
  } else {
    throw new Error('Invalid marketplace label format');
  }

  const marketplacePdf = await PDFLibDocument.load(marketplaceLabelBuffer);
  const stickerPdf = await this.createStickersPagePdf(orderData);
  const mergedPdf = await PDFLibDocument.create();

  // Page 1: Marketplace label
  const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
  marketplacePages.forEach((page) => mergedPdf.addPage(page));

  // Page 2: First sticker
  const firstStickerPages = await mergedPdf.copyPages(stickerPdf, [0]);
  firstStickerPages.forEach((page) => mergedPdf.addPage(page));

  // Page 3: Second sticker (duplicate)
  const secondStickerPages = await mergedPdf.copyPages(stickerPdf, [0]);
  secondStickerPages.forEach((page) => mergedPdf.addPage(page));

  const mergedPdfBytes = await mergedPdf.save();
  return Buffer.from(mergedPdfBytes);
}

const generator = new LabelGenerator();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'label-generator' });
});

app.post('/generate-label', async (req, res) => {
  try {
    const { orderData, marketplaceLabel } = req.body;

    if (!orderData || !marketplaceLabel) {
      return res.status(400).json({ 
        error: 'Missing required fields: orderData and marketplaceLabel' 
      });
    }

    if (!orderData.order_id || !orderData.product_barcode) {
      return res.status(400).json({ 
        error: 'orderData must include order_id and product_barcode' 
      });
    }

    console.log('Generating label for order:', orderData.order_id);
    const pdfBuffer = await generator.createCompleteLabelPack(orderData, marketplaceLabel);
    console.log('Label generated successfully, size:', pdfBuffer.length);

    res.json({
      success: true,
      pdf: pdfBuffer.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`
    });

  } catch (error) {
    console.error('Label generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate label',
      message: error.message 
    });
  }
});

app.post('/generate-from-order', async (req, res) => {
  try {
    const { orderData, marketplaceLabelUrl, authHeaders } = req.body;

    if (!orderData || !marketplaceLabelUrl) {
      return res.status(400).json({ 
        error: 'Missing required fields: orderData and marketplaceLabelUrl' 
      });
    }

    console.log('Fetching marketplace label from:', marketplaceLabelUrl);

    const response = await axios.get(marketplaceLabelUrl, {
      headers: authHeaders || {},
      responseType: 'arraybuffer'
    });

    const marketplaceLabel = Buffer.from(response.data);
    console.log('Marketplace label fetched, generating PDF...');

    const pdfBuffer = await generator.createCompleteLabelPack(orderData, marketplaceLabel);
    console.log('Label generated successfully');

    res.json({
      success: true,
      pdf: pdfBuffer.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`
    });

  } catch (error) {
    console.error('Label generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate label',
      message: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Label generation service running on port ${PORT}`);
});

module.exports = app;
