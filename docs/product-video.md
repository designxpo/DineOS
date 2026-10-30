# Mezvaan product video: recording playbook

Use the dedicated **aurum-video** restaurant in the local product. All names, trade and bookings are fictional. This seed uses the real order and billing services, so actions in the recording behave like normal product actions.

## Prepare the demo

Open http://localhost:3000/login after starting the API and web app (`npm run dev`). Restaurant code: **aurum-video**. Owner: **owner@courtyard.demo**, password: **demo1234**. The kitchen login is **imran@courtyard.demo** with the same password; use a separate browser profile if you want to show its restricted view.

Create the recording dataset with `npm run demo:video`. Running it again leaves existing data alone. For another take, `npm run demo:video -- --reset` deletes and rebuilds **only the aurum-video tenant**, including all rehearsal orders and changed guest links. Reopen the guest menu after resetting. The normal aurum-courtyard demo remains separate. Seed just before recording so bookings and order clocks are fresh.

The dataset includes 27 dishes with photos, 22 tables in three zones, an owner and five staff, fourteen days of settled trade, today's settled bills, ten ingredients with recipes, three loyalty customers, four reservations and a waitlist party. Historical UPI entries are fictional records; the video tenant has no UPI payee address. Use Cash for the recorded settlement.

| Table    | Starting scene                                                           |
| -------- | ------------------------------------------------------------------------ |
| C1       | Free: use for the new guest order and complete its journey               |
| C3       | Preparing: Paneer Tikka and Fresh Lime Soda                              |
| P2       | Ready: Dal Makhani and Virgin Mojito                                     |
| C7       | Served: Hara Bhara Kebab and two large Cold Coffees; backup billing shot |
| P1       | Accepted: Veg Dum Biryani and Virgin Mojito                              |
| C9       | Guest order awaiting approval; anniversary note                          |
| C4 / PD1 | Upcoming bookings                                                        |

## Capture setup

- Record at 1920 × 1080, 30 fps, with browser zoom at 100%. Hide bookmarks, notifications and unrelated tabs. Keep credentials out of the footage.
- Sign in and dismiss onboarding before the first take. Pre-open Dashboard, Floor, Orders, Kitchen, Reports, Reservations and Inventory in tabs.
- In Floor, select **C1 → Guest menu**. Open this in a phone-sized window or a phone browser. For a physical phone, configure the API and guest URL to the laptop's LAN address first; localhost on a phone points to the phone itself.
- Record clips separately, holding still for two seconds before and after each action. Add narration afterward. Use deliberate single clicks and one slow scroll per shot.
- Keep a small “Demo data” caption on screen. Do not film real customer details or represent simulated payments as bank verification.

## Frame-by-frame shot list — 2 minutes 30 seconds

Times below are the final edit timeline. Capture longer raw clips and trim pauses. Follow C1 from ordering to payment so the story stays consistent.

| Shot / time    | Screen and exact action                                                                                                              | Hold / framing                                                          | Voiceover or caption                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1 · 0:00–0:06  | Dashboard `/app`; show the populated overview.                                                                                       | Full screen; gentle crop toward the main totals.                        | “Meet Mezvaan. From the first order to the final bill.”                  |
| 2 · 0:06–0:16  | Floor `/app/floor`; show the courtyard, poolside and private dining tables.                                                          | Pause over the different table states.                                  | “See what is happening across your restaurant at a glance.”               |
| 3 · 0:16–0:25  | Select C1 and choose Guest menu. Cut to the phone-sized menu.                                                                        | Keep the restaurant name and food photos visible.                       | “Guests open the table menu on their phone. No app download.”             |
| 4 · 0:25–0:40  | Add one Paneer Tikka, select Medium spice, then add one Fresh Lime Soda. Open the cart.                                              | Close crop on the modifier selection, then the cart.                    | “Choose dishes, customise the order, and send it straight to the team.”   |
| 5 · 0:40–0:47  | Submit the guest order.                                                                                                              | Hold on the order confirmation.                                         | “The order is sent from the table.”                                       |
| 6 · 0:47–0:59  | Orders `/app/inbox`; find C1 and accept its order. Leave C9 as background activity.                                                  | Show the table label and items before accepting.                        | “Staff review and accept the order in one place.”                         |
| 7 · 0:59–1:13  | Kitchen `/app/kds`; show C1 in the relevant station views. Mark its food and drink ready; repeat for each station if filtered.       | Show the existing tickets, then C1's ready action.                      | “Kitchen and drinks teams see the items they need to prepare.”            |
| 8 · 1:13–1:24  | Return to Orders or Floor → C1; serve the ready items using the order controls.                                                      | Pause on the updated state.                                             | “The team knows when dishes are ready, and records when they are served.” |
| 9 · 1:24–1:41  | Floor → C1 → bill action. Review the draft and finalise it; close the print dialog if one appears.                                   | Crop to line items and tax totals.                                      | “Turn the table's order into an itemised bill.”                           |
| 10 · 1:41–1:51 | In the bill payment panel, select Cash, enter the amount due as received and record payment.                                         | Hold on Paid.                                                           | “Record payment and complete the visit.”                                  |
| 11 · 1:51–2:04 | Reports `/app/reports`; select a range covering the last fourteen days.                                                              | Show sales trends and a category breakdown; avoid a rapid tour of tabs. | “Owners can review sales and understand what is selling.”                 |
| 12 · 2:04–2:14 | Reservations `/app/reservations`; show bookings and the Kapoor waitlist entry. Select the relevant date if a booking falls tomorrow. | Hold on the booking list, then waitlist.                                | “Keep reservations and waiting guests organised.”                         |
| 13 · 2:14–2:24 | Inventory `/app/inventory`; show stocked ingredients and open a recipe if available.                                                 | One slow scroll through stock.                                          | “Connect dishes with ingredients and keep stock visible.”                 |
| 14 · 2:24–2:30 | Return to the populated dashboard; add a simple end title in the editor.                                                             | Hold steady with the Mezvaan name.                                     | “Mezvaan. Book a demo for your restaurant.”                              |

If C1 billing takes multiple tries, record the complete order journey again after resetting. C7 is available for a separate standalone billing explainer; do not cut between different table labels as if they were the same visit. For a clean floor shot, record soon after seeding: order ages and table-cleaning states change as time passes.

## Optional additional clips

Record Customers (`/app/customers`) with Vikram Mehta's loyalty balance, Menu (`/app/menu`) with a food photo and modifiers, and Reports with room charges. These can become short feature videos. Only show an offline, printer, bank-matching or camera demonstration after setting up and exercising that feature; this seed alone does not establish those integrations.

## Final edit checklist

Check that C1 and its items remain consistent from menu through bill; payments say Paid; no toast errors or loading skeletons appear; all small text is legible at 1080p; narration fits each hold; and the closing call to action uses your real contact details. Avoid claims about exact processing times based on edited footage.
