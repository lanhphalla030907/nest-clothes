import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { join } from 'path';
import type { ReceiptOrderData } from './receipt.dto.js';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;

const FONT_REGULAR = 'NotoSans-Regular';
const FONT_BOLD = 'NotoSans-Bold';
const FONT_KHMER = 'NotoSansKhmer-Regular';

/** Store branding — edit in one place if the brand changes. */
const STORE_NAME = 'Studio';
const STORE_CONTACT_LINES = [
  '123 Garment Street',
  'Phnom Penh, Cambodia',
  '+855 12 345 678',
  'hello@studio.example.com',
];

export function renderReceiptToStream(
  data: ReceiptOrderData,
  stream: NodeJS.WritableStream,
): void {
  const doc = new (PDFDocument as any)({
    size: 'A4',
    layout: 'portrait',
    margins: {
      top: MARGIN,
      bottom: MARGIN,
      left: MARGIN,
      right: MARGIN,
    },
    autoPageBreak: false,
    info: {
      Title: `Order Receipt ${data.orderNumber}`,
      Author: STORE_NAME,
      Subject: 'Order Receipt',
    },
  }) as PDFKit.PDFDocument;

  doc.pipe(stream);

  // Register embedded fonts
  const fontDir = join(process.cwd(), 'src', 'receipts', 'fonts');
  doc.registerFont(FONT_REGULAR, join(fontDir, 'NotoSans-Regular.ttf'));
  doc.registerFont(FONT_KHMER, join(fontDir, 'NotoSansKhmer-Regular.ttf'));
  doc.registerFont(FONT_BOLD, join(fontDir, 'NotoSans-Regular.ttf'));

  // Track page numbers for footers
  let currentPage = 1;

  // Draw footer on every page added after the first
  doc.on('pageAdded', () => {
    currentPage++;
    renderFooter(doc, data, currentPage);
  });

  renderHeader(doc);
  renderCustomerBlock(doc, data);
  renderShippingBlock(doc, data);
  renderItemTable(doc, data);
  renderFinancialSummary(doc, data);
  renderPaymentBlock(doc, data);

  // Footer on the first (and possibly only) page
  renderFooter(doc, data, currentPage);

  doc.end();
}

/**
 * Convenience wrapper: renders a receipt to a file.
 */
export function renderReceiptToFile(
  data: ReceiptOrderData,
  filePath: string,
): void {
  const stream = createWriteStream(filePath);
  renderReceiptToStream(data, stream);
}

/** Store header block with branding and receipt title. */
function renderHeader(doc: PDFKit.PDFDocument): void {
  doc.font(FONT_REGULAR).fontSize(9).fillColor('#666666');
  doc.text(STORE_NAME, MARGIN, MARGIN, { align: 'left', lineBreak: false });

  doc.font(FONT_REGULAR).fontSize(8).fillColor('#999999');
  let y = MARGIN + 14;
  for (const line of STORE_CONTACT_LINES) {
    doc.text(line, MARGIN, y, { align: 'left', lineBreak: false });
    y += 10;
  }

  // Receipt title aligned right
  doc.font(FONT_BOLD).fontSize(20).fillColor('#111827');
  doc.text('ORDER RECEIPT', PAGE_WIDTH - MARGIN - doc.widthOfString('ORDER RECEIPT'), MARGIN, { lineBreak: false });

  doc.moveDown(2.5);
}

/** Customer details block. */
function renderCustomerBlock(doc: PDFKit.PDFDocument, data: ReceiptOrderData): void {
  doc.font(FONT_BOLD).fontSize(11).fillColor('#111827');
  doc.text('Customer', MARGIN, doc.y, { continued: false, lineBreak: false });

  const customerName = `${data.customer.firstName} ${data.customer.lastName}`;
  const hasKhmer = containsKhmer(customerName);
  doc.font(hasKhmer ? FONT_KHMER : FONT_REGULAR).fontSize(10).fillColor('#374151');
  doc.text(customerName, MARGIN, doc.y + 4, { lineBreak: false });

  doc.font(FONT_REGULAR).fontSize(9).fillColor('#6b7280');
  doc.text(data.customer.email, MARGIN, doc.y + 2, { lineBreak: false });
  doc.text(
    `Order ${data.orderNumber}  •  Placed ${formatDate(data.createdAt)}`,
    MARGIN,
    doc.y + 2,
    { lineBreak: false },
  );

  doc.moveDown(1.5);
}

/** Shipping address block from the immutable snapshot. */
function renderShippingBlock(doc: PDFKit.PDFDocument, data: ReceiptOrderData): void {
  doc.font(FONT_BOLD).fontSize(11).fillColor('#111827');
  doc.text('Delivering to', MARGIN, doc.y, { continued: false, lineBreak: false });

  const addressLines: string[] = [data.shipping.recipientName, data.shipping.phone];
  const pathLines = formatShippingLocationPath(data.shipping.locationPath);
  addressLines.push(...pathLines);
  if (data.shipping.postalCode) {
    addressLines.push(data.shipping.postalCode);
  }
  addressLines.push(data.shipping.countryCode);

  const hasKhmer = addressLines.some((line) => containsKhmer(line));
  doc.font(hasKhmer ? FONT_KHMER : FONT_REGULAR).fontSize(9).fillColor('#374151');

  let y = doc.y + 4;
  for (const line of addressLines) {
    doc.text(line, MARGIN, y, { lineBreak: false });
    y += 12;
  }
  doc.y = y + 8;
}

/** Item table: product, variant/SKU, qty, unit price, subtotal. */
function renderItemTable(doc: PDFKit.PDFDocument, data: ReceiptOrderData): void {
  const tableTop = doc.y + 8;

  doc.font(FONT_BOLD).fontSize(10).fillColor('#111827');
  doc.text('Items', MARGIN, tableTop);

  const colX = [MARGIN, MARGIN + 200, MARGIN + 340, MARGIN + 420, MARGIN + 480];
  const colW = [200, 100, 50, 60, 70];
  const headers = ['Product / SKU', 'Variant', 'Qty', 'Unit Price', 'Subtotal'];

  // Table header
  doc.font(FONT_BOLD).fontSize(8).fillColor('#6b7280');
  for (let i = 0; i < headers.length; i++) {
    const hx = i === 0 ? colX[i] : colX[i] + colW[i] - doc.widthOfString(headers[i]);
    doc.text(headers[i], hx, doc.y + 6, { lineBreak: false });
  }

  const headerBottom = doc.y + 18;
  doc.moveTo(MARGIN, headerBottom).lineTo(PAGE_WIDTH - MARGIN, headerBottom).stroke();

  // Table rows
  doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#374151');
  let rowY = headerBottom + 6;
  const rowHeight = 22;

  for (const item of data.items) {
    // Check if we need a new page before drawing this row
    if (rowY + rowHeight > PAGE_HEIGHT - MARGIN - 50) {
      doc.addPage();
      renderContinuationHeader(doc, data);
      rowY = MARGIN + 30;
    }

    const productLabel = `${item.productName}  •  ${item.sku}`;
    const hasKhmer = containsKhmer(productLabel);
    doc.font(hasKhmer ? FONT_KHMER : FONT_REGULAR);

    const productText = fitText(doc, productLabel, colW[0]);
    doc.text(productText, colX[0], rowY, { lineBreak: false });

    const variantText = fitText(doc, item.variantOptions, colW[1]);
    doc.text(variantText, colX[1], rowY, { lineBreak: false });

    const qtyText = String(item.quantity);
    doc.text(qtyText, colX[2] + colW[2] - doc.widthOfString(qtyText), rowY, {
      lineBreak: false,
    });

    const unitPriceText = item.unitPrice;
    doc.text(unitPriceText, colX[3] + colW[3] - doc.widthOfString(unitPriceText), rowY, {
      lineBreak: false,
    });

    const lineTotalText = item.lineTotal;
    doc.text(lineTotalText, colX[4] + colW[4] - doc.widthOfString(lineTotalText), rowY, {
      lineBreak: false,
    });

    rowY += rowHeight;
  }

  doc.y = rowY + 10;
}

/** Financial summary: subtotal, shipping, discount, total. */
function renderFinancialSummary(doc: PDFKit.PDFDocument, data: ReceiptOrderData): void {
  doc.font(FONT_BOLD).fontSize(10).fillColor('#111827');
  doc.text('Summary', MARGIN, doc.y, { lineBreak: false });

  const rows = [
    { label: 'Subtotal', value: data.financial.subtotal, currency: data.currency },
    { label: 'Shipping', value: data.financial.shippingFee, currency: data.currency },
    { label: 'Discount', value: data.financial.discountAmount, currency: data.currency },
    { label: 'Total', value: data.financial.totalAmount, currency: data.currency, bold: true },
  ];

  const labelX = PAGE_WIDTH - MARGIN - 120;
  const valueX = PAGE_WIDTH - MARGIN - 40;

  doc.font(FONT_REGULAR).fontSize(9).fillColor('#374151');
  let y = doc.y + 6;
  for (const row of rows) {
    doc.font(row.bold ? FONT_BOLD : FONT_REGULAR);
    doc.fontSize(row.bold ? 10 : 9);
    doc.fillColor(row.bold ? '#111827' : '#374151');
    doc.text(row.label, labelX + 80 - doc.widthOfString(row.label), y, { lineBreak: false });
    doc.text(row.currency + ' ' + row.value, valueX + 60 - doc.widthOfString(row.currency + ' ' + row.value), y, { lineBreak: false });
    y += 16;
  }

  doc.y = y + 14;
}

/** Payment and COD collection block. */
function renderPaymentBlock(doc: PDFKit.PDFDocument, data: ReceiptOrderData): void {
  doc.font(FONT_BOLD).fontSize(10).fillColor('#111827');
  doc.text('Payment', MARGIN, doc.y, { lineBreak: false });

  const lines: string[] = [];

  if (data.payment.paymentMethod === 'COD') {
    if (data.codCollection?.status === 'COLLECTED') {
      lines.push(
        'Cash on Delivery — Collected',
        `Collected ${data.codCollection.currency ?? data.currency} ${data.codCollection.amount}`,
        data.codCollection.collectedAt
          ? `Collected at ${formatDateTime(data.codCollection.collectedAt)}`
          : '',
        data.codCollection.collector
          ? `Collector: ${data.codCollection.collector.firstName} ${data.codCollection.collector.lastName}`
          : '',
      );
    } else {
      lines.push(
        'Cash on Delivery — Not collected',
        'No COD collection has been recorded for this order.',
      );
    }
  } else if (data.payment.paymentMethod === null) {
    lines.push('No payment method recorded.');
  } else {
    lines.push(`Payment method: ${data.payment.paymentMethod}`);
    switch (data.payment.status) {
      case 'PAID':
        lines.push(`Paid — ${data.payment.currency} ${data.payment.amount}`);
        if (data.payment.paidAt) {
          lines.push(`Paid at ${formatDateTime(data.payment.paidAt)}`);
        }
        break;
      case 'PENDING':
        lines.push('Payment pending — awaiting customer payment.');
        break;
      case 'FAILED':
        lines.push('Payment failed — the payment attempt was declined.');
        break;
      case 'EXPIRED':
        lines.push('Payment expired — the payment window has closed.');
        break;
      case 'NONE':
        lines.push('No payment attempt recorded.');
        break;
    }
  }

  const hasKhmer = lines.some((line) => containsKhmer(line));
  doc.font(hasKhmer ? FONT_KHMER : FONT_REGULAR).fontSize(8.5).fillColor('#374151');

  let y = doc.y + 4;
  for (const line of lines) {
    if (line.length > 0) {
      doc.text(line, MARGIN, y, { lineBreak: false });
    }
    y += 13;
  }

  doc.y = y + 10;
}

/** Footer on every page. */
function renderFooter(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  pageNum: number,
): void {
  const footerY = PAGE_HEIGHT - 40;

  doc.font(FONT_REGULAR).fontSize(7.5).fillColor('#999999');
  doc.moveTo(MARGIN, footerY).lineTo(PAGE_WIDTH - MARGIN, footerY).stroke();

  doc.text(
    `${STORE_NAME} — Order Receipt ${data.orderNumber}`,
    MARGIN,
    footerY + 6,
    { lineBreak: false },
  );

  doc.text(
    `Page ${pageNum}`,
    PAGE_WIDTH - MARGIN - doc.widthOfString(`Page ${pageNum}`),
    footerY + 6,
    { lineBreak: false },
  );
}

/** Repeating header on continuation pages. */
function renderContinuationHeader(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
): void {
  doc.font(FONT_REGULAR).fontSize(8).fillColor('#6b7280');
  doc.text(
    `Order Receipt ${data.orderNumber} — continued`,
    MARGIN,
    MARGIN - 12,
    { align: 'left', lineBreak: false },
  );
}

/** Truncates text with ellipsis if it exceeds maxWidth at the current font/size. */
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
): string {
  if (doc.widthOfString(text) <= maxWidth) {
    return text;
  }

  const ellipsis = '\u2026';
  const ellipsisWidth = doc.widthOfString(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    return ellipsis;
  }

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (doc.widthOfString(text.slice(0, mid)) + ellipsisWidth <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return text.slice(0, lo) + ellipsis;
}

/** Format a shipping location path into display lines. */
function formatShippingLocationPath(
  path: ReceiptOrderData['shipping']['locationPath'],
): string[] {
  if (!path) return [];

  return path.map((location) => {
    const label =
      location.adminLevel === 1
        ? 'Province'
        : location.adminLevel === 2
          ? 'District'
          : 'Commune';
    const name = location.nameKm && containsKhmer(location.nameKm)
      ? location.nameKm
      : location.nameEn;
    return `${label}: ${name}`;
  });
}

/** Detect whether a string contains any Khmer Unicode codepoints. */
function containsKhmer(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i);
    if (code !== undefined && code >= 0x1780 && code <= 0x17FF) {
      return true;
    }
  }
  return false;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
