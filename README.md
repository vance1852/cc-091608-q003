# 居家睡眠呼吸初筛

该项目承载腕式睡眠采样批次、同步锚点、睡眠片段和报告版本。所有指数都应保留有效采样分母及质量上下文，报告内容仅用于初筛沟通。

领域结构位于 `src/contracts.ts`。`fixtures/overnight-stream.json` 包含设备时钟漂移、中途摘戴以及低灌注区间，时间均为脱敏数据。

项目使用 Node.js 22 和 TypeScript，`npm test` 会在严格模式下检查类型契约。
