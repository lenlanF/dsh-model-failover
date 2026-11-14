# Migration / 从 v0.1.0 升级到 v0.2.0（设置页版）

- **主操作界面变为设置页**（Settings → 插件分区 `dsh-model-failover`）：勾选 + 排序所有已连接 provider/model，组成唯一一条有序故障转移链；保存走 `settings.mutate` → `<profile>/cordis.patch.yml` → Cordis HMR 立即生效。
- **现有 3-model 链保留为默认**：`workbuddy/hy4free` → `workbuddy/hy3` → `workbuddy/hy4std`。
- **其它已连接模型默认未勾选**，只列在目录里，**永不使用**；需要时手动勾选并排序。
- **不需要手改 YAML**，旧的 `config:` 覆盖条目由设置页接管；新增字段缺省即默认值（`maxSwitchesPerSession: 3`、`cooldownMs: 0`、`switchLogLimit: 20`、`switchLog: []`）。
- **旧纯 YAML 工作流仍可用但不再是主路径**：`rules.yaml` / `config.example.yml` 作为离线模板，手写 `cordis.patch.yml` 后需完整重启 Host（不经过 HMR）。
- **更新 live install**：同步 `file:` 目录中的新文件（含 `lib/client.js` 与 `package.json` 的 `dsh.client` / `exports['./client']`），首次新增客户端入口需完整重启 Host；之后运行期改动由 HMR recomposition 生效。
- 跨 provider 混选会有警告（thinking block / KV cache 不通用）；切换仍只对下一步 / 新轮次生效，`QUOTA` 仍被内置 Continue 排除。完整说明见仓库根目录 `README.md`。

界面文案、按钮与分组标题以设置页实际显示为准。
