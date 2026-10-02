import type {
  PdfPageCountRejectedReason,
  PdfPageCountResult,
  PdfPageCountUnsupportedReason,
} from './main';

type PdfPageCountFailure = Exclude<PdfPageCountResult, { status: 'ok' }>;

/** Carries a failure result out of the recursive reader */
export class PdfPageCountError extends Error {
  readonly result: PdfPageCountFailure;

  constructor(result: PdfPageCountFailure) {
    super(result.detail);
    this.result = result;
  }
}

export function unsupported(
  reason: PdfPageCountUnsupportedReason,
  detail: string,
): never {
  throw new PdfPageCountError({ status: 'unsupported', reason, detail });
}

export function rejected(
  reason: PdfPageCountRejectedReason,
  detail: string,
): never {
  throw new PdfPageCountError({ status: 'rejected', reason, detail });
}
