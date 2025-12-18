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
    // Sticker size 58x40 mm
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
        if (barcodeData.length === 13 && /^\d+$/.test(barcodeData)) {
            barcodeData = barcodeData.substring(0, 12);
        } else if (barcodeData.length < 12 || barcodeData.length > 13 || !/^\d+$/.test(barcodeData)) {
            console.warn(`Invalid EAN-13 data: "${data}". Using default 12-digit test barcode.`);
            barcodeData = "123456789012"; 
        }
        
        const canvas = createCanvas(1000, 300); 
        JsBarcode(canvas, barcodeData, {
            format: "EAN13", width: 2, height: 200, displayValue: false, margin: 5
        });
        return canvas.toBuffer('image/png');
    } catch (err) {
        throw new Error(`Barcode generation failed: ${err.message}`);
    }
  }
    
  async generateQRCode(data) {
    try {
        const productBarcode = data.product_barcode || '2000000099064';
        return await QRCode.toBuffer(productBarcode, {
          errorCorrectionLevel: 'M', type: 'png', width: 400, margin: 1
        });
    } catch (err) {
        throw new Error(`QR code generation failed: ${err.message}`);
    }
  }

  base64ToBuffer(base64String) {
    const base64Data = base64String.replace(/^data:application\/pdf;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  }

  // --- UPDATED METHOD: Accepts marketplace parameter ---
  async createStickersPagePdf(productData, marketplace = '') { 
    const doc = new PDFDocument({
      size: [this.stickerWidth, this.stickerHeight], 
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Normalize marketplace string
    const target = marketplace.toLowerCase().trim();

    // 1. UZUM LOGIC (QR Code ONLY)
    if (target === 'uzum') {
        const qrCodeBuffer = await this.generateQRCode(productData); 
        
        // Calculate vertical centering for QR + Text
        const kidslandTextHeight = 10;
        const totalHeight = this.qrCodeTargetSize + 2 + kidslandTextHeight;
        const startY = (this.stickerHeight - totalHeight) / 2;
        
        // Center Horizontally
        const qrX = (this.stickerWidth - this.qrCodeTargetSize) / 2;

        doc.image(qrCodeBuffer, qrX, startY, {
            width: this.qrCodeTargetSize,
            height: this.qrCodeTargetSize
        });

        doc.fontSize(this.kidslandFontSize)
           .text('kidsland', qrX, startY + this.qrCodeTargetSize + 2, {
               width: this.qrCodeTargetSize,
               align: 'center'
           });

    // 2. YANDEX LOGIC (Barcode ONLY)
    } else if (target === 'yandex') {
        const barcodeBuffer = await this.generateBarcode(productData.product_barcode);

        const skuTextHeight = this.skuTextFontSize * 1.2; 
        const numberTextHeight = this.barcodeNumberFontSize * 1.2;
        const gap1 = 4;
        const gap2 = 2;

        // Total vertical space needed
        const totalHeight = skuTextHeight + gap1 + this.barcodeTargetHeight + gap2 + numberTextHeight;
        const startY = (this.stickerHeight - totalHeight) / 2;

        // Center Horizontally
        const centerX = 0; // Use full width for alignment
        const contentWidth = this.stickerWidth;

        // A. SKU Text
        doc.fontSize(this.skuTextFontSize)
           .text(productData.product_code || 'SKU-TEST', centerX, startY, { 
             width: contentWidth, align: 'center'
           });

        // B. Barcode Image
        const barcodeImgX = (this.stickerWidth - this.barcodeTargetWidth) / 2;
        const barcodeY = startY + skuTextHeight + gap1;

        doc.image(barcodeBuffer, barcodeImgX, barcodeY, { 
          width: this.barcodeTargetWidth,
          height: this.barcodeTargetHeight
        });

        // C. Barcode Numbers
        const displayedBarcode = productData.product_barcode && productData.product_barcode.length >= 12 
            ? productData.product_barcode : '1234567890128';
        
        doc.fontSize(this.barcodeNumberFontSize) 
           .text(displayedBarcode, centerX, barcodeY + this.barcodeTargetHeight + gap2, {
               width: contentWidth, align: 'center' 
           });

    // 3. DEFAULT LOGIC (Original Dual Layout)
    } else {
        const barcodeBuffer = await this.generateBarcode(productData.product_barcode);
        const qrCodeBuffer = await this.generateQRCode(productData); 

        // -- Left Side (QR) --
        const kidslandTextHeight = 10; 
        const totalLeftBlockHeight = this.qrCodeTargetSize + this.padding + kidslandTextHeight;
        const qrX = this.padding;
        const qrY = (this.stickerHeight / 2) - (totalLeftBlockHeight / 2);
         
        doc.image(qrCodeBuffer, qrX, qrY, { width: this.qrCodeTargetSize, height: this.qrCodeTargetSize });
        doc.fontSize(this.kidslandFontSize)
           .text('kidsland', qrX, qrY + this.qrCodeTargetSize + 2, { width: this.qrCodeTargetSize, align: 'center' });

        // -- Right Side (Barcode) --
        const rightBlockX = qrX + this.qrCodeTargetSize + this.padding; 
        const rightBlockWidth = this.stickerWidth - rightBlockX - this.barcodePadding; 
        const skuTextHeight = this.skuTextFontSize * 1.2; 
        const gap1 = 4; 
        const gap2 = 2; 
        const numberTextHeight = this.barcodeNumberFontSize * 1.2;
        const rightBlockHeight = skuTextHeight + gap1 + this.barcodeTargetHeight + gap2 + numberTextHeight; 
        const rightBlockY = (this.stickerHeight / 2) - (rightBlockHeight / 2); 

        doc.fontSize(this.skuTextFontSize)
           .text(productData.product_code || 'SKU-TEST', rightBlockX, rightBlockY, { width: rightBlockWidth, align: 'center' });

        const barcodeX = rightBlockX + (rightBlockWidth / 2) - (this.barcodeTargetWidth / 2);
        const barcodeY = rightBlockY + skuTextHeight + gap1;
        doc.image(barcodeBuffer, barcodeX, barcodeY, { width: this.barcodeTargetWidth, height: this.barcodeTargetHeight });

        const displayedBarcode = productData.product_barcode && productData.product_barcode.length >= 12 
            ? productData.product_barcode : '1234567890128'; 
        doc.fontSize(this.barcodeNumberFontSize) 
           .text(displayedBarcode, barcodeX, barcodeY + this.barcodeTargetHeight + gap2, { width: this.barcodeTargetWidth, align: 'center' });
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

    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));

    // Handle single or multi product structures
    let productsToProcess = [];
    if (orderData.products && Array.isArray(orderData.products) && orderData.products.length > 0) {
        productsToProcess = orderData.products;
    } else if (orderData.product_barcode) {
        productsToProcess = [{
            product_barcode: orderData.product_barcode,
            product_code: orderData.product_code
        }];
    }
    
    // Determine Marketplace from orderData
    // We assume orderData.marketplace or orderData.source contains 'uzum' or 'yandex'
    const marketplace = orderData.marketplace || orderData.source || 'default';

    for (const product of productsToProcess) {
        const productData = {
            order_id: orderData.order_id,
            product_barcode: product.product_barcode,
            product_code: product.product_code,
        }; 

        // Pass the marketplace string here
        const stickerPdf = await this.createStickersPagePdf(productData, marketplace);

        const labelsNeeded = 2;
        for (let i = 0; i < labelsNeeded; i++) {
            const [page] = await mergedPdf.copyPages(stickerPdf, [0]);
            mergedPdf.addPage(page);
        }
    }

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
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Pass orderData (which should now contain "marketplace": "uzum" or "yandex")
    const pdfBuffer = await generator.createCompleteLabelPack(orderData, marketplaceLabel);

    res.json({
      success: true,
      pdf: pdfBuffer.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`
    });

  } catch (error) {
    console.error('Label generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-from-order', async (req, res) => {
  try {
    const { orderData, marketplaceLabelUrl, authHeaders } = req.body;

    if (!orderData || !marketplaceLabelUrl) return res.status(400).json({ error: 'Missing fields' });

    const response = await axios.get(marketplaceLabelUrl, {
      headers: authHeaders || {},
      responseType: 'arraybuffer'
    });

    const marketplaceLabel = Buffer.from(response.data);
    const pdfBuffer = await generator.createCompleteLabelPack(orderData, marketplaceLabel);

    res.json({
      success: true,
      pdf: pdfBuffer.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`
    });

  } catch (error) {
    console.error('Label generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Label generation service running on port ${PORT}`);
});

module.exports = app;
