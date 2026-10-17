# Voice: non-blocking tools, reconnect on a bad network, direct GPS in new shop (Opus)

Branch fix/voice-nonblocking from origin/main (has #91, #95, #108, #115). Ports WEB_PORT=3971 API_PORT=4071.
Owner decisions (docs/OWNER-NOTES.md 17 Oct ~13:05): first voice audio is 1.5-2.5 s, target < 800 ms:
make the coach's tool calls NON-BLOCKING first (the model speaks/acknowledges at once while business
profile, draft save, location and photo tools run; their results must still reach the model with full
context: log it and test it). Reconnection must work even on a BAD network (flaky mobile data, app in
background, offline a few seconds): silent resume at the right step, no repeated question, no lost answer,
draft kept, no duplicate sessions (#108's resume-with-context is already on main; build on it; production
logs showed the socket closing from a phone network drop). In the CREATE NEW SHOP flow, "Get my location"
gets the device location DIRECTLY (browser prompt only, no app dialog); everywhere else keep the dialog.
Do not touch the camera/X code (#115) or the smart-questions prompt (PR #117). Measure first-audio before
and after from coach_latency logs/unit timing. Unit tests + one focused spec with throttled/offline network
(Playwright CDP network conditions). Never run commands in the background. No sub-agents. Plain commits.
Push often; PR "Voice: non-blocking tools, reconnect on a bad network, direct GPS in new shop". Do not merge.
