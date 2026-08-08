import type {
  ChannelCreatePaymentInput,
  ChannelCreatePaymentResult,
  PaymentChannel,
} from "./payment-channel.ts";

export class SandboxChannel implements PaymentChannel {
  readonly name = "sandbox";

  async createPayment(
    input: ChannelCreatePaymentInput,
  ): Promise<ChannelCreatePaymentResult> {
    return {
      externalId: `sbx_${input.orderId}`,
      checkoutUrl: `netnavr://pay/sandbox/checkout/${input.orderId}`,
    };
  }
}
