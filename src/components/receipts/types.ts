/** Types the receipt screens share with the server actions. Nothing here imports server code. */

export interface ActionFailure {
  code: string;
  message: string;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionFailure };

/** A member who can be credited, as the Paid by menu lists them. */
export interface PayerOption {
  userId: string;
  name: string;
}
