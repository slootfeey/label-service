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
    this.stickerWidth = 58 * 2.83465; // ~164.5 points
    this.stickerHeight = 40 * 2.83465; // ~113.38 points
    
    // Define target dimensions for the codes in points for consistent placement
    this.qrCodeTargetSize = 25; // Smaller QR size in points (~14.1 mm)
    this.barcodeTargetWidth = 80; // Barcode width in points
    this.barcodeTargetHeight = 25; // Barcode height in points (reduced for better fit)
    this.textFontSize = 10; // Font size for the SKU/Product code
    this.verticalSpacing = 5; // Spacing between elements
  }

  async generateBarcode(data) {
    try {
      // Adjust canvas size to accommodate the barcode image generation
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
      // Make generated image smaller for better scaling control
      const qrPixelWidth = 100; 
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
      // Set size to 58x40 points
      size: [this.stickerWidth, this.stickerHeight], 
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    const barcodeBuffer = await this.generateBarcode(orderData.product_barcode);
    const qrCodeBuffer = await this.generateQRCode(orderData.order_id);

    // --- Positioning Logic for Right Half Center ---
    const rightHalfStart = this.stickerWidth / 2; // Midpoint X

    // Calculate vertical center point of the right half
    const centerLineY = this.stickerHeight / 2;

    // Calculate the total vertical space needed for QR + Barcode + Spacing
    const totalCodesHeight = this.qrCodeTargetSize + this.barcodeTargetHeight + this.verticalSpacing;

    // Calculate the starting Y for the QR code to center the whole stack
    const qrY = centerLineY - (totalCodesHeight / 2);

    // Calculate the X for QR code to center it in the right half
    // Right half center X = rightHalfStart + (rightHalfWidth / 2)
    const qrX = rightHalfStart + (this.stickerWidth / 4) - (this.qrCodeTargetSize / 2);

    // 2. Draw QR Code
    doc.image(qrCodeBuffer, qrX, qrY, {
      width: this.qrCodeTargetSize,
      height: this.qrCodeTargetSize
    });

    // Calculate Barcode Y (below QR)
    const barcodeY = qrY + this.qrCodeTargetSize + this.verticalSpacing;
    
    // Calculate Barcode X to center it in the right half
    const barcodeX = rightHalfStart + (this.stickerWidth / 4) - (this.barcodeTargetWidth / 2);
    
    // 2. Draw Barcode
    // NOTE: Removed rotation/translate from original code for standard horizontal placement
    doc.image(barcodeBuffer, barcodeX, barcodeY, {
      width: this.barcodeTargetWidth,
      height: this.barcodeTargetHeight
    });
    
    // --- Text Placement (Centered in the Left Half) ---
    const textWidth = this.stickerWidth / 2; // Constrain to left half
    const textHeight = 15;
    const textY = (this.stickerHeight / 2) - (textHeight / 2); // Center vertically

    doc.fontSize(this.textFontSize)
       .text(orderData.product_code || 'SKU-TEST-001', 0, textY, {
         width: textWidth,
         align: 'center'
       });

    return new Promise((resolve, reject) => {
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(buffers);
        // The original code loads the PDF buffer into pdf-lib here
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

// --- Express Routes ---

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
