import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { join } from 'path';
import type { ReceiptOrderData, ReceiptLine } from './receipt.dto.js';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_LINE_Y = PAGE_HEIGHT - 50;
const CONTENT_BOTTOM = FOOTER_LINE_Y - 18;
const FONT_REGULAR = 'NotoSans-Regular';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_KHMER = 'NotoSansKhmer-Regular';
const TEXT_COLOR = '#202833';
const MUTED_COLOR = '#657181';
const RULE_COLOR = '#D8DEE6';
const CELL_PADDING = 6;

const TABLE_COLUMNS = [
  { key: 'product', title: 'Product / SKU', width: 178, align: 'left' },
  { key: 'variant', title: 'Variant', width: 99, align: 'left' },
  { key: 'quantity', title: 'Qty', width: 37, align: 'right' },
  { key: 'unitPrice', title: 'Unit price', width: 91, align: 'right' },
  { key: 'lineTotal', title: 'Line total', width: 94, align: 'right' },
] as const;

interface ReceiptLayoutState {
  pageNumber: number;
}

interface ReceiptPaymentLine {
  label: string;
  value?: string;
}

export function renderReceiptToStream(
  data: ReceiptOrderData,
  stream: NodeJS.WritableStream,
): void {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margin: 0,
    autoFirstPage: true,
    bufferPages: false,
    info: {
      Title: `Order Receipt ${data.orderNumber}`,
      Subject: 'Order Receipt',
    },
  });
  const state: ReceiptLayoutState = { pageNumber: 1 };

  doc.pipe(stream);

  const fontDir = join(process.cwd(), 'src', 'receipts', 'fonts');
  doc.registerFont(FONT_REGULAR, join(fontDir, 'NotoSans-Regular.ttf'));
  doc.registerFont(FONT_KHMER, join(fontDir, 'NotoSansKhmer-Regular.ttf'));

  let y = renderHeader(doc, data);
  y = renderInformation(doc, data, state, y);
  y = renderItems(doc, data, state, y);
  y = renderSummaryAndPayment(doc, data, state, y);

  renderFooter(doc, data, state.pageNumber);
  doc.end();
}

export function renderReceiptToFile(
  data: ReceiptOrderData,
  filePath: string,
): void {
  const stream = createWriteStream(filePath);
  renderReceiptToStream(data, stream);
}

function renderHeader(doc: PDFKit.PDFDocument, data: ReceiptOrderData): number {
  doc.font(FONT_BOLD).fontSize(20).fillColor(TEXT_COLOR);
  doc.text('ORDER RECEIPT', MARGIN, MARGIN, { lineBreak: false });

  doc.font(FONT_REGULAR).fontSize(9).fillColor(MUTED_COLOR);
  doc.text(`Order ${data.orderNumber}`, MARGIN, MARGIN + 31, {
    lineBreak: false,
  });
  doc.text(`Placed ${formatDate(data.createdAt)}`, MARGIN, MARGIN + 46, {
    lineBreak: false,
  });

  doc
    .moveTo(MARGIN, MARGIN + 68)
    .lineTo(PAGE_WIDTH - MARGIN, MARGIN + 68)
    .lineWidth(0.8)
    .strokeColor(RULE_COLOR)
    .stroke();

  return MARGIN + 84;
}

function renderInformation(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  state: ReceiptLayoutState,
  y: number,
): number {
  const columnGap = 28;
  const columnWidth = (CONTENT_WIDTH - columnGap) / 2;
  const customerLines = [
    joinedName(data.customer.firstName, data.customer.lastName),
    data.customer.email,
  ].filter(isPresent);
  const shippingLines = buildShippingLines(data);
  const customerHeight = measureInformationColumn(
    doc,
    customerLines,
    columnWidth,
  );
  const shippingHeight = measureInformationColumn(
    doc,
    shippingLines,
    columnWidth,
  );
  const blockHeight = Math.max(customerHeight, shippingHeight);

  y = ensureSpace(doc, data, state, y, blockHeight + 20);
  const leftX = MARGIN;
  const rightX = MARGIN + columnWidth + columnGap;

  drawInformationColumn(doc, 'CUSTOMER', customerLines, leftX, columnWidth, y);
  drawInformationColumn(doc, 'SHIP TO', shippingLines, rightX, columnWidth, y);

  return y + blockHeight + 24;
}

function buildShippingLines(data: ReceiptOrderData): string[] {
  const shipping = data.shipping;
  const cityRegion = [
    ...new Set([shipping.city, shipping.stateProvince].filter(isPresent)),
  ].join(', ');
  const locality = [cityRegion, shipping.postalCode]
    .filter(isPresent)
    .join('  ');
  const lines = [
    shipping.recipientName,
    shipping.phone,
    shipping.addressLine1,
    shipping.addressLine2,
  ];

  if (locality.length > 0) lines.push(locality);
  if (shipping.countryCode.trim().length > 0) lines.push(shipping.countryCode);
  if (!isPresent(shipping.city) && !isPresent(shipping.stateProvince)) {
    lines.push(...formatShippingLocationPath(shipping.locationPath));
  }

  return lines.filter(isPresent);
}

function measureInformationColumn(
  doc: PDFKit.PDFDocument,
  lines: string[],
  width: number,
): number {
  const innerWidth = width - CELL_PADDING * 2;
  let height = 13;

  for (const [index, line] of lines.entries()) {
    const font = containsKhmer(line) ? FONT_KHMER : FONT_REGULAR;
    height += measureText(doc, line, innerWidth, 9, font);
    if (index < lines.length - 1) height += 3;
  }

  return height + CELL_PADDING * 2;
}

function drawInformationColumn(
  doc: PDFKit.PDFDocument,
  title: string,
  lines: string[],
  x: number,
  width: number,
  y: number,
): void {
  doc.font(FONT_BOLD).fontSize(8).fillColor(MUTED_COLOR);
  doc.text(title, x, y, { lineBreak: false });

  let lineY = y + 16;
  const innerX = x + CELL_PADDING;
  const innerWidth = width - CELL_PADDING * 2;

  for (const [index, line] of lines.entries()) {
    const font = containsKhmer(line) ? FONT_KHMER : FONT_REGULAR;
    const height = drawWrappedText(
      doc,
      line,
      innerX,
      lineY,
      innerWidth,
      9,
      font,
      TEXT_COLOR,
    );
    lineY += height + (index < lines.length - 1 ? 3 : 0);
  }

  doc
    .moveTo(x, y + 12)
    .lineTo(x + width, y + 12)
    .lineWidth(0.6)
    .strokeColor(RULE_COLOR)
    .stroke();
}

function renderItems(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  state: ReceiptLayoutState,
  y: number,
): number {
  y = ensureSpace(doc, data, state, y, 44);
  doc.font(FONT_BOLD).fontSize(11).fillColor(TEXT_COLOR);
  doc.text('Items', MARGIN, y, { lineBreak: false });
  y += 20;
  y = drawTableHeader(doc, y);

  for (const item of data.items) {
    const heights = measureItemCells(doc, item, data.currency);
    const rowHeight = Math.max(26, Math.max(...heights) + CELL_PADDING * 2);

    if (y + rowHeight > CONTENT_BOTTOM) {
      startContinuationPage(doc, data, state);
      y = drawContinuationTableHeader(doc, data);
    }

    drawItemRow(doc, item, data.currency, y, rowHeight);
    y += rowHeight;
  }

  return y + 18;
}

function measureItemCells(
  doc: PDFKit.PDFDocument,
  item: ReceiptLine,
  currency: string,
): number[] {
  const productWidth = TABLE_COLUMNS[0].width - CELL_PADDING * 2;
  const variantWidth = TABLE_COLUMNS[1].width - CELL_PADDING * 2;
  const quantityWidth = TABLE_COLUMNS[2].width - CELL_PADDING * 2;
  const unitWidth = TABLE_COLUMNS[3].width - CELL_PADDING * 2;
  const totalWidth = TABLE_COLUMNS[4].width - CELL_PADDING * 2;
  const productHeight = measureText(
    doc,
    item.productName,
    productWidth,
    9,
    containsKhmer(item.productName) ? FONT_KHMER : FONT_REGULAR,
  );
  const skuHeight = measureText(
    doc,
    `SKU: ${item.sku}`,
    productWidth,
    7.5,
    FONT_REGULAR,
  );
  const variantHeight = isPresent(item.variantOptions)
    ? measureText(
        doc,
        item.variantOptions,
        variantWidth,
        8.5,
        containsKhmer(item.variantOptions) ? FONT_KHMER : FONT_REGULAR,
      )
    : 0;

  return [
    productHeight + 2 + skuHeight,
    variantHeight,
    measureText(doc, String(item.quantity), quantityWidth, 8.5, FONT_REGULAR),
    measureText(
      doc,
      formatMoney(currency, item.unitPrice),
      unitWidth,
      8.2,
      FONT_REGULAR,
    ),
    measureText(
      doc,
      formatMoney(currency, item.lineTotal),
      totalWidth,
      8.2,
      FONT_REGULAR,
    ),
  ];
}

function drawItemRow(
  doc: PDFKit.PDFDocument,
  item: ReceiptLine,
  currency: string,
  y: number,
  height: number,
): void {
  const productX = MARGIN + CELL_PADDING;
  const productWidth = TABLE_COLUMNS[0].width - CELL_PADDING * 2;
  const productFont = containsKhmer(item.productName)
    ? FONT_KHMER
    : FONT_REGULAR;
  let productY = y + CELL_PADDING;
  productY += drawWrappedText(
    doc,
    item.productName,
    productX,
    productY,
    productWidth,
    9,
    productFont,
    TEXT_COLOR,
  );
  productY += 2;
  drawWrappedText(
    doc,
    `SKU: ${item.sku}`,
    productX,
    productY,
    productWidth,
    7.5,
    FONT_REGULAR,
    MUTED_COLOR,
  );

  const variantX = MARGIN + TABLE_COLUMNS[0].width + CELL_PADDING;
  if (isPresent(item.variantOptions)) {
    drawWrappedText(
      doc,
      item.variantOptions,
      variantX,
      y + CELL_PADDING,
      TABLE_COLUMNS[1].width - CELL_PADDING * 2,
      8.5,
      containsKhmer(item.variantOptions) ? FONT_KHMER : FONT_REGULAR,
      TEXT_COLOR,
    );
  }

  const rowMiddleY = y + Math.max(CELL_PADDING, (height - 10) / 2);
  drawCellValue(doc, String(item.quantity), 2, rowMiddleY, 8.5, FONT_REGULAR);
  drawCellValue(
    doc,
    formatMoney(currency, item.unitPrice),
    3,
    y + CELL_PADDING,
    8.2,
    FONT_REGULAR,
  );
  drawCellValue(
    doc,
    formatMoney(currency, item.lineTotal),
    4,
    y + CELL_PADDING,
    8.2,
    FONT_REGULAR,
  );

  doc
    .moveTo(MARGIN, y + height)
    .lineTo(PAGE_WIDTH - MARGIN, y + height)
    .lineWidth(0.45)
    .strokeColor(RULE_COLOR)
    .stroke();
}

function drawCellValue(
  doc: PDFKit.PDFDocument,
  value: string,
  columnIndex: number,
  y: number,
  fontSize: number,
  font: string,
): void {
  const columnX =
    MARGIN +
    TABLE_COLUMNS.slice(0, columnIndex).reduce(
      (total, column) => total + column.width,
      0,
    );
  const width = TABLE_COLUMNS[columnIndex].width - CELL_PADDING * 2;
  drawWrappedText(
    doc,
    value,
    columnX + CELL_PADDING,
    y,
    width,
    fontSize,
    font,
    TEXT_COLOR,
    'right',
  );
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.rect(MARGIN, y, CONTENT_WIDTH, 25).fill('#F2F4F7');

  let x = MARGIN;
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(MUTED_COLOR);
  for (const column of TABLE_COLUMNS) {
    doc.text(column.title, x + CELL_PADDING, y + 8, {
      width: column.width - CELL_PADDING * 2,
      align: column.align,
      lineBreak: false,
    });
    x += column.width;
  }

  return y + 25;
}

function drawContinuationTableHeader(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
): number {
  const y = renderContinuationHeader(doc, data);
  return drawTableHeader(doc, y + 10);
}

function renderSummaryAndPayment(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  state: ReceiptLayoutState,
  y: number,
): number {
  const paymentLines = buildPaymentLines(data);
  const summaryHeight = 24 + 4 * 19 + 10;
  const paymentHeight =
    20 +
    paymentLines.reduce((total, line) => {
      const labelHeight = measureText(doc, line.label, 104, 8.5, FONT_REGULAR);
      const value = line.value ?? '';
      const valueHeight = measureText(
        doc,
        value,
        CONTENT_WIDTH - 112,
        8.5,
        containsKhmer(value) ? FONT_KHMER : FONT_REGULAR,
      );
      return total + Math.max(labelHeight, valueHeight) + 4;
    }, 0);

  y = ensureSpace(doc, data, state, y, summaryHeight + paymentHeight + 16);
  y = renderFinancialSummary(doc, data, y);
  return renderPaymentBlock(doc, paymentLines, y + 10);
}

function renderFinancialSummary(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  y: number,
): number {
  doc.font(FONT_BOLD).fontSize(11).fillColor(TEXT_COLOR);
  doc.text('Order total', MARGIN, y, { lineBreak: false });
  y += 24;

  const rows = [
    {
      label: 'Subtotal',
      value: formatMoney(data.currency, data.financial.subtotal),
    },
    {
      label: 'Shipping',
      value: formatMoney(data.currency, data.financial.shippingFee),
    },
    {
      label: 'Discount',
      value: `-${formatMoney(data.currency, data.financial.discountAmount)}`,
    },
    {
      label: 'Total',
      value: formatMoney(data.currency, data.financial.totalAmount),
      total: true,
    },
  ];
  const labelX = PAGE_WIDTH - MARGIN - 190;
  const valueX = PAGE_WIDTH - MARGIN - 180;
  const valueWidth = 180;

  for (const row of rows) {
    if (row.total) {
      doc
        .moveTo(labelX, y - 4)
        .lineTo(PAGE_WIDTH - MARGIN, y - 4)
        .lineWidth(0.8)
        .strokeColor(RULE_COLOR)
        .stroke();
    }

    doc
      .font(row.total ? FONT_BOLD : FONT_REGULAR)
      .fontSize(row.total ? 11 : 9)
      .fillColor(row.total ? TEXT_COLOR : MUTED_COLOR);
    doc.text(row.label, labelX, y, { lineBreak: false });
    doc.text(row.value, valueX, y, {
      width: valueWidth,
      align: 'right',
      lineBreak: false,
    });
    y += 19;
  }

  return y + 10;
}

function buildPaymentLines(data: ReceiptOrderData): ReceiptPaymentLine[] {
  if (data.payment.paymentMethod === 'COD') {
    if (data.codCollection?.status === 'COLLECTED') {
      const lines: ReceiptPaymentLine[] = [
        { label: 'Payment method', value: 'Cash on delivery' },
        { label: 'Collection status', value: 'Collected' },
      ];
      if (data.codCollection.amount !== null) {
        lines.push({
          label: 'Collected amount',
          value: formatMoney(
            data.codCollection.currency ?? data.currency,
            data.codCollection.amount,
          ),
        });
      }
      if (data.codCollection.collectedAt !== null) {
        lines.push({
          label: 'Collected at',
          value: formatDateTime(data.codCollection.collectedAt),
        });
      }
      if (data.codCollection.collector !== null) {
        lines.push({
          label: 'Collected by',
          value: joinedName(
            data.codCollection.collector.firstName,
            data.codCollection.collector.lastName,
          ),
        });
      }
      return lines;
    }

    return [
      { label: 'Payment method', value: 'Cash on delivery' },
      { label: 'Collection status', value: 'Not collected' },
    ];
  }

  if (data.payment.paymentMethod === null) {
    return [{ label: 'Payment status', value: 'No payment method recorded' }];
  }

  const lines: ReceiptPaymentLine[] = [
    {
      label: 'Payment method',
      value: paymentMethodLabel(data.payment.paymentMethod),
    },
    { label: 'Payment status', value: paymentStatusLabel(data.payment.status) },
  ];
  if (data.payment.status === 'PAID' && data.payment.amount !== null) {
    lines.push({
      label: 'Paid amount',
      value: formatMoney(
        data.payment.currency ?? data.currency,
        data.payment.amount,
      ),
    });
  }
  if (data.payment.status === 'PAID' && data.payment.paidAt !== null) {
    lines.push({
      label: 'Paid at',
      value: formatDateTime(data.payment.paidAt),
    });
  }
  return lines;
}

function renderPaymentBlock(
  doc: PDFKit.PDFDocument,
  lines: ReceiptPaymentLine[],
  y: number,
): number {
  doc.font(FONT_BOLD).fontSize(10).fillColor(TEXT_COLOR);
  doc.text('Payment', MARGIN, y, { lineBreak: false });
  y += 20;

  const labelWidth = 112;
  const valueX = MARGIN + labelWidth;
  const valueWidth = CONTENT_WIDTH - labelWidth;

  for (const line of lines) {
    doc.font(FONT_REGULAR).fontSize(8.5).fillColor(MUTED_COLOR);
    doc.text(line.label, MARGIN, y, {
      width: labelWidth - 8,
      lineGap: 2,
    });
    const labelHeight = measureText(
      doc,
      line.label,
      labelWidth - 8,
      8.5,
      FONT_REGULAR,
    );
    const value = line.value ?? '';
    const valueFont = containsKhmer(value) ? FONT_KHMER : FONT_REGULAR;
    const height = drawWrappedText(
      doc,
      value,
      valueX,
      y,
      valueWidth,
      8.5,
      valueFont,
      TEXT_COLOR,
    );
    y += Math.max(height, labelHeight) + 4;
  }

  return y;
}

function ensureSpace(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  state: ReceiptLayoutState,
  y: number,
  requiredHeight: number,
): number {
  if (y + requiredHeight <= CONTENT_BOTTOM) return y;
  return startContinuationPage(doc, data, state);
}

function startContinuationPage(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  state: ReceiptLayoutState,
): number {
  renderFooter(doc, data, state.pageNumber);
  doc.addPage({
    size: 'A4',
    layout: 'portrait',
    margin: 0,
    autoFirstPage: false,
  });
  state.pageNumber += 1;
  return renderContinuationHeader(doc, data);
}

function renderContinuationHeader(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
): number {
  doc.font(FONT_BOLD).fontSize(10).fillColor(TEXT_COLOR);
  doc.text('ORDER RECEIPT', MARGIN, MARGIN, { lineBreak: false });
  doc.font(FONT_REGULAR).fontSize(8).fillColor(MUTED_COLOR);
  doc.text(`Order ${data.orderNumber} - continued`, MARGIN, MARGIN + 17, {
    lineBreak: false,
  });
  doc
    .moveTo(MARGIN, MARGIN + 34)
    .lineTo(PAGE_WIDTH - MARGIN, MARGIN + 34)
    .lineWidth(0.6)
    .strokeColor(RULE_COLOR)
    .stroke();
  return MARGIN + 47;
}

function renderFooter(
  doc: PDFKit.PDFDocument,
  data: ReceiptOrderData,
  pageNumber: number,
): void {
  doc
    .moveTo(MARGIN, FOOTER_LINE_Y)
    .lineTo(PAGE_WIDTH - MARGIN, FOOTER_LINE_Y)
    .lineWidth(0.6)
    .strokeColor(RULE_COLOR)
    .stroke();

  doc.font(FONT_REGULAR).fontSize(7.5).fillColor(MUTED_COLOR);
  doc.text(`Order ${data.orderNumber}`, MARGIN, FOOTER_LINE_Y + 8, {
    lineBreak: false,
  });
  const pageText = `Page ${pageNumber}`;
  doc.text(
    pageText,
    PAGE_WIDTH - MARGIN - doc.widthOfString(pageText),
    FOOTER_LINE_Y + 8,
    {
      lineBreak: false,
    },
  );
}

function drawWrappedText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  font: string,
  color: string,
  align: 'left' | 'right' = 'left',
): number {
  doc.font(font).fontSize(fontSize).fillColor(color);
  const height = doc.heightOfString(text, { width, lineGap: 2 });
  doc.text(text, x, y, { width, lineGap: 2, align });
  return height;
}

function measureText(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  fontSize: number,
  font: string,
): number {
  doc.font(font).fontSize(fontSize);
  return doc.heightOfString(text, { width, lineGap: 2 });
}

function formatMoney(currency: string, value: string): string {
  return `${currency} ${value}`;
}

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
    const name =
      location.nameKm && containsKhmer(location.nameKm)
        ? location.nameKm
        : location.nameEn;
    return `${label}: ${name}`;
  });
}

function joinedName(firstName: string, lastName: string): string {
  return [firstName, lastName].filter(isPresent).join(' ');
}

function paymentStatusLabel(
  status: ReceiptOrderData['payment']['status'],
): string {
  switch (status) {
    case 'PAID':
      return 'Paid';
    case 'PENDING':
      return 'Pending';
    case 'FAILED':
      return 'Failed';
    case 'EXPIRED':
      return 'Expired';
    case 'NONE':
      return 'No payment attempt recorded';
  }
}

function paymentMethodLabel(method: string): string {
  switch (method) {
    case 'ABA_PAYWAY':
      return 'ABA PayWay';
    case 'ABA_PAY':
      return 'ABA Pay';
    default:
      return method;
  }
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function containsKhmer(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i);
    if (code !== undefined && code >= 0x1780 && code <= 0x17ff) {
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
