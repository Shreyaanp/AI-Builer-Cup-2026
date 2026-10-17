# The two-minute tour

All shops, people, sales, reviews and documents below are **Demo** data. The tour never
establishes a real business, identity check, payment, Google listing or live supplier connection.
Menu images are bundled artwork labelled “DEMO MENU”, not photographs of real shops.

Start local dev with `WEB_PORT=3867`, `API_PORT=3967`, `RECALL_PATH=data/test-vectors`.
`npm run dev:backend` seeds both worlds before serving; run `npm run dev` in a separate
foreground terminal. The owner chooses **Take the tour**, then **Keep exploring**. Both private
owner shops appear in the existing shop chooser: Lantern Chai Corner and Sunny Side Kopitiam.
The phone timezone chooses the first shop. Neither private tour copy is published.

Use the following screen order and narration for the judge walk and video. Start with Bengaluru;
use Singapore for the final locality comparison. Prepare the signed-in customer with **Profile
and preferences → Load demo story**, then close the profile before recording.

| Time      | Screen and action                                                     | Narration / evidence on screen                                                                                                                                                                                                                                         |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Owner → Coach / Today                                                 | “A small shop starts with what needs attention.” Yesterday’s sales, page views, stamps and regulars; a waiting question and low chai stock.                                                                                                                            |
| 0:15–0:30 | Ask “Forecast my sales”; open Grow → Close the day                    | “Eight weeks of daily closes become a preparation plan.” Seven-day chart from saved sales. Offline runs say weekday average, never TimesFM. Review a new close without saving over the sample history.                                                                 |
| 0:30–0:50 | Grow → Purchase orders → the tea-leaf order                           | “Forecast demand meets supplier rules.” Show quantity, MOQ, tier price and seven-day terms; expand PO → confirmation → dispatch → matched invoice. The simulation is awaiting receipt, so the owner can finish the cycle.                                              |
| 0:50–1:00 | Grow → Payments & rides; You → shop playbook                          | “The shop keeps its own priorities.” A less-waste playbook and an INR payment-link preview. The sample UPI address has an invalid provider: never pay it.                                                                                                              |
| 1:00–1:15 | Customer → Ask; choose Indiranagar, Bengaluru; ask for chai, then map | “A neighbour finds what is nearby.” Eight different shops, local prices and short reasons to visit; map pins stay approximate and labelled Demo.                                                                                                                       |
| 1:15–1:35 | Open Lantern Chai Corner → menu, badge and reviews; Rescue tab        | “The same details answer the customer.” ₹20 chai, UPI, Hindi/English, menu artwork, a visibly simulated verification badge, shop-specific reviews and a 30% sample deal on Rescue. Pickup is during listed hours.                                                      |
| 1:35–1:50 | Chats → Lantern Chai Corner; Passport                                 | “A question becomes a conversation, then a reason to return.” Read the owner’s sample pickup reply; show five earned stamps plus two welcome stamps, a scratch card and two collected demo rescues. Saved kg is an **estimated CO₂** figure, not measured food weight. |
| 1:50–2:00 | Choose Katong, Singapore; open Sunny Side Kopitiam                    | “Same story, local context.” Five shops, S$1.70 kopi, PayNow and English/Mandarin/Malay/Tamil. End on the customer’s next reward.                                                                                                                                      |

The longer eight-spotlight introduction remains available; the table is the shorter recorded walk.
Do not describe offline fixtures as live AI. PayNow is a listed payment method; the existing
payment-link feature supports INR/UPI only. No payment status is invented.

## Repeatable preparation

From `backend/`, with no model configuration or secrets needed:

```powershell
uv run --offline --locked python -m scripts.seed_tour_story --sqlite data/merchant.sqlite3
uv run --offline --locked python -m scripts.seed_tour_story --sqlite data/merchant.sqlite3 --date 2026-10-17 --reset
```

Normal reruns preserve stock switches, replies, holds, scratches and order progress. Missing sales
days and daily pulse/rescue samples roll forward, including private owner copies, without replacing
completed days or owner-selected photos. `--date` pins a recording date; use the current
shop-local date for live browsing so the sample rescue is current. Reset restores the dedicated
public fixtures; add `--owner-uid DEMO_OWNER_UID --customer-uid DEMO_CUSTOMER_UID` to restore those
accounts’ private copies and sample passport too. Other shops and real passport activity are
protected. For private owner copies, reset keeps earlier sales days outside the seeded
eight-week window.
After a public-world reset, load the customer story again to repair its sample chat links;
existing passport rewards and unfollows stay as they were.

Production preparation is **owner-run only**: explicitly pass `--project ichiropractic`, the app’s
namespace/database and the two designated demo account UIDs instead of `--sqlite`. There is no
deployment/startup hook. Production tour requests only open accounts already prepared by that
script; they never bulk-seed the worlds. Do not use an ordinary merchant/customer account.
No production command was run for this change.

The seed has no model, Maps, ASR, TTS, billing, IAM or payment calls. It uses the same repository
records as the app: daily closes, inquiries, playbook, daily pulse, rescue deals, supplier rules,
linked documents, customer thread ownership and passport. Scripted account capabilities remain
private and randomly generated; fixture IDs, dates, menus and outcomes are deterministic.
