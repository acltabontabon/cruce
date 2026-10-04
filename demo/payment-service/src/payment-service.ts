export interface RetryPolicy { attempts: number }
export class PaymentService {
  execute(paymentId: string): { paymentId: string; accepted: boolean } {
    return { paymentId, accepted: true };
  }
}
