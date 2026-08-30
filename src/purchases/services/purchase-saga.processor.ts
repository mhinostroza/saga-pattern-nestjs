import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PurchaseSagaService } from './purchase-saga.service';
import { PURCHASE_SAGA_QUEUE } from './purchases.service';

type SagaJobData = { purchaseId: string };

/**
 * Thin adapter: connects BullMQ jobs to the saga's step methods. All the
 * actual decisions live in PurchaseSagaService.
 */
@Processor(PURCHASE_SAGA_QUEUE)
export class PurchaseSagaProcessor extends WorkerHost {
  private readonly logger = new Logger(PurchaseSagaProcessor.name);

  constructor(private readonly sagaService: PurchaseSagaService) {
    super();
  }

  async process(job: Job<SagaJobData>): Promise<void> {
    switch (job.name) {
      case 'charge':
        return this.runWithCompensation(
          job,
          () => this.sagaService.executeCharge(job.data.purchaseId),
          () => this.sagaService.compensateCharge(job.data.purchaseId),
        );
      case 'confirm':
        return this.runWithCompensation(
          job,
          () => this.sagaService.executeConfirm(job.data.purchaseId),
          () => this.sagaService.compensateConfirm(job.data.purchaseId),
        );
      case 'notify':
        // Best-effort: the service swallows its own errors, nothing to compensate here.
        return this.sagaService.executeNotify(job.data.purchaseId);
      default:
        throw new Error(`Unknown purchase saga step: ${job.name}`);
    }
  }

  /**
   * A step only gets compensated once BullMQ has exhausted every retry for
   * it. A transient failure (network blip, DB hiccup) should just be
   * retried, not treated as a reason to unwind the saga.
   */
  private async runWithCompensation(
    job: Job<SagaJobData>,
    execute: () => Promise<void>,
    compensate: () => Promise<void>,
  ): Promise<void> {
    try {
      await execute();
    } catch (error) {
      const maxAttempts = job.opts.attempts ?? 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (isLastAttempt) {
        this.logger.warn(`Purchase ${job.data.purchaseId}: step "${job.name}" exhausted retries, compensating`);
        await compensate();
      }

      throw error; // let BullMQ retry, or (via failParentOnFailure) stop downstream steps
    }
  }
}
