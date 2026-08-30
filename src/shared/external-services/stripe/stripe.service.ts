import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * Minimal wrapper around the Stripe SDK, in test mode. Just enough surface
 * for the saga to call - it doesn't know anything about purchases or seats.
 */
@Injectable()
export class StripeService {
  private readonly stripe: Stripe;

  constructor(configService: ConfigService) {
    this.stripe = new Stripe(configService.getOrThrow<string>('STRIPE_SECRET_KEY'), {
      apiVersion: '2024-06-20',
    });
  }

  async createAndConfirmPaymentIntent(amount: number, idempotencyKey: string): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: 'usd',
        confirm: true,
        payment_method: 'pm_card_visa',
        payment_method_types: ['card'],
      },
      { idempotencyKey },
    );
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }

  async refund(paymentIntentId: string, idempotencyKey: string): Promise<Stripe.Refund> {
    return this.stripe.refunds.create({ payment_intent: paymentIntentId }, { idempotencyKey });
  }
}
