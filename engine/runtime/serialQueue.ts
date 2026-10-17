/**
 * 一条**串行队列**（2026-10-16，审计 P42）。
 *
 * ## 为什么需要它
 *
 * 记忆与定时任务都是"读出整份 → 改 → 写回整份"的形状。两次调用并发时
 * （模型在一轮里连发两条 `memory_save`、或用户点「允许」时正好又有一轮在跑），
 * 两边读到同一份旧快照，后写的把先写的整份盖掉 —— **丢一条，而且不报错**。
 *
 * 同仓的 `aiProbe.ts` 早就为这件事写过"下面的 chain —— 并发调用排队执行，
 * 不会互相覆盖"，但它是就地写的一段；抽出来是为了让**这件事实有单测能钉**
 * （原来那段只能靠读源码确认，改坏了没有任何断言会红），并且给后面的调用方
 * 一个统一口径，而不是每处各写一遍。
 *
 * 口径：**一段失败不堵住后面的人**（队尾只保留"完成"这个事实，异常的传播由
 * 各自的返回 Promise 负责）。
 */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * 建一条串行队列。
 *
 * @returns 把任务排到队尾并返回它自己的 Promise
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // 失败也要跑（第一参是成功回调，第二参是失败回调）——一段坏了不该让后面所有人卡住
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
