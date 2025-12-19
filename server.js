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
        console.warn(`Invalid EAN-13 data: "${data}". Using default.`);
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
      throw new Error(`Barcode generation failed: ${err.message}`);
    }
  }
  
  async generateQRCode(data) {
    try {
      const productBarcode = data.product_barcode || '2000000099064';
      const qrBuffer = await QRCode.toBuffer(productBarcode, {
        errorCorrectionLevel: 'M',
        type: 'png',
        width: 400,
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

  async createUzumSticker(productData) {
    console.log('Creating UZUM sticker (QR CODE ONLY)');
    
    const doc = new PDFDocument({
      size: [this.stickerWidth, this.stickerHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Generate ONLY QR Code
    const qrCodeBuffer = await this.generateQRCode(productData);
    
    const skuTextHeight = this.skuTextFontSize * 1.2;
    const gap1 = 4;
    const barcodeNumberHeight = this.barcodeNumberFontSize * 1.2;
    const gap2 = 2;
    const kidslandTextHeight = 10;
    
    // Total height needed
    const totalBlockHeight = skuTextHeight + gap1 + this.qrCodeTargetSize + 
                           gap2 + barcodeNumberHeight + this.padding + kidslandTextHeight;
    
    // Center the entire block vertically
    const blockY = (this.stickerHeight / 2) - (totalBlockHeight / 2);
    
    // 1. Product Code at top (centered)
    const skuTextY = blockY;
    doc.fontSize(this.skuTextFontSize)
       .text(productData.product_code || 'SKU-TEST-001', this.padding, skuTextY, {
         width: this.stickerWidth - (this.padding * 2),
         align: 'center'
       });
    
    // 2. QR Code in middle (centered)
    const qrY = skuTextY + skuTextHeight + gap1;
    const qrX = (this.stickerWidth / 2) - (this.qrCodeTargetSize / 2);
    
    doc.image(qrCodeBuffer, qrX, qrY, {
      width: this.qrCodeTargetSize,
      height: this.qrCodeTargetSize
    });

    // 3. Barcode number below QR (centered)
    const barcodeNumberY = qrY + this.qrCodeTargetSize + gap2;
    const displayedBarcode = productData.product_barcode || '2000000099064';
    
    doc.fontSize(this.barcodeNumberFontSize)
       .text(displayedBarcode, this.padding, barcodeNumberY, {
         width: this.stickerWidth - (this.padding * 2),
         align: 'center'
       });

    // 4. Kidsland text at bottom (centered)
    const kidslandY = barcodeNumberY + barcodeNumberHeight + this.padding;
    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', this.padding, kidslandY, {
         width: this.stickerWidth - (this.padding * 2),
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

  async createYandexSticker(productData) {
    console.log('Creating YANDEX sticker (BARCODE ONLY)');
    
    const doc = new PDFDocument({
      size: [this.stickerWidth, this.stickerHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Generate ONLY Barcode
    const barcodeBuffer = await this.generateBarcode(productData.product_barcode);
    
    const skuTextHeight = this.skuTextFontSize * 1.2;
    const gap1 = 4;
    const gap2 = 2;
    const numberTextHeight = this.barcodeNumberFontSize * 1.2;
    const kidslandTextHeight = 10;
    
    const totalBlockHeight = skuTextHeight + gap1 + this.barcodeTargetHeight + 
                           gap2 + numberTextHeight + this.padding + kidslandTextHeight;
    
    const blockY = (this.stickerHeight / 2) - (totalBlockHeight / 2);
    
    // SKU Text
    const skuTextY = blockY;
    doc.fontSize(this.skuTextFontSize)
       .text(productData.product_code || 'SKU-TEST-001', this.padding, skuTextY, {
         width: this.stickerWidth - (this.padding * 2),
         align: 'center'
       });

    // Barcode Image
    const barcodeY = skuTextY + skuTextHeight + gap1;
    const barcodeX = (this.stickerWidth / 2) - (this.barcodeTargetWidth / 2);
    doc.image(barcodeBuffer, barcodeX, barcodeY, {
      width: this.barcodeTargetWidth,
      height: this.barcodeTargetHeight
    });

    // Barcode Numbers
    const numberTextY = barcodeY + this.barcodeTargetHeight + gap2;
    const displayedBarcode = productData.product_barcode && 
                            productData.product_barcode.length >= 12 && 
                            /^\d+$/.test(productData.product_barcode)
      ? productData.product_barcode
      : '1234567890128';
    
    doc.fontSize(this.barcodeNumberFontSize)
       .text(displayedBarcode, this.padding, numberTextY, {
         width: this.stickerWidth - (this.padding * 2),
         align: 'center'
       });

    // Kidsland text
    const kidslandY = numberTextY + numberTextHeight + this.padding;
    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', this.padding, kidslandY, {
         width: this.stickerWidth - (this.padding * 2),
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
    console.log('\n=== STARTING LABEL GENERATION ===');
    console.log('Order ID:', orderData.order_id);
    console.log('Marketplace:', orderData.marketplace);
    
    // 1. Process marketplace label
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

    // Add marketplace label (page 1)
    const marketplacePages = await mergedPdf.copyPages(marketplacePdf, marketplacePdf.getPageIndices());
    marketplacePages.forEach((page) => mergedPdf.addPage(page));
    console.log(`Added ${marketplacePages.length} marketplace label page(s)`);

    // 2. Prepare products
    let productsToProcess = [];
    if (orderData.products && Array.isArray(orderData.products) && orderData.products.length > 0) {
      productsToProcess = orderData.products;
    } else if (orderData.product_barcode) {
      productsToProcess = [{
        product_barcode: orderData.product_barcode,
        product_code: orderData.product_code
      }];
    }

    const marketplace = (orderData.marketplace || '').toLowerCase().trim();
    
    if (marketplace !== 'uzum' && marketplace !== 'yandex') {
      throw new Error(`Invalid marketplace: "${orderData.marketplace}". Must be "uzum" or "yandex"`);
    }

    console.log(`Processing ${productsToProcess.length} product(s) for ${marketplace}`);

    // 3. Generate product stickers
    for (let idx = 0; idx < productsToProcess.length; idx++) {
      const product = productsToProcess[idx];
      const productData = {
        order_id: orderData.order_id,
        product_barcode: product.product_barcode,
        product_code: product.product_code,
      };

      console.log(`\nProduct ${idx + 1}/${productsToProcess.length}:`);
      console.log('  Barcode:', productData.product_barcode);
      console.log('  Code:', productData.product_code);

      // Generate sticker based on marketplace
      let stickerPdf;
      if (marketplace === 'uzum') {
        stickerPdf = await this.createUzumSticker(productData);
      } else if (marketplace === 'yandex') {
        stickerPdf = await this.createYandexSticker(productData);
      }

      // Add 2 copies
      for (let i = 0; i < 2; i++) {
        const [page] = await mergedPdf.copyPages(stickerPdf, [0]);
        mergedPdf.addPage(page);
        console.log(`  Added ${marketplace} sticker copy ${i + 1}/2`);
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    console.log('\n=== LABEL GENERATION COMPLETE ===\n');
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

    if (!orderData.order_id || (!orderData.products && !orderData.product_barcode)) {
      return res.status(400).json({
        error: 'orderData must include order_id and either products array or product_barcode'
      });
    }

    if (!orderData.marketplace) {
      return res.status(400).json({
        error: 'orderData must include marketplace field (uzum or yandex)'
      });
    }

    const pdfBuffer = await generator.createCompleteLabelPack(orderData, marketplaceLabel);

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
        error: 'orderData must include order_id and either products array or product_barcode'
      });
    }

    if (!orderData.marketplace) {
      return res.status(400).json({
        error: 'orderData must include marketplace field (uzum or yandex)'
      });
    }

    console.log('Fetching marketplace label from:', marketplaceLabelUrl);

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
