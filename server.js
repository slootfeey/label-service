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
    // 58x40mm in points (1mm = 2.83465 points)
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

  async createProductSticker(orderData) {
    const doc = new PDFDocument({
      size: [this.stickerWidth, this.stickerHeight],
      margins: { top: 5, bottom: 5, left: 5, right: 5 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    const barcodeBuffer = await this.generateBarcode(orderData.product_barcode);
    const qrCodeBuffer = await this.generateQRCode(orderData.order_id);

    const padding = 5;
    const contentWidth = this.stickerWidth - (padding * 2);
    
    const qrSize = 35;
    doc.image(qrCodeBuffer, padding, padding, {
      width: qrSize,
      height: qrSize
    });

    const barcodeX = padding + qrSize + 5;
    const barcodeWidth = contentWidth - qrSize - 5;
    
    doc.image(barcodeBuffer, barcodeX, padding + 5, {
      width: barcodeWidth,
      height: 25
    });

    doc.fontSize(7)
       .text(orderData.product_code || '', barcodeX, padding + 32, {
         width: barcodeWidth,
         align: 'center'
       });

    return new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
      doc.end();
    });
  }

  async createStickerPage() {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 20, bottom: 20, left: 20, right: 20 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    return new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
      doc.end();
    });
  }

  async createCompleteLabelPack(orderData, marketplaceLabel) {
    // Generate product sticker
    const stickerBuffer = await this.createProductSticker(orderData);

    // Handle marketplace label (decode if base64)
    let marketplaceLabelBuffer;
    if (typeof marketplaceLabel === 'string') {
      marketplaceLabelBuffer = this.base64ToBuffer(marketplaceLabel);
    } else if (Buffer.isBuffer(marketplaceLabel)) {
      marketplaceLabelBuffer = marketplaceLabel;
    } else {
      throw new Error('Invalid marketplace label format');
    }

    // Load marketplace PDF
    const marketplacePdf = await PDFLibDocument.load(marketplaceLabelBuffer);

    // Create a new PDF for stickers page with two stickers
    const stickersPagePdf = await PDFLibDocument.create();
    const page = stickersPagePdf.addPage([595, 842]); // A4 size in points

    // Load sticker as image and embed it twice
    const stickerImage = await stickersPagePdf.embedPng(stickerBuffer);
    
    const margin = 20;
    const spacing = 10;
    
    // First sticker
    page.drawImage(stickerImage, {
      x: margin,
      y: 842 - margin - this.stickerHeight, // A4 height - margin - sticker height
      width: this.stickerWidth,
      height: this.stickerHeight,
    });

    // Second sticker
    page.drawImage(stickerImage, {
      x: margin + this.stickerWidth + spacing,
      y: 842 - margin - this.stickerHeight,
      width: this.stickerWidth,
      height: this.stickerHeight,
    });

    // Create final merged PDF
    const mergedPdf = await PDFLibDocument.create();

    // Copy all pages from marketplace PDF
    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    // Copy stickers page
    const stickerPages = await mergedPdf.copyPages(stickersPagePdf, [0]);
    stickerPages.forEach((page) => mergedPdf.addPage(page));

    // Save and return
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
