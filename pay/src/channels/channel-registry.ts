import { AppError } from "../core/errors.ts";
import type { PaymentChannel } from "./payment-channel.ts";

export class ChannelRegistry {
  readonly #channels = new Map<string, PaymentChannel>();

  constructor(channels: PaymentChannel[]) {
    for (const channel of channels) {
      this.#channels.set(channel.name, channel);
    }
  }

  get(name: string): PaymentChannel {
    const channel = this.#channels.get(name);
    if (!channel) {
      throw new AppError(
        "UNSUPPORTED_CHANNEL",
        `Payment channel '${name}' is not configured`,
        422,
      );
    }
    return channel;
  }
}
