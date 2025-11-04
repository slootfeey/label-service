// ---------------------------------------------------------------
//  label-generator.js  (full file – copy-paste into your project)
// ---------------------------------------------------------------
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

// ----------------------------------------------------------------
//  LabelGenerator – builds sticker in **portrait** then rotates 90°
// ----------------------------------------------------------------
class LabelGenerator {
  constructor() {
    // ---- physical sticker size (mm → points) ----
    const mm2pt = 2.83465;
    this.physicalWidthMm = 58;   // final sticker width after rotation
    this.physicalHeightMm = 40;  // final sticker height after rotation

    // PDF page will be built **portrait** (height > width)
    this.pageWidth = this.physicalHeightMm * mm2pt;   // 40 mm → ~113.4 pt
    this.pageHeight = this.physicalWidthMm * mm2pt;   // 58 mm → ~164.4 pt

    // ---- element sizes (points) ----
    this.qrSize = 40;
    this.barcodeWidth = 70;   // fits nicely on the 40 mm side
    this.barcodeHeight = 30;  // includes barcode + text
    this.skuFontSize = 8;
    this.kidslandFontSize = 7;
    this.padding = 4;
  }

  // -----------------------------------------------------------
  //  Barcode (horizontal, numbers **below** bars)
  // -----------------------------------------------------------
  async generateBarcode(data) {
    const canvas = createCanvas(300, 100);
    JsBarcode(canvas, data, {
      format: 'CODE128',
      width: 2,
      height: 45,               // bars only
      displayValue: true,
      fontSize: 13,
      textAlign: 'center',
      textPosition: 'bottom',
      textMargin: 4,
      margin: 10,
      flat: false,
    });
    return canvas.toBuffer('image/png');
  }

  // -----------------------------------------------------------
  //  QR code
  // -----------------------------------------------------------
  async generateQRCode(data) {
    const qrData = JSON.stringify({
      order: data.order_id,
      sku: data.product_barcode,
    });
    return QRCode.toBuffer(qrData, {
      errorCorrectionLevel: 'M',
      type: 'png',
      width: 200,
      margin: 1,
    });
  }

  // -----------------------------------------------------------
  //  Convert base64 PDF → Buffer
  // -----------------------------------------------------------
  base64ToBuffer(base64String) {
    const base64 = base64String.replace(/^data:application\/pdf;base64,/, '');
    return Buffer.from(base64, 'base64');
  }

  // -----------------------------------------------------------
  //  Build ONE sticker page (portrait) → returns PDFLib doc
  // -----------------------------------------------------------
  async createStickerPage(orderData) {
    const doc = new PDFDocument({
      size: [this.pageWidth, this.pageHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));

    // ----- generate images -----
    const [qrBuffer, barcodeBuffer] = await Promise.all([
      this.generateQRCode(orderData),
      this.generateBarcode(orderData.product_barcode),
    ]);

    // --------------------------------------------------------
    //  Layout (portrait page)
    // --------------------------------------------------------
    //  Left side – QR + kidsland
    const qrX = this.padding;
    const qrY = (this.pageHeight - this.qrSize) / 2;   // vertical centre

    doc.image(qrBuffer, qrX, qrY, {
      width: this.qrSize,
      height: this.qrSize,
    });

    const kidslandY = qrY + this.qrSize + 2;
    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', qrX, kidslandY, {
         width: this.qrSize,
         align: 'center',
       });

    //  Middle – SKU (rotated 90°)
    const textX = qrX + this.qrSize + this.padding * 2;
    const textWidth = this.pageWidth - textX - this.barcodeWidth - this.padding * 2;
    const textLineHeight = this.skuFontSize * 1.2;

    doc.save();
    const textCenterX = textX + textWidth / 2;
    const textCenterY = this.pageHeight / 2;
    doc.translate(textCenterX, textCenterY)
       .rotate(90);
    doc.fontSize(this.skuFontSize)
       .text(orderData.product_code || 'SKU-TEST-001', -textWidth / 2, -textLineHeight / 2, {
         width: textWidth,
         align: 'center',
       });
    doc.restore();

    //  Right side – barcode (rotated 180°)
    const barcodeX = this.pageWidth - this.barcodeWidth - this.padding;
    const barcodeY = (this.pageHeight - this.barcodeHeight) / 2;

    const bcCenterX = barcodeX + this.barcodeWidth / 2;
    const bcCenterY = barcodeY + this.barcodeHeight / 2;

    doc.save();
    doc.translate(bcCenterX, bcCenterY)
       .rotate(180)
       .translate(-this.barcodeWidth / 2, -this.barcodeHeight / 2);
    doc.image(barcodeBuffer, 0, 0, {
      width: this.barcodeWidth,
      height: this.barcodeHeight,
    });
    doc.restore();

    // --------------------------------------------------------
    //  Finalise PDF
    // --------------------------------------------------------
    return new Promise((resolve, reject) => {
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(buffers);
        const pdfLibDoc = await PDFLibDocument.load(pdfBuffer);
        resolve(pdfLibDoc);
      });
      doc.on('error', reject);
      doc.end();
    });
  }

  // -----------------------------------------------------------
  //  Rotate portrait page → landscape (final sticker size)
  // -----------------------------------------------------------
  async rotatePageToLandscape(stickerPdf) {
    const rotated = await PDFLibDocument.create();
    const [page] = await rotated.copyPages(stickerPdf, [0]);
    const rotatedPage = rotated.addPage([this.physicalWidthMm * 2.83465, this.physicalHeightMm * 2.83465]);

    // PDF-Lib rotate is clockwise 90°
    page.setRotation(90);
    rotatedPage.drawPage(page, {
      x: 0,
      y: 0,
      width: rotatedPage.getWidth(),
      height: rotatedPage.getHeight(),
    });

    const bytes = await rotated.save();
    return Buffer.from(bytes);
  }

  // -----------------------------------------------------------
  //  Build final pack: marketplace PDF + 2 stickers
  // -----------------------------------------------------------
  async createCompleteLabelPack(orderData, marketplaceLabel) {
    // ---- marketplace PDF ----
    let marketBuf;
    if (typeof marketplaceLabel === 'string') {
      marketBuf = this.base64ToBuffer(marketplaceLabel);
    } else if (Buffer.isBuffer(marketplaceLabel)) {
      marketBuf = marketplaceLabel;
    } else {
      throw new Error('Invalid marketplace label');
    }
    const marketPdf = await PDFLibDocument.load(marketBuf);

    // ---- one sticker (portrait) ----
    const stickerPortrait = await this.createStickerPage(orderData);

    // ---- rotate to landscape (final sticker) ----
    const stickerLandscapeBuf = await this.rotatePageToLandscape(stickerPortrait);
    const stickerLandscape = await PDFLibDocument.load(stickerLandscapeBuf);

    // ---- merge: market + sticker + sticker ----
    const merged = await PDFLibDocument.create();

    // market pages
    const marketIdx = marketPdf.getPageIndices();
    const marketCopies = await merged.copyPages(marketPdf, marketIdx);
    marketCopies.forEach((p) => merged.addPage(p));

    // two stickers
    for (let i = 0; i < 2; i++) {
      const [copy] = await merged.copyPages(stickerLandscape, [0]);
      merged.addPage(copy);
    }

    const finalBytes = await merged.save();
    return Buffer.from(finalBytes);
  }
}

// ----------------------------------------------------------------
//  Express routes
// ----------------------------------------------------------------
const generator = new LabelGenerator();

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/generate-label', async (req, res) => {
  try {
    const { orderData, marketplaceLabel } = req.body;
    if (!orderData || !marketplaceLabel) {
      return res.status(400).json({ error: 'Missing orderData or marketplaceLabel' });
    }
    if (!orderData.order_id || !orderData.product_barcode) {
      return res.status(400).json({ error: 'orderData needs order_id & product_barcode' });
    }

    const pdfBuf = await generator.createCompleteLabelPack(orderData, marketplaceLabel);
    res.json({
      success: true,
      pdf: pdfBuf.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Generation failed', message: e.message });
  }
});

app.post('/generate-from-order', async (req, res) => {
  try {
    const { orderData, marketplaceLabelUrl, authHeaders = {} } = req.body;
    if (!orderData || !marketplaceLabelUrl) {
      return res.status(400).json({ error: 'Missing orderData or marketplaceLabelUrl' });
    }

    const { data } = await axios.get(marketplaceLabelUrl, {
      headers: authHeaders,
      responseType: 'arraybuffer',
    });
    const pdfBuf = await generator.createCompleteLabelPack(orderData, Buffer.from(data));
    res.json({
      success: true,
      pdf: pdfBuf.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Generation failed', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Label service listening on ${PORT}`));

module.exports = app;
