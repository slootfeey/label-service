const express = require('express');
const PDFDocument = require('pdfkit');
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
    this.stickerWidth = 58 * 2.83465; // ~164 points
    this.stickerHeight = 40 * 2.83465; // ~113 points
  }

  async generateBarcode(data) {
    try {
      // Create canvas for barcode
      const canvas = createCanvas(250, 100);
      
      // Generate Code128 barcode
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
      // Generate QR code as buffer
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
    
    // QR Code on the left
    const qrSize = 35;
    doc.image(qrCodeBuffer, padding, padding, {
      width: qrSize,
      height: qrSize
    });

    // Barcode on the right
    const barcodeX = padding + qrSize + 5;
    const barcodeWidth = contentWidth - qrSize - 5;
    
    doc.image(barcodeBuffer, barcodeX, padding + 5, {
      width: barcodeWidth,
      height: 25
    });

    // Product code below barcode
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

  async createCompleteLabelPack(orderData, marketplaceLabel) {
    const doc = new PDFDocument({
      autoFirstPage: false
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Handle marketplace label
    let labelBuffer;
    if (typeof marketplaceLabel === 'string') {
      labelBuffer = this.base64ToBuffer(marketplaceLabel);
    } else if (Buffer.isBuffer(marketplaceLabel)) {
      labelBuffer = marketplaceLabel;
    } else {
      throw new Error('Invalid marketplace label format');
    }

    // Page 1: Marketplace label
// Check if it's a PDF or image
const isPDF = labelBuffer[0] === 0x25 && labelBuffer[1] === 0x50 && labelBuffer[2] === 0x44 && labelBuffer[3] === 0x46; // %PDF

if (isPDF) {
  // For PDF labels, we'll add them as external content (note: this is a simplified approach)
  doc.addPage({ size: 'A4' });
  doc.fontSize(12).text('Marketplace Order Label', 50, 50);
  doc.fontSize(10).text('(PDF label - print separately or merge manually)', 50, 70);
  doc.fontSize(10).text(`Order ID: ${orderData.order_id}`, 50, 100);
} else {
  // For image labels
  doc.addPage({ size: 'A4' });
  doc.image(labelBuffer, 0, 0, {
    fit: [doc.page.width, doc.page.height],
    align: 'center',
    valign: 'center'
  });
}

    // Generate product sticker
    const stickerBuffer = await this.createProductSticker(orderData);

    // Page 2: Two product stickers
    doc.addPage({ size: 'A4' });
    
    const margin = 20;
    const spacing = 10;
    
    // First sticker
    doc.image(stickerBuffer, margin, margin, {
      width: this.stickerWidth,
      height: this.stickerHeight
    });

    // Second sticker
    doc.image(stickerBuffer, margin + this.stickerWidth + spacing, margin, {
      width: this.stickerWidth,
      height: this.stickerHeight
    });

    return new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
      doc.end();
    });
  }
}

const generator = new LabelGenerator();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'label-generator' });
});

// Main endpoint for label generation
app.post('/generate-label', async (req, res) => {
  try {
    const { orderData, marketplaceLabel } = req.body;

    // Validate required fields
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

    // Generate the complete PDF
    const pdfBuffer = await generator.createCompleteLabelPack(orderData, marketplaceLabel);

    console.log('Label generated successfully, size:', pdfBuffer.length);

    // Return as base64 for easy handling in n8n
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

// Endpoint to fetch marketplace label and generate
app.post('/generate-from-order', async (req, res) => {
  try {
    const { orderData, marketplaceLabelUrl, authHeaders } = req.body;

    if (!orderData || !marketplaceLabelUrl) {
      return res.status(400).json({ 
        error: 'Missing required fields: orderData and marketplaceLabelUrl' 
      });
    }

    console.log('Fetching marketplace label from:', marketplaceLabelUrl);

    // Fetch marketplace label
    const response = await axios.get(marketplaceLabelUrl, {
      headers: authHeaders || {},
      responseType: 'arraybuffer'
    });

    const marketplaceLabel = Buffer.from(response.data);

    console.log('Marketplace label fetched, generating PDF...');

    // Generate the complete PDF
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
