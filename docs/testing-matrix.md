# Device/browser testing matrix

Not yet run against real hardware — this is the checklist for Milestone 7.
Fill in Result/Notes as each row is actually exercised on the CBC Africa
office LAN (Abule-Oja, Lagos), not just localhost.

| Device | Browser | Coordinator role tested | Send | Receive | Resume after wifi drop | Notes |
|---|---|---|---|---|---|---|
| Windows laptop | Edge | yes | | | | |
| Windows laptop | Chrome | yes | | | | |
| Windows laptop | Firefox | yes | | | | |
| Windows laptop | packaged .exe (Tauri) | yes | | | | |
| iPhone | Safari | no (phone) | | | | IndexedDB disk-write path — most likely to surface quirks |
| Android | Chrome | no (phone) | | | | |
| Android | Firefox | no (phone) | | | | |

Also to verify per Milestone 6/7:
- [ ] Coordinator failover: kill the coordinator laptop mid-session, confirm
      re-election within the documented window (`docs/election.md` §3) and
      that peers reconnect without user action.
- [ ] Pairing PIN flow end to end between two devices that have never
      paired before.
- [ ] Large file (multi-GB) transfer without memory growth on either side —
      confirm chunks are actually streamed to disk, not buffered.
- [ ] Transfer resume after killing wifi mid-transfer and reconnecting.
- [ ] mkcert-issued local HTTPS trusted on iOS Safari (profile install
      step) and Android Chrome.
