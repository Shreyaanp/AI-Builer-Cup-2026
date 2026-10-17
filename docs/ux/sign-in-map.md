# Customer sign-in map

Baseline: `origin/release/stable-2-main` (release 2). Task: `task-GUEST-CUSTOMER.md`.
This table records the existing gates and the intended change before implementation.

| Place                                            | Before                                              | After with GUEST_CUSTOMER                                                |
| ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Ask, discovery, public shop, updates             | Public                                              | Public                                                                   |
| ShopChat, Chats list/thread/live replies         | Google required; community routes require customer  | Quiet guest identity; owned threads and replies                          |
| Legacy inquiry/capability creation               | Google required; caller supplies reply contact      | Google required; stable customer identity also enforces shop blocks      |
| FollowButton, Saved                              | Device follows; Google for server follows           | Guest server follows, retained on upgrade                                |
| Profile / You preferences and history            | Google required                                     | Guest private profile; explain device identity and data loss on clearing |
| Tips and helpful votes                           | Google required                                     | Keep Google for publishing tips; allow guest helpful votes               |
| QR stamps / StampMoment / ShopStamp              | Device receipts; client submits earlier receipts    | Guest server passport; atomic shop-local daily cap                       |
| Passport                                         | Device preview; Google for server passport          | Guest server passport                                                    |
| Scratch / streak freeze                          | Google required                                     | Guest allowed                                                            |
| Reward card claim, won perk use, co-op reward    | Google required                                     | Google required at claim time; preserve earned activity                  |
| Rescue HoldSheet / reserve endpoint              | Google required                                     | Google required at reservation time                                      |
| Regulars this week / leaderboard read and opt-in | Google required                                     | Google required; guest activity never published                          |
| Owner inbox block                                | Owner-only block; contact hash prevents new threads | Block stable guest identity too; owner unblock action                    |
| Owner coach, shop authority, voice               | Separate owner identity                             | Google-only owner identity stays separate                                |

Implementation and verification evidence will be recorded separately in
`docs/ux/guest-customer-validation.md`. The switch defaults off until the complete release gate is green.
