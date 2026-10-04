import { PaymentService } from "./payment-service.ts";
import type { PaymentResponse } from "./payment-response.ts";
export class PaymentController {
  constructor(private service: PaymentService) {}
  process(paymentId: string): PaymentResponse { return this.service.execute(paymentId); }
}
