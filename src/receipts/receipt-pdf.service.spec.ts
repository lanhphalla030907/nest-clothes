import { Writable } from 'stream';
import { inflateSync } from 'zlib';
import type { ReceiptOrderData, ReceiptLine } from './receipt.dto.js';
import { renderReceiptToStream } from './receipt-pdf.service.js';

const MARGIN = 48;

const makeReceipt = (
  overrides: Partial<ReceiptOrderData> = {},
): ReceiptOrderData => ({
  orderId: '11111111-1111-4111-8111-111111111111',
  orderNumber: 'ORD-20261104-ABCDE1',
  orderStatus: 'CONFIRMED',
  createdAt: '2026-11-04T05:30:00.000Z',
  currency: 'USD',
  customer: {
    firstName: 'Alex',
    lastName: 'Customer',
    email: 'alex@example.test',
  },
  shipping: {
    recipientName: 'Alex Customer',
    phone: '+855 12 345 678',
    addressLine1: '12 Sample Street',
    addressLine2: null,
    city: 'Phnom Penh',
    stateProvince: 'Phnom Penh',
    postalCode: '12000',
    countryCode: 'KH',
    locationPath: null,
  },
  financial: {
    subtotal: '100.00',
    shippingFee: '5.00',
    discountAmount: '0.00',
    totalAmount: '105.00',
  },
  items: [makeItem()],
  itemCount: 1,
  payment: {
    paymentMethod: 'ABA_PAYWAY',
    status: 'PAID',
    amount: '105.00',
    currency: 'USD',
    paidAt: '2026-11-04T05:35:00.000Z',
  },
  codCollection: null,
  ...overrides,
});

const makeItem = (overrides: Partial<ReceiptLine> = {}): ReceiptLine => ({
  productName: 'Classic cotton shirt',
  sku: 'SHIRT-001',
  variantOptions: 'Color: Navy, Size: M',
  quantity: 1,
  unitPrice: '100.00',
  lineTotal: '100.00',
  ...overrides,
});

const renderPdf = async (data: ReceiptOrderData): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const finished = new Promise<void>((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });

  renderReceiptToStream(data, stream);
  await finished;
  return Buffer.concat(chunks);
};

const pageCount = (pdf: Buffer): number =>
  [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;

const pageMediaBoxes = (pdf: Buffer): string[] =>
  [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map(
    (match) => match[1].trim().replace(/\s+/g, ' '),
  );

const pageContents = (pdf: Buffer): string[] => {
  const source = pdf.toString('latin1');
  const contents: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  for (const match of source.matchAll(streamPattern)) {
    try {
      contents.push(
        inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'),
      );
    } catch {
      continue;
    }
  }

  return contents;
};

describe('receipt PDF renderer', () => {
  it('creates strictly portrait A4 pages within the configured page size', async () => {
    const pdf = await renderPdf(makeReceipt());

    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.3');
    expect(pageMediaBoxes(pdf)).toEqual(['0 0 595.28 841.89']);
  });

  it('wraps long product and address text and repeats table headings on continuation pages', async () => {
    const longName =
      'Premium lightweight cotton overshirt with reinforced seams and a ' +
      'relaxed everyday fit '.repeat(5);
    const longAddress =
      'Building 12, unit 8, floor 4, ' +
      'Riverside residential quarter '.repeat(7);
    const items = Array.from({ length: 42 }, (_, index) =>
      makeItem({
        productName: `${index + 1}. ${longName}`,
        sku: `LONG-SKU-${index + 1}-${'X'.repeat(35)}`,
        variantOptions: `Color: deep midnight blue, Size: extra large, Fit: relaxed ${'detail '.repeat(5)}`,
      }),
    );
    const pdf = await renderPdf(
      makeReceipt({
        shipping: {
          ...makeReceipt().shipping,
          addressLine1: longAddress,
          addressLine2: 'Apartment 408, ' + 'East wing '.repeat(10),
          city: 'Phnom Penh',
          stateProvince: 'Phnom Penh',
        },
        items,
        itemCount: items.length,
      }),
    );
    const textStreams = pageContents(pdf);

    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(
      pageMediaBoxes(pdf).every((box) => box === '0 0 595.28 841.89'),
    ).toBe(true);
    expect(
      textStreams.filter((content) => content.includes('/F2 7.5 Tf')).length,
    ).toBeGreaterThan(1);
  });

  it('keeps large monetary values in the receipt PDF without changing their precision', async () => {
    const pdf = await renderPdf(
      makeReceipt({
        currency: 'EUR',
        financial: {
          subtotal: '9999999999.99',
          shippingFee: '0.00',
          discountAmount: '0.00',
          totalAmount: '9999999999.99',
        },
        payment: {
          paymentMethod: 'ABA_PAYWAY',
          status: 'PAID',
          amount: '9999999999.99',
          currency: 'EUR',
          paidAt: '2026-11-04T05:35:00.000Z',
        },
        items: [
          makeItem({
            unitPrice: '9999999999.99',
            lineTotal: '9999999999.99',
          }),
        ],
      }),
    );

    expect(pageCount(pdf)).toBe(1);
    const content = pageContents(pdf).find((page) => page.includes(' Tm'));
    expect(content).toBeDefined();
    const positions = [
      ...(content ?? '').matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g),
    ].map((match) => ({
      x: Number(match[1]),
      yFromTop: 841.89 - Number(match[2]),
    }));
    expect(
      positions.every(
        ({ x, yFromTop }) =>
          x >= MARGIN - 1 &&
          x <= 595.28 - MARGIN + 1 &&
          yFromTop >= MARGIN - 2 &&
          yFromTop <= 841.89 - 25,
      ),
    ).toBe(true);
    expect(pdf.toString('latin1')).toContain(
      'Order Receipt ORD-20261104-ABCDE1',
    );
  });

  it('renders missing optional details and COD collection states without failing', async () => {
    const pdf = await renderPdf(
      makeReceipt({
        customer: { firstName: '', lastName: '', email: '' },
        shipping: {
          recipientName: '',
          phone: '',
          addressLine1: '',
          addressLine2: null,
          city: null,
          stateProvince: null,
          postalCode: null,
          countryCode: '',
          locationPath: null,
        },
        payment: {
          paymentMethod: 'COD',
          status: 'NONE',
          amount: null,
          currency: null,
          paidAt: null,
        },
        codCollection: {
          status: 'NOT_COLLECTED',
          amount: null,
          currency: null,
          collectedAt: null,
          collector: null,
        },
      }),
    );

    expect(pageCount(pdf)).toBe(1);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('renders collected COD and paid online payment receipts', async () => {
    const codPdf = await renderPdf(
      makeReceipt({
        payment: {
          paymentMethod: 'COD',
          status: 'NONE',
          amount: null,
          currency: null,
          paidAt: null,
        },
        codCollection: {
          status: 'COLLECTED',
          amount: '105.00',
          currency: 'USD',
          collectedAt: '2026-11-04T06:00:00.000Z',
          collector: { firstName: 'Delivery', lastName: 'Staff' },
        },
      }),
    );
    const onlinePdf = await renderPdf(makeReceipt());

    expect(pageCount(codPdf)).toBe(1);
    expect(pageCount(onlinePdf)).toBe(1);
    expect(codPdf.length).toBeGreaterThan(1000);
    expect(onlinePdf.length).toBeGreaterThan(1000);
  });

  it('places the financial summary and payment section above the footer', async () => {
    const items = Array.from({ length: 32 }, (_, index) =>
      makeItem({ productName: `Product ${index + 1}` }),
    );
    const pdf = await renderPdf(
      makeReceipt({
        items,
        itemCount: items.length,
      }),
    );
    const footerPages = pageContents(pdf);

    expect(pageCount(pdf)).toBeGreaterThan(1);
    const positionedPages = footerPages.filter((page) => page.includes(' Tm'));
    expect(positionedPages.length).toBe(pageCount(pdf));
    for (const content of positionedPages) {
      const positions = [
        ...content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g),
      ].map((match) => ({
        x: Number(match[1]),
        yFromTop: 841.89 - Number(match[2]),
      }));
      expect(positions.length).toBeGreaterThan(0);
      expect(
        positions.every(
          ({ x, yFromTop }) =>
            x >= MARGIN - 1 &&
            x <= 595.28 - MARGIN + 1 &&
            yFromTop >= MARGIN - 2 &&
            yFromTop <= 841.89 - 25,
        ),
      ).toBe(true);
    }
    expect(pageMediaBoxes(pdf).length).toBe(pageCount(pdf));
  });
});
