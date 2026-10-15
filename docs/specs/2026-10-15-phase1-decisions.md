# Phase 1 decisions (15 Oct 2026)

Answers to the spec's open questions (§15) and the changes agreed before the build. The spec itself is in [restaurant-saas-dev-spec.md](restaurant-saas-dev-spec.md).

## Product decisions

| Question | Decision |
| --- | --- |
| Scope of the first build | All of Phase 1 (epics 1 to 9) |
| Do guests at one table share a cart? | Yes: one shared cart per table visit, synced live to every phone |
| Auto-accept or manager approval by default? | Manager approval. Auto-accept is a per-outlet setting; with it on, the first order from each new phone can still require approval |
| First pilot | A hotel restaurant (to connect to StayOS later). Bill-to-room is deferred; record it as payment method "Other" with the room number |
| External dependency for payments (Phase 4)? | Not decided. Phase 1 confirms payments manually through a `PaymentAdapter` interface that a gateway can implement later |
| Which Petpooja features at launch? | Not decided. Phase 1 covers the spec's order-to-bill core |

## Changes to the spec

| Spec | Built | Why |
| --- | --- | --- |
| Browser push notifications (PWA) | In-app sound and alerts while the portal is open | Web Push is delivered through Google, Apple or Mozilla servers, a third-party service in the product path |
| Service charge | Off by default and removable on every bill | Indian consumer guidelines bar adding it automatically |
| Redis + BullMQ for queues | Postgres outbox for events and print jobs; Redis only for socket fan-out | Events and jobs commit with the data that caused them, so nothing is lost on a crash, and there is one fewer moving part |
| JWT staff auth (implied) | Opaque session tokens stored hashed in the database | Disabling a staff member signs them out immediately |
| Channel `...:table:{id}` for guests | `...:session:{id}` | The next party at the same table must not receive the previous party's cart or orders |
| Guest join rate limit | 120 per minute per IP (configurable) | Guests on a restaurant's Wi-Fi share one public IP |
| Foreign keys | Every reference between tenant tables also matches `tenant_id` | Postgres checks foreign keys without row-level security |

## To confirm before the pilot

- GST rate for the pilot hotel's restaurant (depends on room tariffs) and the invoice layout: check with an accountant.
- Thermal printer models at the pilot outlet: test the print agent with them.
