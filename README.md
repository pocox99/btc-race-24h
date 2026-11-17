# btc-race-24h

[![make.fun bounty](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/pocox99/btc-race-24h/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A patient dip-and-hold BTC bot for the make.fun 24h bars race: it buys the first 0.2% dip under its reference close (or by bar 240 if none comes), then holds through the noise and sells only on a disaster break — 6% under cost or 3% under its 60-bar trend line.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout: it reads a hello, one batch per one-minute bar, and done, and answers each batch with its orders. `vendor/makefun-bars.ts` is the kit's SDK shim, copied byte for byte.

---

Built for make.fun — https://make.fun/r/g8jk5pvk
