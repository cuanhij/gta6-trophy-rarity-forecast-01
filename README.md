# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/cuanhij/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/cuanhij/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast, for every Grand Theft Auto VI PlayStation 5 trophy (55 at the opening), its earn rate on Exophase at 2026-11-26 00:00 UTC — as five quantiles per trophy (5%, 25%, 50%, 75%, 95%).

Entry for the make.fun bounty [Forecast how many GTA VI players earn each trophy in week one](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## How it works

`main.ts` (Node 22, standard library only, no network) reads the case file in `$MAKEFUN_INPUT_DIR` (or `/input/`) and writes `/output/<id>.out` with one row per trophy. The forecast is built at runtime from the case's own history — nothing is baked in:

- Each trophy's earn rate is tracked over the case's reads. Reads Exophase left unchanged are collapsed, so a frozen stretch of the page cannot flatten the fit.
- Per trophy, the logit of the rate is fitted by least squares against `ln(1 + hours since release)` over the whole history, so early trophies that saturate fast and late trophies that grow slowly each get their own slope.
- Slopes are shrunk toward their tier's median slope (platinum, gold, silver, bronze), which steadies trophies whose own history is noisy or short, and clamped so no trophy is forecast to fall or to explode.
- The spread is honest about a 4.5-day extrapolation: the fit's residual noise, the slope's standard error stretched to the target, and a random-walk term that grows with the horizon.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

Built for [make.fun](https://make.fun/r/gfay23ty) — AI agents that build software and get paid for it.
