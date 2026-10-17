import { describe, expect, it } from "vitest";

import { videoExtensionFor } from "./mediaType";

/**
 * 媒体容器判定（2026-10-16，审计 P228）。
 *
 * 原来成品一律按 `.mp4` 落盘、`dshasset://` 也按 `.mp4` 给 MIME ——
 * 上游返回 webm/mov/gif 时，文件名、MIME 与实际内容三者全对不上，
 * 界面表现是"生成成功但放不出来"。这几条钉住判定顺序：
 * **魔数 > Content-Type > 默认（并如实标未知）**。
 */

const ftyp = (brand: string): Uint8Array => {
  const head = new Uint8Array(16);
  head.set([0, 0, 0, 0x18], 0);
  head.set([...Buffer.from("ftyp", "ascii")], 4);
  head.set([...Buffer.from(brand, "ascii")], 8);
  return head;
};

describe("videoExtensionFor", () => {
  it("魔数优先：ftyp/mp42 → .mp4；品牌 qt → .mov", () => {
    expect(videoExtensionFor("application/octet-stream", ftyp("mp42"))).toEqual({ ext: ".mp4", isKnown: true });
    expect(videoExtensionFor(null, ftyp("qt  "))).toEqual({ ext: ".mov", isKnown: true });
  });

  it("WebM / GIF / Ogg 的魔数认得出来", () => {
    expect(videoExtensionFor("video/mp4", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toEqual({ ext: ".webm", isKnown: true });
    expect(videoExtensionFor(null, new Uint8Array([...Buffer.from("GIF89a", "ascii")]))).toEqual({ ext: ".gif", isKnown: true });
    expect(videoExtensionFor(null, new Uint8Array([...Buffer.from("OggS", "ascii")]))).toEqual({ ext: ".ogv", isKnown: true });
  });

  it("魔数看不出来时看 Content-Type（带参数、大小写都认）", () => {
    expect(videoExtensionFor("video/webm; codecs=vp9")).toEqual({ ext: ".webm", isKnown: true });
    expect(videoExtensionFor("VIDEO/QUICKTIME")).toEqual({ ext: ".mov", isKnown: true });
  });

  it("⭐ 两个都判不出来：回 .mp4 但**如实标 isKnown=false**（不假装知道）", () => {
    expect(videoExtensionFor(undefined)).toEqual({ ext: ".mp4", isKnown: false });
    expect(videoExtensionFor("application/octet-stream")).toEqual({ ext: ".mp4", isKnown: false });
  });

  it("认得出的容器不会被 Content-Type 带偏（魔数优先）", () => {
    /* 中转把 webm 标成 video/mp4 是常见病 —— 以文件自己说的为准 */
    expect(videoExtensionFor("video/mp4", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ ext: ".webm", isKnown: true });
  });
});
