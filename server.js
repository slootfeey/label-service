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
    this.qrCodeTargetSize = 65;         
    this.barcodeTargetWidth = 90;       // Bar width (horizontal)
    this.barcodeTargetHeight = 35;      // Bar height (vertical)
    this.barcodeNumberFontSize = 8;     
    this.skuTextFontSize = 9;           
    this.kidslandFontSize = 7;          
    this.padding = 4;                   
    this.barcodePadding = 2;          
  }

  async generateBarcode(data) {
    try {
        // Validate and clean the data before feeding it to JsBarcode
        let barcodeData = String(data || '').replace(/\s/g, '');
        
        // 💥 FIX: Validation for EAN13 (must be 12 or 13 digits)
        if (barcodeData.length < 12 || barcodeData.length > 13 || !/^\d+$/.test(barcodeData)) {
            console.warn(`Invalid EAN-13 data: "${data}". Using default test barcode.`);
            barcodeData = "1234567890128"; // Default EAN-13 test value
        }
        
        const canvas = createCanvas(1000, 300); 
      
        JsBarcode(canvas, barcodeData, {
            format: "EAN13", // 💥 FIX: format is now EAN13
            width: 2,
            height: 200, 
            displayValue: false, 
            margin: 5
        });
        return canvas.toBuffer('image/png');
    } catch (err) {
        throw new Error(`Barcode generation failed: ${err.message || 'Unknown error during JsBarcode call.'}`);
    }
  }
    
  async generateQRCode(data) {
    try {
        // Encoding only the raw product_barcode string as requested
        const productBarcode = data.product_barcode || '2000000099064';
        const qrDataString = productBarcode; 

        const qrPixelWidth = 400; 
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
    
    const qrX = this.padding;
    const qrY = (this.stickerHeight / 2) - (totalLeftBlockHeight / 2);
    
    doc.image(qrCodeBuffer, qrX, qrY, {
      width: this.qrCodeTargetSize,
      height: this.qrCodeTargetSize
    });

    const kidslandY = qrY + this.qrCodeTargetSize + 2; 
    const kidslandX = qrX;
    const kidslandWidth = this.qrCodeTargetSize;

    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', kidslandX, kidslandY, {
           width: kidslandWidth,
           align: 'center'
       });

    // --- 2. SKU Text & Barcode Placement (Right Side, Horizontal) ---
    
    // 1. Define dimensions for the right column block
    const skuTextHeight = this.skuTextFontSize * 1.2; 
    const gap1 = 4; 
    const gap2 = 2; 
    const numberTextHeight = this.barcodeNumberFontSize * 1.2;

    // Total vertical space needed for the right side elements
    const rightBlockHeight = skuTextHeight + gap1 + this.barcodeTargetHeight + gap2 + numberTextHeight; 
    
    // 2. Define X positions
    // Starting X position for the right column, relative to the left QR block
    const rightBlockX = qrX + this.qrCodeTargetSize + this.padding; 
    const rightBlockWidth = this.stickerWidth - rightBlockX - this.barcodePadding; 
    
    // 3. Define Y positions
    // Top Y position of the entire right column block (centered vertically on sticker)
    const rightBlockY = (this.stickerHeight / 2) - (rightBlockHeight / 2); 

    // A. SKU Text (Top of the right column)
    const skuTextY = rightBlockY;
    
    doc.fontSize(this.skuTextFontSize)
       .text(orderData.product_code || 'SKU-TEST-001', rightBlockX, skuTextY, { 
         width: rightBlockWidth,
         align: 'center'
       });

    // B. Barcode Bars Image
    const barcodeY = skuTextY + skuTextHeight + gap1;
    
    // Calculate X to center the 90pt wide barcode within the rightBlockWidth
    const barcodeX = rightBlockX + (rightBlockWidth / 2) - (this.barcodeTargetWidth / 2);

    doc.image(barcodeBuffer, barcodeX, barcodeY, { 
      width: this.barcodeTargetWidth, // 90
      height: this.barcodeTargetHeight // 35
    });

    // C. Barcode Numbers
    const numberTextY = barcodeY + this.barcodeTargetHeight + gap2;
    
    // Re-use barcodeX and width for easy centering of the numbers below the bars
    doc.fontSize(this.barcodeNumberFontSize) 
       .text(orderData.product_barcode || '1234567890128', barcodeX, numberTextY, {
           width: this.barcodeTargetWidth, 
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
    
    // CRITICAL FIX: Generate fresh content for each sticker page
    const stickerPdf1 = await this.createStickersPagePdf(orderData);
    const stickerPdf2 = await this.createStickersPagePdf(orderData);

    const mergedPdf = await PDFLibDocument.create();

    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    // Copy first sticker page from the fresh PDF
    const firstStickerPages = await mergedPdf.copyPages(stickerPdf1, [0]);
    firstStickerPages.forEach((page) => mergedPdf.addPage(page));

    // Copy second sticker page from the second fresh PDF
    const secondStickerPages = await mergedPdf.copyPages(stickerPdf2, [0]);
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
