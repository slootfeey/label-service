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

// ---------------------------------------------------------------
//  LabelGenerator – portrait → landscape rotation (PDF-Lib)
// ---------------------------------------------------------------
class LabelGenerator {
  constructor() {
    const mm2pt = 2.83465;
    this.physicalWidthMm  = 58;   // final sticker width after rotation
    this.physicalHeightMm = 40;   // final sticker height after rotation

    // PDF page is built **portrait** (height > width)
    this.pageWidth  = this.physicalHeightMm * mm2pt; // 40 mm → ~113.4 pt
    this.pageHeight = this.physicalWidthMm  * mm2pt; // 58 mm → ~164.4 pt

    this.qrSize          = 40;
    this.barcodeWidth    = 70;
    this.barcodeHeight   = 30;
    this.skuFontSize     = 8;
    this.kidslandFontSize= 7;
    this.padding         = 4;
  }

  // -----------------------------------------------------------
  //  Barcode – numbers **below** the bars, centred
  // -----------------------------------------------------------
  async generateBarcode(data) {
    const canvas = createCanvas(300, 100);
    JsBarcode(canvas, data, {
      format: 'CODE128',
      width: 2,
      height: 45,
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
  //  base64 → Buffer
  // -----------------------------------------------------------
  base64ToBuffer(base64String) {
    const base64 = base64String.replace(/^data:application\/pdf;base64,/, '');
    return Buffer.from(base64, 'base64');
  }

  // -----------------------------------------------------------
  //  ONE sticker page (portrait) → PDFLib doc
  // -----------------------------------------------------------
  async createStickerPage(orderData) {
    const doc = new PDFDocument({
      size: [this.pageWidth, this.pageHeight],
      margins: { top:0, bottom:0, left:0, right:0 },
    });

    const buffers = [];
    doc.on('data', c => buffers.push(c));

    const [qrBuf, bcBuf] = await Promise.all([
      this.generateQRCode(orderData),
      this.generateBarcode(orderData.product_barcode),
    ]);

    // ----- QR + kidsland (left) -----
    const qrX = this.padding;
    const qrY = (this.pageHeight - this.qrSize) / 2;

    doc.image(qrBuf, qrX, qrY, { width:this.qrSize, height:this.qrSize });

    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', qrX, qrY + this.qrSize + 2, {
         width: this.qrSize,
         align: 'center',
       });

    // ----- SKU (middle, rotated 90°) -----
    const textX     = qrX + this.qrSize + this.padding * 2;
    const textWidth = this.pageWidth - textX - this.barcodeWidth - this.padding * 2;
    const lineH     = this.skuFontSize * 1.2;

    doc.save();
    const txtCx = textX + textWidth / 2;
    const txtCy = this.pageHeight / 2;
    doc.translate(txtCx, txtCy).rotate(90);
    doc.fontSize(this.skuFontSize)
       .text(orderData.product_code || 'SKU-TEST-001',
             -textWidth/2, -lineH/2,
             { width: textWidth, align:'center' });
    doc.restore();

    // ----- Barcode (right, rotated 180°) -----
    const bcX = this.pageWidth - this.barcodeWidth - this.padding;
    const bcY = (this.pageHeight - this.barcodeHeight) / 2;

    const bcCx = bcX + this.barcodeWidth  / 2;
    const bcCy = bcY + this.barcodeHeight / 2;

    doc.save();
    doc.translate(bcCx, bcCy)
       .rotate(180)
       .translate(-this.barcodeWidth/2, -this.barcodeHeight/2);
    doc.image(bcBuf, 0, 0, {
      width: this.barcodeWidth,
      height: this.barcodeHeight,
    });
    doc.restore();

    // ----- finish -----
    return new Promise((resolve, reject) => {
      doc.on('end', async () => {
        const pdfLib = await PDFLibDocument.load(Buffer.concat(buffers));
        resolve(pdfLib);
      });
      doc.on('error', reject);
      doc.end();
    });
  }

  // -----------------------------------------------------------
  //  Rotate portrait → landscape (90° clockwise) – PDF-Lib only
  // -----------------------------------------------------------
  async rotatePageToLandscape(portraitPdf) {
    const landscape = await PDFLibDocument.create();

    // copy the original portrait page
    const [origPage] = await landscape.copyPages(portraitPdf, [0]);

    // final sticker size
    const w = this.physicalWidthMm  * 2.83465;   // 58 mm
    const h = this.physicalHeightMm * 2.83465;   // 40 mm
    const page = landscape.addPage([w, h]);

    // ----- transformation matrix for 90° clockwise -----
    //   [ 0  1 ]   →  (x,y) becomes (w-y, x)
    //   [-1  0 ]
    //   tx = w, ty = 0
    page.drawPage(origPage, {
      x: w,
      y: 0,
      width:  portraitPdf.getPage(0).getHeight(), // original height becomes new width
      height: portraitPdf.getPage(0).getWidth(),  // original width becomes new height
      rotate: PDFLibDegrees.of(90),               // PDF-Lib built-in rotation
    });

    const bytes = await landscape.save();
    return Buffer.from(bytes);
  }

  // -----------------------------------------------------------
  //  Final pack: marketplace + 2 stickers
  // -----------------------------------------------------------
  async createCompleteLabelPack(orderData, marketplaceLabel) {
    // ---- marketplace PDF ----
    let marketBuf;
    if (typeof marketplaceLabel === 'string')
      marketBuf = this.base64ToBuffer(marketplaceLabel);
    else if (Buffer.isBuffer(marketplaceLabel))
      marketBuf = marketplaceLabel;
    else throw new Error('Invalid marketplace label');

    const marketPdf = await PDFLibDocument.load(marketBuf);

    // ---- one portrait sticker ----
    const portrait = await this.createStickerPage(orderData);

    // ---- rotate to final landscape ----
    const landscapeBuf = await this.rotatePageToLandscape(portrait);
    const landscapePdf = await PDFLibDocument.load(landscapeBuf);

    // ---- merge everything ----
    const merged = await PDFLibDocument.create();

    // marketplace pages
    const marketIdx = marketPdf.getPageIndices();
    const marketCopies = await merged.copyPages(marketPdf, marketIdx);
    marketCopies.forEach(p => merged.addPage(p));

    // two stickers
    for (let i = 0; i < 2; i++) {
      const [sticker] = await merged.copyPages(landscapePdf, [0]);
      merged.addPage(sticker);
    }

    const final = await merged.save();
    return Buffer.from(final);
  }
}
