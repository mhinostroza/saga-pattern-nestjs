# Saga Pattern en NestJS — compra de entradas

Ejemplo educativo de un **saga orquestado** para comprar una entrada de
concierto: reservar asiento → cobrar en Stripe → confirmar venta →
notificar. Si algo falla a mitad de camino, el propio orquestador deshace
lo que ya se hizo.

El corazón del proyecto es
[`src/purchases/services/purchase-saga.service.ts`](src/purchases/services/purchase-saga.service.ts):
ahí vive toda la lógica de cada step y su compensación. El resto de los
archivos (controller, `PurchasesService`, `StripeService`, `PrismaService`,
el processor de BullMQ) son soporte mínimo para que ese service pueda
correr.

## Levantar el proyecto

1. Copiar variables de entorno:

   ```bash
   cp .env.example .env
   ```

2. Levantar Postgres y Redis:

   ```bash
   docker compose up -d
   ```

3. Instalar dependencias, generar el cliente de Prisma y correr la
   migración inicial:

   ```bash
   npm install
   npx prisma migrate dev --name init
   ```

4. Correr la app (HTTP + worker de BullMQ en el mismo proceso, por
   simplicidad):

   ```bash
   npm run start:dev
   ```

## Probar el flujo

Crear un seat de prueba directo en la base (no hay endpoint para esto,
está fuera del alcance del ejemplo):

```sql
insert into "Seat" (id, "eventId", "seatNumber", status, "updatedAt")
values ('11111111-1111-1111-1111-111111111111', 'concert-1', 'A1', 'AVAILABLE', now());
```

Disparar la compra:

```bash
curl -X POST http://localhost:3000/purchases \
  -H "Content-Type: application/json" \
  -d '{"seatId":"11111111-1111-1111-1111-111111111111","buyerId":"buyer-1","amount":49.90}'
```

Hacer polling del estado (no hay websockets, a propósito):

```bash
curl http://localhost:3000/purchases/<id>
```

`status` va a pasar por `PENDING → CHARGED → CONFIRMED`. Si el cobro o la
confirmación fallan, vas a ver `COMPENSATING → FAILED` y el asiento vuelve
a quedar `AVAILABLE`.

## Qué NO hace este proyecto (a propósito)

Sin aggregates, domain events, repository pattern, value objects, use
cases / clean architecture ni websockets. Es un ejemplo enfocado en el
patrón saga, no en arquitectura.

## Pendiente

Tests — se agregan después de validar el flujo manualmente.
