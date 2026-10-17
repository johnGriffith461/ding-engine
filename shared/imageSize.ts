/**
 * Lunora 图像尺寸规格（机器可读实现）。
 *
 * 依据：仓外工作区里的一份《lunora-image-size-rules.md》（未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * （该文档标注 `status: authoritative`，来自真实浏览器逐项点击实测）。
 * **不要估算、不要自行推导近似值** —— 这张表是离散枚举 + 确定性规整，没有模型自由裁量。
 *
 * 三个容易踩的点（文档 §7 明确列了）：
 *   1. `21:9` **不是查表得来的**。查表前先约分，`21:9 → 7:3`，内置表里没有 `7:3`，
 *      于是落进「面积最大化搜索」分支，结果是 `1920x816 / 3120x1344 / 3840x1648`。
 *      源码里另有一张写着 `1280x544 / 2560x1088 / 3840x1600` 的表是**死代码，永远不可达**。
 *   2. `1K/2K/4K` 只是**面积上限标签**，不代表固定边长 —— 4K 的 `1:1` 是 `2880x2880` 而不是 `3840x3840`。
 *   3. 命中表的值**仍要过一遍 `normalize()`**。
 */

/** 宽高必须是这个数的整数倍。 */
export const SIZE_MULTIPLE = 16;
export const MAX_SIDE = 3840;
export const MAX_RATIO = 3;
export const MIN_PIXELS = 655_360;
export const MAX_PIXELS = 8_294_400;
export const RATIO_TOLERANCE = 0.01;

/** 档位的面积上限。 */
export const TIER_CAP: Record<Tier, number> = {
  "1K": 1_572_864,
  "2K": 4_194_304,
  "4K": 8_294_400,
};

export type Tier = "1K" | "2K" | "4K";

/** 8 个预设比例。注意 key 集合里**刻意不含 `21:9`**（它约分后是 7:3，本就走搜索分支）。 */
export const PRESET_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"] as const;
export type PresetRatio = (typeof PRESET_RATIOS)[number];

/** 尺寸模式：自动 / 按比例 / 自定义宽高（对标文档 §1 的 `size_mode`）。 */
export type SizeMode = "auto" | "ratio" | "resolution";

const TABLE_1K: Record<string, string> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1280x720",
  "9:16": "720x1280",
  "4:3": "1024x768",
  "3:4": "768x1024",
};
const TABLE_2K: Record<string, string> = {
  "1:1": "2048x2048",
  "3:2": "2160x1440",
  "2:3": "1440x2160",
  "16:9": "2560x1440",
  "9:16": "1440x2560",
  "4:3": "2048x1536",
  "3:4": "1536x2048",
};
const TABLE_4K: Record<string, string> = {
  "1:1": "2880x2880",
  "3:2": "3456x2304",
  "2:3": "2304x3456",
  "16:9": "3840x2160",
  "9:16": "2160x3840",
  "4:3": "3200x2400",
  "3:4": "2400x3200",
};
const TABLES: Record<Tier, Record<string, string>> = { "1K": TABLE_1K, "2K": TABLE_2K, "4K": TABLE_4K };

const uk = (v: number) => Math.max(SIZE_MULTIPLE, Math.round(v / SIZE_MULTIPLE) * SIZE_MULTIPLE);
const sf = (v: number) => Math.max(SIZE_MULTIPLE, Math.floor(v / SIZE_MULTIPLE) * SIZE_MULTIPLE);
const dk = (v: number) => Math.max(SIZE_MULTIPLE, Math.ceil(v / SIZE_MULTIPLE) * SIZE_MULTIPLE);

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/**
 * 规整：宽高必为 16 的倍数、单边 ≤ 3840、比例 ≤ 3:1、总像素落在 [655360, 8294400]。
 *
 * @param w 输入宽
 * @param h 输入高
 * @returns 规整后的 `[宽, 高]`
 */
export function normalize(w: number, h: number): [number, number] {
  let a = uk(w);
  let s = uk(h);
  // 文档写的是"重复 4 次" —— 这几条约束会互相影响（缩放面积可能又破坏 3:1），
  // 迭代是收敛手段，不要改成单趟
  for (let i = 0; i < 4; i += 1) {
    const f = Math.max(a, s);
    if (f > MAX_SIDE) {
      const d = MAX_SIDE / f;
      a = sf(a * d);
      s = sf(s * d);
    }
    if (a / s > MAX_RATIO) a = sf(s * MAX_RATIO);
    else if (s / a > MAX_RATIO) s = sf(a * MAX_RATIO);
    const m = a * s;
    if (m > MAX_PIXELS) {
      const d = Math.sqrt(MAX_PIXELS / m);
      a = sf(a * d);
      s = sf(s * d);
    } else if (m < MIN_PIXELS) {
      const d = Math.sqrt(MIN_PIXELS / m);
      a = dk(a * d);
      s = dk(s * d);
    }
  }
  return [a, s];
}

/** 解析 `WxH` / `W:H` / `W×H` / `WXH`（小数允许）。 */
export function parseSize(input: string): { w: number; h: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(input));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** 面积最大化搜索（文档 §4.1）。**取面积最大者**，不是取最接近比例的。 */
function searchBest(tier: Tier, d: number): { w: number; h: number; area: number } | null {
  let best: { w: number; h: number; area: number } | null = null;
  for (let W = SIZE_MULTIPLE; W <= MAX_SIDE; W += SIZE_MULTIPLE) {
    const Y = W / d;
    for (const H of [sf(Y), dk(Y)]) {
      if (H < SIZE_MULTIPLE || H > MAX_SIDE) continue;
      const area = W * H;
      if (area > TIER_CAP[tier] || area < MIN_PIXELS) continue;
      if (Math.max(W / H, H / W) > MAX_RATIO) continue;
      if (Math.abs(W / H - d) / d > RATIO_TOLERANCE) continue;
      if (!best || area > best.area) best = { w: W, h: H, area };
    }
  }
  return best;
}

/**
 * 按档位 + 比例解出最终尺寸（文档 §4）。
 * @param tier 档位
 * @param input 比例字符串（`1:1`、`5:4`、`2.39:1`…）或 `WxH`
 * @returns `"WxH"`；超过 3:1 或无法解析时返回 null（界面据此置灰确认按钮）
 */
export function resolveSize(tier: Tier, input: string): string | null {
  const n = parseSize(input);
  if (!n) return null;
  /*
   * 约分**只对整数有意义**（审计 P245）：`2.39:1` 这类小数比例在文件头 §4 里是支持的输入，
   * 而浮点欧几里得 gcd 一路不归零 → key 会变成 `"14346448794755885:6002696537461680"`
   * 那种巨值（每次调用还白花几十轮取模），档位表命中判断对小数输入永远失效。
   * 小数就按原样当 key（内置表里本来也没有小数档，落进下面的面积搜索分支）。
   */
  const g = Number.isInteger(n.w) && Number.isInteger(n.h) ? gcd(n.w, n.h) || 1 : 1;
  const key = `${n.w / g}:${n.h / g}`;

  let rawW: number;
  let rawH: number;
  if (TABLE_1K[key]) {
    // 命中即用档位表（注意：命中也要过 normalize）
    const parsed = parseSize(TABLES[tier][key]);
    if (!parsed) return null;
    rawW = parsed.w;
    rawH = parsed.h;
  } else {
    const best = searchBest(tier, n.w / n.h);
    if (!best) return null;
    rawW = best.w;
    rawH = best.h;
  }

  const [a, b] = normalize(rawW, rawH);
  return `${a}x${b}`;
}

/** 自定义宽高（文档 §4.2；上限固定 MAX_PIXELS，与 1K/2K/4K 无关）。 */
export function resolveWH(w: number, h: number): string {
  const [a, b] = normalize(w, h);
  return `${a}x${b}`;
}

/**
 * 反向映射：给定尺寸判断它属于哪一档 + 哪个比例（文档 §6）。
 * @returns 命中的 `{tier, ratio}`；落进自定义宽高时返回 null
 */
export function inferSize(size: string): { tier: Tier; ratio: string } | null {
  const n = parseSize(size);
  if (!n) return null;
  const [a, b] = normalize(n.w, n.h);
  const target = `${a}x${b}`;
  for (const tier of ["1K", "2K", "4K"] as Tier[]) {
    for (const ratio of PRESET_RATIOS) {
      const resolved = resolveSize(tier, ratio);
      if (!resolved) continue;
      const parsed = parseSize(resolved);
      if (!parsed) continue;
      const [ra, rb] = normalize(parsed.w, parsed.h);
      if (`${ra}x${rb}` === target) return { tier, ratio };
    }
  }
  return null;
}

/** 一次生成要用的尺寸设置。 */
export type SizeChoice = {
  mode: SizeMode;
  tier: Tier;
  /** ratio 模式下的比例（8 个预设之一，或自定义比例字符串）。 */
  ratio: string;
  /** resolution 模式下的自定义宽高。 */
  width: number;
  height: number;
};

export const DEFAULT_SIZE_CHOICE: SizeChoice = {
  mode: "ratio",
  tier: "1K",
  ratio: "1:1",
  width: 1024,
  height: 1024,
};

/**
 * 算出最终要提交的 `size` 字符串。
 *
 * `auto` 模式**不向接口发送 size 参数**（文档 §5）—— 所以这里返回 `"auto"`，
 * 由调用方决定"是发 `size: "auto"` 还是干脆不发"（见 imageGen 里传 undefined）。
 */
export function resolveChoice(choice: SizeChoice): { size: string; invalid: boolean; normalized: boolean } {
  if (choice.mode === "auto") return { size: "auto", invalid: false, normalized: false };

  if (choice.mode === "ratio") {
    const size = resolveSize(choice.tier, choice.ratio);
    if (!size) return { size: "", invalid: true, normalized: false };
    return { size, invalid: false, normalized: false };
  }

  const n = parseSize(`${choice.width}x${choice.height}`);
  if (!n) return { size: "", invalid: true, normalized: false };
  /*
   * 0（清空宽/高输入框之后就是 0）**不是"有效但需要规整"**（审计 P244）：
   * `normalize(0, 0)` 会把它悄悄放大到 816x816 并照样发出去一次真请求 ——
   * 花钱、尺寸还不是用户要的，而界面上的置灰门（靠 `invalid`）压根不触发。
   */
  if (n.w <= 0 || n.h <= 0) return { size: "", invalid: true, normalized: false };
  const size = resolveWH(n.w, n.h);
  return { size, invalid: false, normalized: size !== `${Math.round(n.w)}x${Math.round(n.h)}` };
}

/** 把尺寸拆成宽高数字（界面显示用）。 */
export function sizeToWH(size: string): { w: number; h: number } | null {
  return parseSize(size);
}
