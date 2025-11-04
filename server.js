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
    size: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 }
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const barcodeBuffer = await this.generateBarcode(orderData.product_barcode);
  const qrCodeBuffer = await this.generateQRCode(orderData.order_id);

  const margin = 20;
  const spacing = 10;
  
  // Calculate positions
  const stickerWidth = this.stickerWidth;  // 58mm = 164.4 points
  const stickerHeight = this.stickerHeight; // 40mm = 113.4 points
  
  const qrSize = 100; // Larger QR code in points
  const barcodeHeight = 60;
  const padding = 8;

  // First sticker
  let x = margin;
  let y = margin;
  
  // Draw border for first sticker (optional, for debugging)
  doc.rect(x, y, stickerWidth, stickerHeight).stroke();
  
  // QR code
  doc.image(qrCodeBuffer, x + padding, y + padding, {
    fit: [qrSize, qrSize]
  });

  // Barcode
  const barcodeX = x + qrSize + padding * 2;
  const barcodeWidth = stickerWidth - qrSize - padding * 3;
  
  doc.image(barcodeBuffer, barcodeX, y + padding + 10, {
    fit: [barcodeWidth, barcodeHeight]
  });

  // Product code text
  doc.fontSize(8)
     .text(orderData.product_code || '', barcodeX, y + padding + barcodeHeight + 15, {
       width: barcodeWidth,
       align: 'center'
     });

  // Second sticker (next to first)
  const secondX = x + stickerWidth + spacing;
  
  // Draw border for second sticker
  doc.rect(secondX, y, stickerWidth, stickerHeight).stroke();
  
  // QR code
  doc.image(qrCodeBuffer, secondX + padding, y + padding, {
    fit: [qrSize, qrSize]
  });

  // Barcode
  const secondBarcodeX = secondX + qrSize + padding * 2;
  
  doc.image(barcodeBuffer, secondBarcodeX, y + padding + 10, {
    fit: [barcodeWidth, barcodeHeight]
  });

  // Product code text
  doc.fontSize(8)
     .text(orderData.product_code || '', secondBarcodeX, y + padding + barcodeHeight + 15, {
       width: barcodeWidth,
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
    const stickersPdf = await this.createStickersPagePdf(orderData);
    const mergedPdf = await PDFLibDocument.create();

    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    const stickerPages = await mergedPdf.copyPages(stickersPdf, [0]);
    stickerPages.forEach((page) => mergedPdf.addPage(page));

    const mergedPdfBytes = await mergedPdf.save();
    return Buffer.from(mergedPdfBytes);
  }
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
