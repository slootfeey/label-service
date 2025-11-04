// label-generator.js
const express = require('express');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument, degrees } = require('pdf-lib');
const svgToPDF = require('svg-to-pdfkit');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

class LabelGenerator {
  constructor() {
    const mm2pt = 2.83465;
    this.physicalWidthMm = 58;
    this.physicalHeightMm = 40;

    this.pageWidth = this.physicalHeightMm * mm2pt;  // 40mm
    this.pageHeight = this.physicalWidthMm * mm2pt;  // 58mm

    this.qrSize = 40;
    this.barcodeWidth = 70;
    this.barcodeHeight = 30;
    this.skuFontSize = 8;
    this.kidslandFontSize = 7;
    this.padding = 4;
  }

  // --- Generate SVG Barcode (CODE128) ---
  generateBarcodeSVG(data) {
    const code128 = this.encodeCode128(data);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.barcodeWidth}" height="${this.barcodeHeight}">`;
    svg += `<g transform="translate(5,20)">`;

    let x = 0;
    for (const bit of code128.pattern) {
      if (bit === '1') {
        svg += `<rect x="${x}" y="0" width="2" height="20" fill="black"/>`;
      }
      x += 2;
    }

    svg += `<text x="${x/2}" y="28" font-size="12" text-anchor="middle" fill="black">${data}</text>`;
    svg += `</g></svg>`;
    return svg;
  }

  encodeCode128(data) {
    // Simplified CODE128 B encoding (for demo)
    const chars = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    let pattern = '11011001100'; // Start B
    let sum = 104;

    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      const value = chars.indexOf(char);
      if (value === -1) continue;
      const weights = this.code128Table[value];
      pattern += weights;
      sum += value * (i + 1);
    }

    const checksum = sum % 103;
    pattern += this.code128Table[checksum];
    pattern += '11010010000'; // Stop
    pattern += '11'; // Termination

    return { pattern };
  }

  code128Table = [
    '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
    // ... (full table omitted for brevity — use a real one in prod)
    // For demo, we'll just use a placeholder pattern
  ].map(() => '101'); // placeholder

  // --- Generate QR SVG ---
  generateQRSVG(orderId, sku) {
    const text = JSON.stringify({ order: orderId, sku });
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 21 21">
        <path d="M0 0h7v7H0zm3 3h1v1H3zm11 0h1v1h-1zm-7 11h7v7H7zm4 4h1v1h-1zm7-4h7v7h-7zm4 4h1v1h-1z
                 M3 7h1v1H3zm11 0h1v1h-1zm-7 4h1v1H7zm7 0h1v1h-1zm-4-8h1v1h-1zm0 11h1v1h-1z"
              fill="black"/>
        <text x="10.5" y="19" font-size="2" text-anchor="middle">${text.substring(0,10)}...</text>
      </svg>
    `;
  }

  base64ToBuffer(base64) {
    return Buffer.from(base64.replace(/^data:application\/pdf;base64,/, ''), 'base64');
  }

  async createStickerPage(orderData) {
    const doc = new PDFDocument({
      size: [this.pageWidth, this.pageHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    const buffers = [];
    doc.on('data', c => buffers.push(c));

    // QR
    const qrSVG = this.generateQRSVG(orderData.order_id, orderData.product_barcode);
    const qrX = this.padding;
    const qrY = (this.pageHeight - this.qrSize) / 2;
    svgToPDF(doc, qrSVG, qrX, qrY, { width: this.qrSize, height: this.qrSize });

    // kidsland
    doc.fontSize(this.kidslandFontSize)
       .text('kidsland', qrX, qrY + this.qrSize + 2, {
         width: this.qrSize,
         align: 'center',
       });

    // SKU
    const textX = qrX + this.qrSize + this.padding * 2;
    const textWidth = this.pageWidth - textX - this.barcodeWidth - this.padding * 2;
    doc.save();
    doc.translate(textX + textWidth / 2, this.pageHeight / 2)
       .rotate(90);
    doc.fontSize(this.skuFontSize)
       .text(orderData.product_code || 'SKU-TEST', -textWidth/2, -6, {
         width: textWidth,
         align: 'center',
       });
    doc.restore();

    // Barcode (180°)
    const bcSVG = this.generateBarcodeSVG(orderData.product_barcode);
    const bcX = this.pageWidth - this.barcodeWidth - this.padding;
    const bcY = (this.pageHeight - this.barcodeHeight) / 2;
    const bcCx = bcX + this.barcodeWidth / 2;
    const bcCy = bcY + this.barcodeHeight / 2;

    doc.save();
    doc.translate(bcCx, bcCy)
       .rotate(180)
       .translate(-this.barcodeWidth/2, -this.barcodeHeight/2);
    svgToPDF(doc, bcSVG, 0, 0, { width: this.barcodeWidth, height: this.barcodeHeight });
    doc.restore();

    return new Promise((resolve, reject) => {
      doc.on('end', async () => {
        const pdfLib = await PDFLibDocument.load(Buffer.concat(buffers));
        resolve(pdfLib);
      });
      doc.on('error', reject);
      doc.end();
    });
  }

  async rotatePageToLandscape(portraitPdf) {
    const landscape = await PDFLibDocument.create();
    const [page] = await landscape.copyPages(portraitPdf, [0]);

    const w = this.physicalWidthMm * 2.83465;
    const h = this.physicalHeightMm * 2.83465;
    const newPage = landscape.addPage([w, h]);

    newPage.drawPage(page, {
      x: w,
      y: 0,
      width: portraitPdf.getPage(0).getHeight(),
      height: portraitPdf.getPage(0).getWidth(),
    });

    return Buffer.from(await landscape.save());
  }

  async createCompleteLabelPack(orderData, marketplaceLabel) {
    const marketBuf = typeof marketplaceLabel === 'string'
      ? this.base64ToBuffer(marketplaceLabel)
      : marketplaceLabel;

    const marketPdf = await PDFLibDocument.load(marketBuf);
    const portrait = await this.createStickerPage(orderData);
    const landscapeBuf = await this.rotatePageToLandscape(portrait);
    const landscape = await PDFLibDocument.load(landscapeBuf);

    const merged = await PDFLibDocument.create();
    const marketCopies = await merged.copyPages(marketPdf, marketPdf.getPageIndices());
    marketCopies.forEach(p => merged.addPage(p));

    for (let i = 0; i < 2; i++) {
      const [s] = await merged.copyPages(landscape, [0]);
      merged.addPage(s);
    }

    return Buffer.from(await merged.save());
  }
}

const generator = new LabelGenerator();

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/generate-label', async (req, res) => {
  try {
    const { orderData, marketplaceLabel } = req.body;
    if (!orderData || !marketplaceLabel) {
      return res.status(400).json({ error: 'Missing data' });
    }
    const pdf = await generator.createCompleteLabelPack(orderData, marketplaceLabel);
    res.json({
      success: true,
      pdf: pdf.toString('base64'),
      filename: `label_${orderData.order_id}.pdf`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
