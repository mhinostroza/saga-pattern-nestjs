# Saga Pattern in NestJS — concert ticket purchase

Educational example of an **orchestrated saga** for buying a concert
ticket: reserve seat → charge in Stripe → confirm sale → notify. If
something fails midway, the orchestrator itself undoes what already
happened.

The heart of the project is
[`src/purchases/services/purchase-saga.service.ts`](src/purchases/services/purchase-saga.service.ts):
that's where all the step logic and its compensation live. Everything
else (controller, `PurchasesService`, `StripeService`, `PrismaService`,
the BullMQ processor) is minimal support so that service can run.

## Running the project

1. Copy the environment variables:

   ```bash
   cp .env.example .env
   ```

2. Start Postgres and Redis:

   ```bash
   docker compose up -d
   ```

3. Install dependencies, generate the Prisma client, and run the initial
   migration:

   ```bash
   pnpm install
   pnpm exec prisma migrate dev --name init
   ```

4. Run the app (HTTP + BullMQ worker in the same process, for
   simplicity):

   ```bash
   pnpm run start:dev
   ```

## Trying the flow

Create a test seat directly in the database (there's no endpoint for
this, it's out of scope for the example):

```sql
insert into "Seat" (id, "eventId", "seatNumber", status, "updatedAt")
values ('11111111-1111-1111-1111-111111111111', 'concert-1', 'A1', 'AVAILABLE', now());
```

Trigger the purchase:

```bash
curl -X POST http://localhost:3000/purchases \
  -H "Content-Type: application/json" \
  -d '{"seatId":"11111111-1111-1111-1111-111111111111","buyerId":"buyer-1","amount":49.90}'
```

Poll for status (no websockets, on purpose):

```bash
curl http://localhost:3000/purchases/<id>
```

`status` will go through `PENDING → CHARGED → CONFIRMED`. If the charge
or confirmation fails, you'll see `COMPENSATING → FAILED` and the seat
will go back to `AVAILABLE`.

## What this project does NOT do (on purpose)

No aggregates, domain events, repository pattern, value objects, use
cases / clean architecture, or websockets. This is an example focused on
the saga pattern, not on architecture.

## Pending

Tests — to be added after the flow is validated manually.
