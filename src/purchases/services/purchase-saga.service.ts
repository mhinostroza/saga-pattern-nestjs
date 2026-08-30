import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { StripeService } from '../../shared/external-services/stripe/stripe.service';

/**
 * This is where the saga actually lives.
 *
 * RESERVE (step 1) already happened synchronously in PurchasesService before
 * any of this runs - it's a single conditional UPDATE, there's nothing to
 * orchestrate there. What's left is CHARGE, CONFIRM and NOTIFY, plus the
 * compensations that undo CHARGE and CONFIRM if something downstream fails.
 *
 * One rule shapes almost everything below: never charge a card twice. That's
 * why executeCharge always checks Stripe for existing state before creating
 * anything new - a worker restart or a BullMQ retry must never result in a
 * second PaymentIntent for the same purchase.
 */
@Injectable()
export class PurchaseSagaService {
  private readonly logger = new Logger(PurchaseSagaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  // ---------------------------------------------------------------------
  // STEP 2: CHARGE
  // ---------------------------------------------------------------------

  async executeCharge(purchaseId: string): Promise<void> {
    const purchase = await this.prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });

    if (purchase.stripePaymentIntentId) {
      // We already created a PaymentIntent in a previous run of this job -
      // a worker crash, a retry after the response never arrived, etc.
      // Instead of blindly creating a new charge, ask Stripe what actually
      // happened to it. This is the non-negotiable part: we reconcile
      // against Stripe's own state before deciding anything.
      await this.reconcileExistingCharge(purchase.id, purchase.stripePaymentIntentId);
      return;
    }

    // First attempt for this purchase: create the charge. The idempotency
    // key is derived from the purchase id, so even if this call reaches
    // Stripe but we crash before saving the response below, retrying with
    // the same key returns the *same* PaymentIntent instead of billing the
    // buyer again.
    const idempotencyKey = `${purchase.id}:charge`;
    const paymentIntent = await this.stripe.createAndConfirmPaymentIntent(purchase.amount, idempotencyKey);

    // Persist the PaymentIntent id immediately, before inspecting its
    // status. This single write is what makes the reconciliation branch
    // above possible: if we crash right after this, the next attempt will
    // find stripePaymentIntentId already set and go check Stripe instead of
    // charging again.
    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    this.assertChargeSucceeded(paymentIntent.id, paymentIntent.status);
    await this.markCharged(purchase.id);
  }

  private async reconcileExistingCharge(purchaseId: string, paymentIntentId: string): Promise<void> {
    const paymentIntent = await this.stripe.retrievePaymentIntent(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      // The charge went through before we crashed or got retried. Nothing
      // to charge - just record it and let the saga move on to CONFIRM.
      await this.markCharged(purchaseId);
      return;
    }

    if (paymentIntent.status === 'processing' || paymentIntent.status === 'requires_confirmation') {
      // Stripe hasn't reached a final state yet. Throwing here lets BullMQ
      // retry the job later so we check again - we must NOT compensate on
      // an in-flight payment, since it might still succeed.
      throw new Error(`PaymentIntent ${paymentIntent.id} still in progress (${paymentIntent.status})`);
    }

    // Any other status (requires_payment_method, canceled, requires_action...)
    // means this attempt is dead and the card was never actually charged.
    // It's safe to let this fail and, once retries are exhausted, compensate.
    this.assertChargeSucceeded(paymentIntent.id, paymentIntent.status);
  }

  private assertChargeSucceeded(paymentIntentId: string, status: string): void {
    if (status !== 'succeeded') {
      throw new Error(`PaymentIntent ${paymentIntentId} did not succeed (status: ${status})`);
    }
  }

  private async markCharged(purchaseId: string): Promise<void> {
    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: 'CHARGED', currentStep: 'CHARGE' },
    });
  }

  /**
   * Undo for CHARGE failing for good (retries exhausted, or Stripe reported
   * a definitive failure). The card was never successfully charged, so
   * there's nothing to refund - releasing the seat is enough.
   */
  async compensateCharge(purchaseId: string): Promise<void> {
    const purchase = await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: 'COMPENSATING' },
    });

    await this.prisma.seat.update({
      where: { id: purchase.seatId },
      data: { status: 'AVAILABLE', reservedBy: null },
    });

    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: 'FAILED' },
    });

    this.logger.warn(`Purchase ${purchaseId}: CHARGE failed, seat released.`);
  }

  // ---------------------------------------------------------------------
  // STEP 3: CONFIRM
  // ---------------------------------------------------------------------

  async executeConfirm(purchaseId: string): Promise<void> {
    const purchase = await this.prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });

    // Guard: the seat must still be the one this saga reserved back in
    // RESERVE. If it isn't RESERVED anymore, some invariant was violated
    // (manual data edit, a bug elsewhere) - that's a hard failure to
    // compensate, not something a retry could ever fix.
    const { count } = await this.prisma.seat.updateMany({
      where: { id: purchase.seatId, status: 'RESERVED' },
      data: { status: 'SOLD' },
    });

    if (count === 0) {
      throw new Error(`Seat ${purchase.seatId} was not RESERVED, cannot confirm purchase ${purchaseId}`);
    }

    await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          purchaseId: purchase.id,
          type: 'CHARGE',
          amount: purchase.amount,
          stripeReferenceId: purchase.stripePaymentIntentId,
        },
      }),
      this.prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: 'CONFIRMED', currentStep: 'CONFIRM' },
      }),
    ]);
  }

  /**
   * Undo for CONFIRM failing. Unlike compensateCharge, the card *was*
   * already successfully charged - so this path must refund it. The refund
   * is recorded before the seat is released, so a crash in between leaves
   * the seat held (safe) instead of free for someone else to grab while the
   * refund is still unresolved.
   */
  async compensateConfirm(purchaseId: string): Promise<void> {
    const purchase = await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: 'COMPENSATING' },
    });

    if (purchase.stripePaymentIntentId) {
      const refund = await this.stripe.refund(purchase.stripePaymentIntentId, `${purchase.id}:refund`);

      await this.prisma.transaction.create({
        data: {
          purchaseId: purchase.id,
          type: 'REFUND',
          amount: purchase.amount,
          stripeReferenceId: refund.id,
        },
      });
    } else {
      // Defensive only: CONFIRM can't fail before CHARGE succeeds, so this
      // should never happen. If it somehow does, there's no charge to refund.
      this.logger.error(`Purchase ${purchaseId}: compensating CONFIRM without a PaymentIntent`);
    }

    await this.prisma.seat.update({
      where: { id: purchase.seatId },
      data: { status: 'AVAILABLE', reservedBy: null },
    });

    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: 'FAILED' },
    });

    this.logger.warn(`Purchase ${purchaseId}: CONFIRM failed, refunded and seat released.`);
  }

  // ---------------------------------------------------------------------
  // STEP 4: NOTIFY
  // ---------------------------------------------------------------------

  /**
   * Best-effort. A failed notification must never undo a completed sale, so
   * every error is caught and logged right here - nothing propagates to
   * BullMQ, which means it can never trigger a retry or a compensation.
   */
  async executeNotify(purchaseId: string): Promise<void> {
    try {
      const purchase = await this.prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
      this.logger.log(`[simulated email] Purchase ${purchase.id} confirmed for buyer ${purchase.buyerId}`);

      await this.prisma.purchase.update({
        where: { id: purchaseId },
        data: { currentStep: 'NOTIFY' },
      });
    } catch (error) {
      this.logger.error(`Purchase ${purchaseId}: NOTIFY failed (ignored, best-effort)`, error as Error);
    }
  }
}
