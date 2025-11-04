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
    // Sticker size 58x40 mm (using ~2.83465 points per mm for PDFKit)
    this.stickerWidth = 58 * 2.83465; // ~164.41 points
    this.stickerHeight = 40 * 2.83465; // ~113.38 points
    
    // Defined sizes
    this.qrCodeTargetSize = 65;         // Larger QR code (~23 mm)
    this.barcodeTargetWidth = 90;       // Wider barcode (becomes height after rotation)
    this.barcodeTargetHeight = 40;      // Taller barcode (becomes width after rotation)
    this.skuTextFontSize = 18;          // Large font for SKU in the center
    this.kidslandFontSize = 7;          // Small font for "kidsland"
    this.padding = 4;                   // General padding
  }

  async generateBarcode(data) {
    try {
      const canvas = createCanvas(350, 150); 
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
        // Prepare the data to include both order ID and product barcode
        const qrDataString = JSON.stringify({
            order: data.order_id,
            sku: data.product_barcode
        });

        // Generate a high-resolution QR image for good scaling
        const qrPixelWidth = 200; 
        const qrBuffer = await QRCode.toBuffer(qrDataString, {
          errorCorrectionLevel: 'M',
          type: 'png',
          width: qrPixelWidth,
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
    const qrCodeBuffer = await this.generateQRCode(orderData); 

    // --- 1. QR Code & "kidsland" Block Placement (Left Side) ---
    const kidslandTextHeight = 10; 
    const totalLeftBlockHeight = this.qrCodeTargetSize + this.padding + kidslandTextHeight;
    
    // QR Y: Vertically center the entire QR + text block
    const qrX = this.padding;
    const qrY = (this.stickerHeight / 2) - (totalLeftBlockHeight / 2);
    
    // Draw QR Code
    doc.image(qrCodeBuffer, qrX, qrY, {
      width: this.qrCodeTargetSize,
      height: this.qrCodeTargetSize
    });

    // Draw "kidsland" Text
    const kidslandY = qrY + this.qrCodeTargetSize + 2; 
    const kidslandX = qrX;
    const kidslandWidth = this.qrCodeTargetSize;

    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', kidslandX, kidslandY, {
           width: kidslandWidth,
           align: 'center'
       });

    // --- 2. Vertical Barcode Placement (Right Side, Rotated 180°) ---
    const finalBarcodeWidth = this.barcodeTargetHeight; 
    const barcodeFinalX = this.stickerWidth - finalBarcodeWidth - this.padding; 
    
    const finalBarcodeHeight = this.barcodeTargetWidth; 
    const barcodeFinalY = (this.stickerHeight / 2) - (finalBarcodeHeight / 2); 

    doc.save();
    doc.translate(barcodeFinalX + finalBarcodeWidth, barcodeFinalY + finalBarcodeHeight)
       .rotate(180, { origin: [0, 0] });
    
    // Draw image 
    doc.image(barcodeBuffer, 0, 0, { 
      width: this.barcodeTargetWidth, 
      height: this.barcodeTargetHeight 
    });
    
    doc.restore(); 

    // --- 3. SKU Text Placement (Center area, Large and Rotated 90°) ---
    const textX = qrX + this.qrCodeTargetSize + this.padding * 2; 
    const textWidth = barcodeFinalX - textX - this.padding; 
    const textLineHeight = this.skuTextFontSize * 1.2; 
    const textTotalHeight = textLineHeight; 
    const textY = (this.stickerHeight / 2) - (textTotalHeight / 2); 

    doc.save();
    
    const textCenterX = textX + (textWidth / 2);
    const textCenterY = this.stickerHeight / 2;
    
    doc.translate(textCenterX, textCenterY)
       .rotate(90, { origin: [0, 0] });

    doc.fontSize(this.skuTextFontSize)
       .text(orderData.product_code || 'SKU-TEST-001', -textWidth/2, -textLineHeight/2, { 
         width: textWidth,
         align: 'center'
       });
    
    doc.restore();
      
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

  // 💥 REINSTATED FUNCTION 💥
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

    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    const firstStickerPages = await mergedPdf.copyPages(stickerPdf, [0]);
    firstStickerPages.forEach((page) => mergedPdf.addPage(page));

    const secondStickerPages = await mergedPdf.copyPages(stickerPdf, [0]);
    secondStickerPages.forEach((page) => mergedPdf.addPage(page));

    const mergedPdfBytes = await mergedPdf.save();
    return Buffer.from(mergedPdfBytes);
  }
}

// ------------------------------------------------------------------
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
