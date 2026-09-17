# 居家睡眠呼吸初筛

该项目承载腕式睡眠采样批次、同步锚点、睡眠片段和报告版本。所有指数都应保留有效采样分母及质量上下文，报告内容仅用于初筛沟通。

领域结构位于 `src/contracts.ts`。`fixtures/overnight-stream.json` 包含设备时钟漂移、中途摘戴以及低灌注区间，时间均为脱敏数据；`fixtures/late-arrival.json` 模拟断连窗口的补传批次。

项目使用 Node.js 22 和 TypeScript，`npm test` 会在严格模式下检查类型契约并运行 `node:test` 测试。

## 运行

```bash
npm install
npm test          # tsc --noEmit + node:test 单元/端到端测试
npm run demo      # 端到端演示：导入 → 草稿 v1 → 技师排除 → 签署 v2 → 补传 → 新草稿 v3
npm run generate:fixtures   # 确定性重新生成 fixtures/
```

Node 22 直接以 `--experimental-strip-types` 运行 TypeScript，无需构建步骤。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/contracts.ts` | 领域契约：采样批次、同步锚点、睡眠段、报告结构 |
| `src/clock.ts` | 单调设备时钟 → 墙面时间：锚点分段线性校正漂移，锚点外外推并放大不确定度 |
| `src/ingest.ts` | 流文件读取/校验（带字段路径的错误），补传流合并（同 id 批次内容冲突即拒绝） |
| `src/nights.ts` | 夜次归属（本地正午为界，跨午夜/中途重戴同夜）、佩戴分段、摘下与断连空洞、短暂清醒 |
| `src/quality.ts` | 不可判读区间（低灌注、摘下、无数据、信号间隙、采样过疏、技师排除）与有效分母 |
| `src/events.ts` | 候选低氧事件：滑动基线降 ≥3%、持续 ≥10s，脉搏上升佐证，体动警示 |
| `src/metrics.ts` | ODI3 等指标；覆盖不足时 `not-interpretable`，每个指标带算法版本/批次/分母溯源 |
| `src/report.ts` | 版本化报告：草稿 → 签署（深冻结）；签署后任何变更只生成新草稿版本 |
| `src/view.ts` | 医师视图：事件时间轴、有效分母、质量说明、转诊建议、免责声明 |
| `src/demo.ts` | 完整工作流演示 |

## 诚实边界（设计原则）

- **不给误导性指数**：有效血氧时长 < 180 分钟或覆盖率 < 60% 时，ODI3 等指标为
  `not-interpretable` 并列出具体原因与不可判读区间，绝不输出看似精确的整夜指数。
- **候选而非诊断**：所有事件都是 candidate/corroborated 级别的筛查线索，
  报告固定携带“不构成诊断结论”的免责声明与转正式 PSG 的建议逻辑。
- **全程可溯源**：每个指标记录算法版本（`hsat-screen-1.0.0`）、参与批次、
  排除区间与有效分母；每个事件记录来源批次。
- **签署即冻结**：签署版深冻结，重复签署/签署旧草稿报错；补传批次只形成新草稿，
  签署版保持原样（含其当时记录的断连缺口）。
