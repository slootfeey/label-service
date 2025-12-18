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
    this.barcodeTargetWidth = 90;       
    this.barcodeTargetHeight = 35;      
    this.barcodeNumberFontSize = 8;     
    this.skuTextFontSize = 9;           
    this.kidslandFontSize = 7;          
    this.padding = 4;                   
    this.barcodePadding = 2;          
  }

  async generateBarcode(data) {
    try {
        let barcodeData = String(data || '').replace(/\s/g, '');
        
        // FIX: Ensure EAN-13 input is 12 digits so JsBarcode calculates the correct checksum.
        if (barcodeData.length === 13 && /^\d+$/.test(barcodeData)) {
            barcodeData = barcodeData.substring(0, 12);
        } else if (barcodeData.length < 12 || barcodeData.length > 13 || !/^\d+$/.test(barcodeData)) {
            console.warn(`Invalid EAN-13 data: "${data}". Using default 12-digit test barcode.`);
            barcodeData = "123456789012"; 
        }
        
        const canvas = createCanvas(1000, 300); 
      
        JsBarcode(canvas, barcodeData, {
            format: "EAN13", 
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
        // Encoding only the raw product_barcode string
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

  async createStickersPagePdf(productData, marketplace) { 
    const doc = new PDFDocument({
      size: [this.stickerWidth, this.stickerHeight], 
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Normalize marketplace name to lowercase for comparison
    const marketplaceLower = (marketplace || '').toLowerCase().trim();
    
    console.log(`Creating sticker for marketplace: "${marketplaceLower}"`);

    // Validate marketplace
    if (marketplaceLower !== 'uzum' && marketplaceLower !== 'yandex') {
      throw new Error(`Invalid marketplace: "${marketplace}". Must be "uzum" or "yandex"`);
    }

    // --- UZUM LAYOUT: QR Code only (centered) ---
    if (marketplaceLower === 'uzum') {
      const qrCodeBuffer = await this.generateQRCode(productData);
      const kidslandTextHeight = 10; 
      const totalBlockHeight = this.qrCodeTargetSize + this.padding + kidslandTextHeight;
      
      // Center horizontally and vertically
      const qrX = (this.stickerWidth / 2) - (this.qrCodeTargetSize / 2);
      const qrY = (this.stickerHeight / 2) - (totalBlockHeight / 2);
       
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
    }

    // --- YANDEX LAYOUT: Barcode only (centered) ---
    if (useBarcode) {
      const skuTextHeight = this.skuTextFontSize * 1.2; 
      const gap1 = 4; 
      const gap2 = 2; 
      const numberTextHeight = this.barcodeNumberFontSize * 1.2;
      const kidslandTextHeight = 10;

      // Total vertical space needed
      const totalBlockHeight = skuTextHeight + gap1 + this.barcodeTargetHeight + gap2 + numberTextHeight + this.padding + kidslandTextHeight;
      
      // Center the entire block vertically
      const blockY = (this.stickerHeight / 2) - (totalBlockHeight / 2);
      
      // A. SKU Text (centered)
      const skuTextY = blockY;
      
      doc.fontSize(this.skuTextFontSize)
         .text(productData.product_code || 'SKU-TEST-001', this.padding, skuTextY, { 
           width: this.stickerWidth - (this.padding * 2),
           align: 'center'
         });

      // B. Barcode Bars Image (centered)
      const barcodeY = skuTextY + skuTextHeight + gap1;
      const barcodeX = (this.stickerWidth / 2) - (this.barcodeTargetWidth / 2);

      doc.image(barcodeBuffer, barcodeX, barcodeY, { 
        width: this.barcodeTargetWidth,
        height: this.barcodeTargetHeight
      });

      // C. Barcode Numbers (centered)
      const numberTextY = barcodeY + this.barcodeTargetHeight + gap2;
      
      const displayedBarcode = productData.product_barcode && productData.product_barcode.length >= 12 && /^\d+$/.test(productData.product_barcode) 
          ? productData.product_barcode 
          : '1234567890128'; 
      
      doc.fontSize(this.barcodeNumberFontSize) 
         .text(displayedBarcode, this.padding, numberTextY, {
             width: this.stickerWidth - (this.padding * 2),
             align: 'center' 
         });

      // D. Kidsland text at bottom (centered)
      const kidslandY = numberTextY + numberTextHeight + this.padding;
      
      doc.fontSize(this.kidslandFontSize)
         .text('kidsland', this.padding, kidslandY, {
             width: this.stickerWidth - (this.padding * 2),
             align: 'center'
         });
    }
    
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
    // 1. PROCESS MARKETPLACE LABEL
    let marketplaceLabelBuffer;
    if (typeof marketplaceLabel === 'string') {
      marketplaceLabelBuffer = this.base64ToBuffer(marketplaceLabel);
    } else if (Buffer.isBuffer(marketplaceLabel)) {
      marketplaceLabelBuffer = marketplaceLabel;
    } else {
      throw new Error('Invalid marketplace label format');
    }

    const marketplacePdf = await PDFLibDocument.load(marketplaceLabelBuffer);
    const mergedPdf = await PDFLibDocument.create();

    // Copy Marketplace Label Page(s)
    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    // 2. PREPARE PRODUCT DATA
    let productsToProcess = [];
    if (orderData.products && Array.isArray(orderData.products) && orderData.products.length > 0) {
        productsToProcess = orderData.products;
    } else if (orderData.product_barcode) {
        productsToProcess = [{
            product_barcode: orderData.product_barcode,
            product_code: orderData.product_code
        }];
    }
    
    // Get marketplace from orderData
    const marketplace = orderData.marketplace || 'uzum'; // Default to uzum if not specified
    
    // 3. GENERATE PRODUCT LABELS
    for (const product of productsToProcess) {
        const productData = {
            order_id: orderData.order_id,
            product_barcode: product.product_barcode,
            product_code: product.product_code,
        }; 

        // Generate the sticker PDF with marketplace-specific layout
        const stickerPdf = await this.createStickersPagePdf(productData, marketplace);

        // 2 copies per product
        const labelsNeeded = 2;

        for (let i = 0; i < labelsNeeded; i++) {
            const [page] = await mergedPdf.copyPages(stickerPdf, [0]);
            mergedPdf.addPage(page);
        }
    }

    // 4. SAVE
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

    // Validation
    if (!orderData.order_id || (!orderData.products && !orderData.product_barcode)) {
         return res.status(400).json({ 
            error: 'orderData must include order_id and either a "products" array or a single "product_barcode" for fallback.' 
         });
    }

    // Validate marketplace field
    if (!orderData.marketplace) {
        return res.status(400).json({ 
            error: 'orderData must include "marketplace" field (uzum or yandex)' 
        });
    }

    console.log(`Generating label for order: ${orderData.order_id} (${orderData.marketplace})`);
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

    if (!orderData.order_id || (!orderData.products && !orderData.product_barcode)) {
         return res.status(400).json({ 
            error: 'orderData must include order_id and either a "products" array or a single "product_barcode" for fallback.' 
         });
    }

    // Validate marketplace field
    if (!orderData.marketplace) {
        return res.status(400).json({ 
            error: 'orderData must include "marketplace" field (uzum or yandex)' 
        });
    }

    console.log('Fetching marketplace label from:', marketplaceLabelUrl);

    const response = await axios.get(marketplaceLabelUrl, {
      headers: authHeaders || {},
      responseType: 'arraybuffer'
    });

    const marketplaceLabel = Buffer.from(response.data);
    console.log(`Marketplace label fetched, generating PDF for ${orderData.marketplace}...`);

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
