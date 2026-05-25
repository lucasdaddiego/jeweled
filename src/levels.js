// 100 Classic levels. Score target escalates; move budget tightens gradually.
// Tiers (just for orientation, not enforced in code):
//   L1–10  Tutorial      |  L11–20 Mid-game
//   L21–35 Advanced      |  L36–50 Expert
//   L51–70 Master        |  L71–90 Grandmaster
//   L91–100 Legendary
// Levels 1–50 are hand-tuned. 51–100 are generated below with ~4.5% target growth.

const HAND_TUNED = [
  // Tutorial / warm-up
  { moves: 30, targetScore:    500 },  // 1
  { moves: 30, targetScore:    900 },  // 2
  { moves: 30, targetScore:   1400 },  // 3
  { moves: 28, targetScore:   2000 },  // 4
  { moves: 28, targetScore:   2700 },  // 5
  { moves: 28, targetScore:   3500 },  // 6
  { moves: 28, targetScore:   4400 },  // 7
  { moves: 27, targetScore:   5400 },  // 8
  { moves: 27, targetScore:   6500 },  // 9
  { moves: 27, targetScore:   7700 },  // 10
  // Mid-game
  { moves: 26, targetScore:   9000 },  // 11
  { moves: 26, targetScore:  10400 },  // 12
  { moves: 26, targetScore:  11900 },  // 13
  { moves: 26, targetScore:  13500 },  // 14
  { moves: 25, targetScore:  15200 },  // 15
  { moves: 25, targetScore:  17000 },  // 16
  { moves: 25, targetScore:  19000 },  // 17
  { moves: 25, targetScore:  21500 },  // 18
  { moves: 25, targetScore:  24500 },  // 19
  { moves: 25, targetScore:  28000 },  // 20
  // Advanced
  { moves: 25, targetScore:  32000 },  // 21
  { moves: 25, targetScore:  36500 },  // 22
  { moves: 24, targetScore:  41500 },  // 23
  { moves: 24, targetScore:  47000 },  // 24
  { moves: 24, targetScore:  53000 },  // 25
  { moves: 24, targetScore:  59500 },  // 26
  { moves: 24, targetScore:  66500 },  // 27
  { moves: 23, targetScore:  74000 },  // 28
  { moves: 23, targetScore:  82000 },  // 29
  { moves: 23, targetScore:  90500 },  // 30
  { moves: 23, targetScore:  99500 },  // 31
  { moves: 22, targetScore: 109000 },  // 32
  { moves: 22, targetScore: 119000 },  // 33
  { moves: 22, targetScore: 129500 },  // 34
  { moves: 22, targetScore: 140500 },  // 35
  // Expert
  { moves: 22, targetScore: 152000 },  // 36
  { moves: 21, targetScore: 164000 },  // 37
  { moves: 21, targetScore: 176500 },  // 38
  { moves: 21, targetScore: 189500 },  // 39
  { moves: 21, targetScore: 203000 },  // 40
  { moves: 21, targetScore: 217000 },  // 41
  { moves: 20, targetScore: 231500 },  // 42
  { moves: 20, targetScore: 246500 },  // 43
  { moves: 20, targetScore: 262000 },  // 44
  { moves: 20, targetScore: 278000 },  // 45
  // Master
  { moves: 20, targetScore: 294500 },  // 46
  { moves: 20, targetScore: 311500 },  // 47
  { moves: 20, targetScore: 329000 },  // 48
  { moves: 20, targetScore: 347000 },  // 49
  { moves: 20, targetScore: 365500 },  // 50
];

// L51 onward: programmatic growth in three tiers so the curve doesn't run away.
//   L51–L100  +4.5%/level  → 50× span, ends ~3.3M
//   L101–L200 +2%/level    → 100 levels of gentler climb, ends ~24M
//   L201–L300 +1%/level    → very gradual, ends ~65M
function genEndgame() {
  const out = [];
  let target = HAND_TUNED[HAND_TUNED.length - 1].targetScore;
  for (let i = 51; i <= 300; i++) {
    const rate = i <= 100 ? 1.045 : i <= 200 ? 1.020 : 1.010;
    target = Math.round(target * rate / 500) * 500;
    out.push({ moves: 20, targetScore: target });
  }
  return out;
}

export const LEVELS = [...HAND_TUNED, ...genEndgame()];

export const LEVELS_PER_PAGE = 20;
export function pageCount() {
  return Math.ceil(LEVELS.length / LEVELS_PER_PAGE);
}
export function pageOfLevel(levelNum) {
  return Math.ceil(levelNum / LEVELS_PER_PAGE);
}

export function getLevel(n) {
  // Clamp to [1, LEVELS.length]. Out-of-range was previously silent: n<=0
  // returned the last level (because LEVELS[-1] is undefined → fallback),
  // which masks bugs elsewhere. Clamp explicitly.
  const i = Math.max(1, Math.min(LEVELS.length, n | 0));
  return LEVELS[i - 1];
}

export function levelCount() {
  return LEVELS.length;
}

// Stars: 1 = beat target, 2 = +50%, 3 = +100%
export function starsFor(score, target) {
  if (score < target) return 0;
  if (score >= target * 2) return 3;
  if (score >= target * 1.5) return 2;
  return 1;
}
