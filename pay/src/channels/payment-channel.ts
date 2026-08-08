export type ChannelCreatePaymentInput = {
  orderId: string;
  merchantOrderId: string;
  amount: number;
  currency: string;
  description: string;
};

export type ChannelCreatePaymentResult = {
  externalId: string;
  checkoutUrl: string;
};

export interface PaymentChannel {
  readonly name: string;

  createPayment(
    input: ChannelCreatePaymentInput,
  ): Promise<ChannelCreatePaymentResult>;
}
