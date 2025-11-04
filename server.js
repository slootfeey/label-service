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
    // 1. Set sticker size to 58x40 mm (using ~2.83465 points per mm for PDFKit)
    this.stickerWidth = 58 * 2.83465; // ~164.41 points
    this.stickerHeight = 40 * 2.83465; // ~113.38 points
    
    // Define target dimensions for the codes in points
    this.qrCodeTargetSize = 50; 
    this.barcodeTargetWidth = 80; 
    this.barcodeTargetHeight = 35; 
    this.textFontSize = 10;
    this.padding = 5; 
  }

  async generateBarcode(data) {
    try {
      const canvas = createCanvas(300, 100); 
      JsBarcode(canvas, data, {
        format: "EAN13",
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
      const qrPixelWidth = 120; 
      const qrBuffer = await QRCode.toBuffer(data, {
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
    const qrCodeBuffer = await this.generateQRCode(orderData.order_id);

    // --- 1. QR Code Placement (Left side, vertically centered) ---
    const qrX = this.padding;
    // Center QR/Text block vertically. The text is placed below the QR now.
    // Recalculate QR Y to account for the text "kidsland" below it
    const kidslandTextHeight = 8; // Estimated height for the small text
    const totalLeftBlockHeight = this.qrCodeTargetSize + this.padding + kidslandTextHeight;

    const qrY = (this.stickerHeight / 2) - (totalLeftBlockHeight / 2);
    
    doc.image(qrCodeBuffer, qrX, qrY, {
      width: this.qrCodeTargetSize,
      height: this.qrCodeTargetSize
    });

    // --- 4. "kidsland" Text Placement (Bottom left, centered under QR) ---
    // Y: Below the QR code with some padding
    const kidslandY = qrY + this.qrCodeTargetSize + 2; 
    // X: Centered under the QR code
    const kidslandX = qrX;
    const kidslandWidth = this.qrCodeTargetSize;

    doc.fontSize(6)
       .text('kidsland', kidslandX, kidslandY, {
           width: kidslandWidth,
           align: 'center'
       });


    // --- 2. Barcode Placement (Right side, rotated 90 degrees, vertically centered) ---
    const finalBarcodeWidth = this.barcodeTargetHeight; // 35pt
    const barcodeFinalX = this.stickerWidth - finalBarcodeWidth - this.padding; 
    const finalBarcodeHeight = this.barcodeTargetWidth; // 80pt
    const barcodeFinalY = (this.stickerHeight / 2) - (finalBarcodeHeight / 2);

    doc.save();
    doc.translate(barcodeFinalX, barcodeFinalY)
       .rotate(90, { origin: [0, 0] });
    
    // Image drawing adjusted for rotation
    doc.image(barcodeBuffer, 0, -finalBarcodeWidth, {
      width: this.barcodeTargetWidth, 
      height: this.barcodeTargetHeight 
    });
    
    doc.restore(); 

    // --- 3. Product Code/Data Text Placement (Center area, centered vertically) ---
    const textX = qrX + this.qrCodeTargetSize + this.padding; 
    const textWidth = barcodeFinalX - textX - this.padding; 
    const textLineHeight = this.textFontSize * 1.2; 
    const textTotalHeight = textLineHeight * 2; 
    const textY = (this.stickerHeight / 2) - (textTotalHeight / 2); 

    doc.fontSize(this.textFontSize)
       .text(orderData.product_code || 'Product data\ntwo lines', textX, textY, { 
         width: textWidth,
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

    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    // Add the two generated sticker pages
    const firstStickerPages = await mergedPdf.copyPages(stickerPdf, [0]);
    firstStickerPages.forEach((page) => mergedPdf.addPage(page));

    const secondStickerPages = await mergedPdf.copyPages(stickerPdf, [0]);
    secondStickerPages.forEach((page) => mergedPdf.addPage(page));

    const mergedPdfBytes = await mergedPdf.save();
    return Buffer.from(mergedPdfBytes);
  }
}

const generator = new LabelGenerator();

// --- Express Routes (Unchanged) ---

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
