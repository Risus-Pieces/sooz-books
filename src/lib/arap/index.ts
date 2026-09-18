/**
 * The AR and AP engines. Server Actions call these after their capability
 * check; every function takes `{ userId, tx? }` and runs in one transaction.
 */

export { type Aging, type AgingBucket, type AgingItem, type AgingParty, agingReport, apAging, arAging, controlBalance } from './aging';
export { applyVendorPrepayment, isCardPayment, payBills, voidBillPayment } from './bill-payments';
export { type NewBillInput, type BillLineInput, approveBill, createAndApproveBill, createBill, getBill, prepareBill, voidBill } from './bills';
export { businessDaysBetween, isBusinessDay } from './business-days';
export type { ArapContext } from './common';
export { applyCreditMemo, issueCreditMemo, voidCreditMemo } from './credit-memos';
export { ArapError, type ArapErrorCode, isArapError } from './errors';
export { type Form1099Report, type Form1099Row, form1099NecThresholdCents, form1099Report } from './form-1099';
export {
  type InvoiceLineInput,
  type NewInvoiceInput,
  createAndIssueInvoice,
  createInvoice,
  getInvoice,
  invoiceBalance,
  issueInvoice,
  prepareInvoice,
  voidInvoice,
} from './invoices';
export { type CustomerPatch, type VendorPatch, updateCustomer, updateDraftBill, updateDraftInvoice, updateVendor } from './edits';
export {
  type AppliedMatch,
  type MatchCandidate,
  type MatchCandidates,
  MATCH_WINDOW_BUSINESS_DAYS,
  applyMatch,
  matchCandidates,
} from './matching';
export { type NewCustomerInput, type NewVendorInput, createCustomer, createVendor, updateVendorTaxProfile } from './parties';
export { allowedDiscountCents, applyReceiptCredit, recordReceipt, voidReceipt } from './receipts';
export { applyVendorCredit, issueVendorCredit, voidVendorCredit } from './vendor-credits';
