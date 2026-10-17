/**
 * 产品自述（名字 / 标题 / 版本）——**只有这一份**。
 *
 * 原来 `agentServer.ts` 与 `acp/agent.ts` 各写了一份字面量 `"0.4.0"`，
 * 而包的版本已经走到 0.5.0：对外/对宿主自报的版本号成了两处会各自腐坏的抄本
 * （审计 P183 的同类：接口按其承诺的形状是假的）。抽到这里之后，
 * 升版本只有一处要改。
 *
 * ⚠️ 与 `package.json` 的 `version` **手动保持一致**（Release 时一起改）。
 * 不直接 import `package.json` 是因为 CLI 单二进制那条路（Bun 打包）不吃
 * 运行时读文件这条路 —— 在车间里"少一个运行期依赖"比"少改一行"值。
 */
export const PRODUCT_NAME = "ding-harness";
export const PRODUCT_TITLE = "Ding Harness";
export const PRODUCT_VERSION = "0.5.0";
