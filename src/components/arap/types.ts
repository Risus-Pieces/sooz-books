/**
 * The shapes that cross the server/client boundary in Sales and Purchases.
 *
 * Plain serialisable data only: a page reads the database through its
 * `queries.ts`, projects rows into these, and hands them to client components;
 * a Server Action takes a form shape back. Money is integer cents throughout,
 * dates are 'YYYY-MM-DD' strings.
 */

import type { CustomerType, DocStatus, PaymentMethod, VendorType } from '@/db/schema';

export type { ActionFailure, ActionResult } from '@/components/ledger/types';
export type { CustomerType, DocStatus, PaymentMethod, VendorType };

export const CUSTOMER_TYPES: readonly CustomerType[] = [
  'wholesale',
  'foodservice',
  'distributor',
  'dtc',
  'marketplace',
  'other',
];

export const CUSTOMER_TYPE_LABELS: Readonly<Record<CustomerType, string>> = {
  wholesale: 'Wholesale / retail store',
  foodservice: 'Restaurant / foodservice',
  distributor: 'Distributor',
  dtc: 'Direct to consumer',
  marketplace: 'Marketplace',
  other: 'Other',
};

export const VENDOR_TYPES: readonly VendorType[] = [
  'ingredients',
  'packaging',
  'co_manufacturer',
  'freight',
  'warehouse_3pl',
  'broker',
  'marketing',
  'professional',
  'software',
  'other',
];

export const VENDOR_TYPE_LABELS: Readonly<Record<VendorType, string>> = {
  ingredients: 'Ingredients',
  packaging: 'Packaging',
  co_manufacturer: 'Co-manufacturer',
  freight: 'Freight',
  warehouse_3pl: 'Warehouse / 3PL',
  broker: 'Broker',
  marketing: 'Marketing',
  professional: 'Professional services',
  software: 'Software',
  other: 'Other',
};

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'ach',
  'check',
  'wire',
  'card',
  'cash',
  'bill_pay',
  'marketplace',
  'other',
];

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  ach: 'ACH',
  check: 'Check',
  wire: 'Wire',
  card: 'Card',
  cash: 'Cash',
  bill_pay: 'Bill pay',
  marketplace: 'Marketplace',
  other: 'Other',
};

/** A pick-list entry: channels, deposit and payment accounts, products. */
export interface Option {
  id: string;
  label: string;
  /** A second, quieter line: an account code, a SKU. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export interface CustomerRow {
  id: string;
  name: string;
  displayName: string | null;
  customerType: CustomerType;
  channelId: string | null;
  channelName: string | null;
  email: string | null;
  phone: string | null;
  termsDays: number;
  /** numeric(5,2) as text, e.g. "2.00". */
  termsDiscountPct: string;
  termsDiscountDays: number;
  creditLimitCents: number | null;
  notes: string | null;
  active: boolean;
  openCents: number;
  overdueCents: number;
  openInvoiceCount: number;
}

export interface CustomerForm {
  name: string;
  displayName: string;
  customerType: CustomerType;
  channelId: string | null;
  email: string;
  phone: string;
  termsDays: number;
  termsDiscountPct: string;
  termsDiscountDays: number;
  creditLimitCents: number | null;
  notes: string;
  active: boolean;
}

export interface VendorRow {
  id: string;
  name: string;
  displayName: string | null;
  vendorType: VendorType;
  email: string | null;
  phone: string | null;
  termsDays: number;
  defaultExpenseAccountId: string | null;
  defaultAccountLabel: string | null;
  is1099: boolean;
  w9OnFile: boolean;
  w9ReceivedAt: string | null;
  taxIdLast4: string | null;
  legalName: string | null;
  notes: string | null;
  active: boolean;
  openCents: number;
  openBillCount: number;
  /** Aliases the bank matcher recognises this vendor by. */
  aliasCount: number;
}

export interface VendorForm {
  name: string;
  displayName: string;
  vendorType: VendorType;
  email: string;
  phone: string;
  termsDays: number;
  defaultExpenseAccountId: string | null;
  is1099: boolean;
  w9OnFile: boolean;
  w9ReceivedAt: string | null;
  taxIdLast4: string;
  legalName: string;
  notes: string;
  active: boolean;
}

/** A party as the document forms pick one: enough to default terms and accounts. */
export interface CustomerPick {
  id: string;
  name: string;
  termsDays: number;
  termsDiscountPct: string;
  termsDiscountDays: number;
  channelId: string | null;
  /** The revenue account a line defaults to, from the customer's channel. Null: the line must name one. */
  defaultRevenueAccountId: string | null;
}

export interface VendorPick {
  id: string;
  name: string;
  termsDays: number;
  defaultExpenseAccountId: string | null;
  is1099: boolean;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface InvoiceListRow {
  id: string;
  invoiceNo: string;
  customerId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  poNumber: string | null;
  status: DocStatus;
  totalCents: number;
  balanceCents: number;
  /** Positive once past due and still open. */
  daysOverdue: number;
}

export interface BillListRow {
  id: string;
  billNo: string;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  status: DocStatus;
  totalCents: number;
  balanceCents: number;
  inventoryCents: number;
  daysOverdue: number;
}

export interface InvoiceLineView {
  lineNo: number;
  description: string;
  productId: string | null;
  productLabel: string | null;
  quantity: string;
  unitPriceCents: number;
  amountCents: number;
  discountCents: number;
  taxCents: number;
  revenueAccountId: string | null;
  revenueAccountLabel: string | null;
}

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface SettlementView {
  kind: 'receipt' | 'credit_memo' | 'deduction' | 'bill_payment' | 'vendor_credit';
  id: string;
  docNo: string;
  date: string;
  amountCents: number;
  discountCents: number;
  void: boolean;
}

export interface InvoiceDetail {
  id: string;
  invoiceNo: string;
  status: DocStatus;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  billingAddress: Address | null;
  shippingAddress: Address | null;
  channelName: string | null;
  invoiceDate: string;
  dueDate: string;
  termsDays: number;
  termsDiscountPct: string;
  termsDiscountDays: number;
  poNumber: string | null;
  memo: string | null;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  deductedCents: number;
  balanceCents: number;
  journalEntryId: string | null;
  journalEntryNo: number | null;
  voidEntryId: string | null;
  lines: InvoiceLineView[];
  settlements: SettlementView[];
}

export interface BillLineView {
  lineNo: number;
  description: string;
  accountId: string;
  accountLabel: string;
  quantity: string | null;
  unitCostCents: number | null;
  amountCents: number;
  isInventory: boolean;
}

export interface BillDetail {
  id: string;
  billNo: string;
  status: DocStatus;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  termsDays: number;
  poNumber: string | null;
  memo: string | null;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  balanceCents: number;
  inventoryCents: number;
  journalEntryId: string | null;
  journalEntryNo: number | null;
  source: string;
  lines: BillLineView[];
  settlements: SettlementView[];
}

/** An invoice or bill that money can still be applied to. */
export interface OpenDoc {
  id: string;
  docNo: string;
  date: string;
  dueDate: string;
  totalCents: number;
  balanceCents: number;
  /** Invoices only: settled already, so a discount is computed on the total. */
  paidCents: number;
}

export interface ReceiptListRow {
  id: string;
  receiptNo: string;
  customerId: string | null;
  customerName: string | null;
  receiptDate: string;
  method: PaymentMethod;
  reference: string | null;
  amountCents: number;
  appliedCents: number;
  depositAccountLabel: string;
  void: boolean;
  fromBank: boolean;
}

export interface PaymentListRow {
  id: string;
  paymentNo: string;
  vendorId: string;
  vendorName: string;
  paymentDate: string;
  method: PaymentMethod;
  reference: string | null;
  amountCents: number;
  appliedCents: number;
  accountLabel: string;
  is1099Reportable: boolean;
  void: boolean;
  fromBank: boolean;
}

export interface MoneyDocApplication {
  docId: string;
  docNo: string;
  docDate: string;
  appliedOn: string;
  amountCents: number;
  discountCents: number;
}

/** A receipt or a bill payment with what it paid. */
export interface MoneyDocDetail {
  id: string;
  docNo: string;
  partyId: string | null;
  partyName: string | null;
  date: string;
  method: PaymentMethod;
  reference: string | null;
  memo: string | null;
  amountCents: number;
  appliedCents: number;
  accountLabel: string;
  journalEntryId: string | null;
  journalEntryNo: number | null;
  void: boolean;
  voidDate: string | null;
  bankTransactionId: string | null;
  is1099Reportable: boolean | null;
  applications: MoneyDocApplication[];
}

// ---------------------------------------------------------------------------
// Form payloads
// ---------------------------------------------------------------------------

export interface InvoiceLineForm {
  description: string;
  productId: string | null;
  quantity: string;
  unitPriceCents: number;
  discountCents: number;
  taxCents: number;
  revenueAccountId: string | null;
}

export interface InvoiceForm {
  customerId: string;
  invoiceDate: string;
  dueDate: string | null;
  poNumber: string;
  memo: string;
  discountCents: number;
  shippingCents: number;
  lines: InvoiceLineForm[];
}

export interface BillLineForm {
  description: string;
  accountId: string | null;
  quantity: string;
  unitCostCents: number | null;
  amountCents: number;
  isInventory: boolean;
}

export interface BillForm {
  vendorId: string;
  billNo: string;
  billDate: string;
  dueDate: string | null;
  poNumber: string;
  memo: string;
  lines: BillLineForm[];
}

export interface ApplicationForm {
  docId: string;
  amountCents: number;
  discountCents: number;
}

export interface ReceiptForm {
  customerId: string;
  receiptDate: string;
  amountCents: number;
  method: PaymentMethod;
  reference: string;
  memo: string;
  depositAccountId: string | null;
  applications: ApplicationForm[];
}

export interface PaymentForm {
  vendorId: string;
  paymentDate: string;
  amountCents: number;
  method: PaymentMethod | null;
  reference: string;
  memo: string;
  paymentAccountId: string;
  applications: ApplicationForm[];
}

export interface DocRef {
  id: string;
  docNo: string;
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

export const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
export type Bucket = (typeof BUCKETS)[number];

export type AgingBuckets = Record<Bucket, number> & { total: number };

export interface AgingItemView {
  kind: string;
  id: string;
  docNo: string;
  docDate: string;
  dueDate: string | null;
  daysPastDue: number | null;
  bucket: Bucket;
  balanceCents: number;
}

export interface AgingPartyView {
  partyId: string;
  partyName: string;
  buckets: AgingBuckets;
  items: AgingItemView[];
}

