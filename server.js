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
    this.stickerWidth = 58 * 2.83465;
    this.stickerHeight = 40 * 2.83465;
  }

  async generateBarcode(data) {
    try {
      const canvas = createCanvas(250, 100);
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
    
    const qrSize = 35;
    doc.image(qrCodeBuffer, padding, padding, {
      width: qrSize,
      height: qrSize
    });

    const barcodeX = padding + qrSize + 5;
    const barcodeWidth = contentWidth - qrSize - 5;
    
    doc.image(barcodeBuffer, barcodeX, padding + 5, {
      width: barcodeWidth,
      height: 25
    });

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

    let labelBuffer;
