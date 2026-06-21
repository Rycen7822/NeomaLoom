# NoemaLoom Problems Ledger

复审时间：2026-06-22T03:00:23+08:00  
第二份外部审查增量复审时间：2026-06-22T03:08:16+08:00  
复审基线：`e892773e672be2da10e7e873079a3e0e784e6ec8` (`main`)  
来源：外部工程师安全/健壮性审查报告；第二份 agent 安全边界/桥接/测试/文档审查报告。  
范围：本文件只保留当前仍值得跟踪的 active 问题和修复执行记录；已修复或长期不适合作为 active bug 的旧条目不再展开保留。

## 当前 active unresolved

无。

## Round 1 修复执行记录

执行时间：2026-06-22T03:31:05+08:00  
相关临时 worknotes 已在提交前清理；本 ledger 保留最终执行摘要。

已修复/缓解范围：

- `C1`：默认 inventory 不再纳入无扩展名文件；增加内建 sensitive path denylist；默认 `ignoreGlobs` 覆盖 `.env`、`.aws/**`、`.ssh/**`、常见 key/cert/credential config 文件，同时保留普通文档如 `docs/secrets.md` 进入索引并由内容 redaction 处理。
- `C2`：`projectPath` 增加默认系统根/系统目录拒绝，并支持 `NOEMALOOM_ALLOWED_PROJECTS` 严格 allowlist。
- `H1`：private-key redaction 改为有界跨行扫描；Round 2 继续补齐 email/password 细节。
- `H2`：query normalizer 在 regex extraction 前对 raw query 做 10,000 字符上限。
- `H3`：Markdown link checker 改为逐行匹配，避免 malformed 多行链接跨行扫描。
- `H4/H14`：project safe read 改为 no-follow open + fd read + regular-file 检查，缩小 check-then-read TOCTOU 窗口。
- `H8`：public unhandled-error warning 不再拼接 stack frame 路径。
- `H11`：refresh lock 创建时通过同一次 exclusive open 写入 payload，删除空锁文件窗口。
- `H12/M14`：`.noemaloom/` write/append/exclusive-open/unlink 走 symlink-escape 检查；append/open 使用 no-follow flags，unlink 也拒绝 symlinked parent escape。
- `H13/M16`：custom feature worker command 默认禁用；只有 `NOEMALOOM_ALLOW_CUSTOM_WORKER=1|true` 才运行；worker 环境改为最小 allowlist；timeout/output-cap 返回前等待 child close/force-kill。

Round 1 验证：targeted regression、`npm test`、`npm run test:integration`、`npm run test:e2e`、`npm run test:all`、`npm run typecheck`、`npm run build`、`git diff --check` 均通过。

## Round 2 修复执行记录

执行时间：2026-06-22T03:55:39+08:00  
相关临时 worknotes 已在提交前清理；本 ledger 保留最终执行摘要和验证结果。

本轮修复/升级范围：

- `H1/L8`：email redaction 加 `@` prefilter 和长度上限；password redaction 支持有界 quoted passphrase。
- `L1`：telemetry metadata append 通过 redaction seam 递归脱敏，并限制嵌套/集合处理量。
- `H4`：code-fact 和 refresh 的 indexed-text fallback 统一改为 `safeReadFileInsideProject(projectRoot, file.path, 'utf8')`，不再信任 inventory absolute path。
- `H5`：code fact indexing 使用 owner seam 内有界并发池。
- `H6`：JSON artifact traversal 增加深度 cap；object/array hash/preview 避免递归 stringify；package `exports` 递归增加深度 cap。
- `H7`：callsite extraction 增加每文件上限、每行上限和超长行跳过。
- `H9`：old-term sweep 对 changedPaths 数量和目录展开数量加 cap，并跳过 `.git`、`.noemaloom`、`node_modules`、`.venv`、`venv`、`.tox`、`__pycache__` 等重型目录，同时保留显式 `.agents/skills` 扫描契约。
- `H10`：`nl_impact` 改用 final-envelope token budget estimator，预算超出时返回 warning/truncated。
- `M1`：core git 调用禁用 terminal prompt/system config，并覆盖 fsmonitor/credential helper。
- `M2`：`traceGraph` 和 locator candidate-generation 的 symbol LIKE 参数复用 escaped pattern。
- `M3`：`traceGraph` 在缺失 spans DB 时返回 empty graph，不再创建 0 字节 DB。
- `M4`：repository map 写入改走 guarded state writer。
- `M6`：`nl_anchor_manage` 去掉 passthrough hidden control plane；`enableNavigation` 不再能通过 public manage tool 触发。
- `M8/M9`：Python worker 对 JSON 文件读取增加大小/类型/invalid JSON guard；stdin 请求行增加大小上限；request 必须是 JSON object。
- `M13`：CLI anchor `--project`/`--json`/`--json-file` 缺值时返回结构化 validation envelope，不再吞掉下一个 flag。
- `L4`：Hermes bridge `NOEMALOOM_TOOL_TIMEOUT` 非数字或非正数回退到 600 秒，不在 handler try 外崩溃。

本轮不再作为 active bug 保留的旧条目：

- `M5`：广泛 `.passthrough()` 是过宽迁移议题；具体 hidden control plane 已由 `M6` 处理，剩余 schema strictness 不适合作为 active bug。
- `M7`：`PRAGMA synchronous = OFF` 是 rebuildable derived DB 的性能/耐久性 tradeoff，不在本轮改动。
- `M10`：MCP SDK 管理 stdio 子进程生命周期；插件层 process-group kill 需要替换 SDK 抽象，缺少可复现泄漏前不作为 active bug。
- `M11`：YAML/TOML/RST 启发式解析属于已知功能覆盖边界，非当前安全/健壮性缺陷。
- `M12`：完整 `.gitignore`/高级 glob 语义属于功能增强；本轮只在 verify sweep 侧修重型目录 cap。
- `M15`：chmod/EACCES 环境依赖在当前环境未复现；已有测试通过，后续如复现再以具体失败修测试策略。
- `L2`：SHA-1 用于非认证身份/内容哈希，迁移 SHA-256 会造成 ID churn，暂不作为 active bug。
- `L3`：`noUncheckedIndexedAccess` 是大范围 TS strictness 迁移，非具体缺陷。
- `L5`：navigation manifest `flock` 是低优先级并发增强，缺少复现问题。
- `L6`：runtime hash validation 与当前 install metadata/dirty warning 重叠，强校验可能带来 install-mode false positives。
- `L7`：`copy-build-assets.mjs` 是 repo-local build helper，非用户输入暴露面。
- `L9`：glob char class/negation 属于高级 ignore 语义支持，非当前默认契约缺陷。
- `L10`：append fsync 属于 best-effort log 语义；critical state 已使用 temp/fsync/rename。

Round 2 验证：

- Targeted：`npx vitest run tests/unit/file-inventory.test.ts tests/unit/envelope.test.ts tests/unit/safety-path-guard.test.ts tests/unit/locator-ranking.test.ts tests/unit/link-checker.test.ts tests/unit/redaction.test.ts tests/unit/telemetry-jsonl-writer.test.ts tests/unit/code-fact-extractor.test.ts tests/unit/artifact-indexer.test.ts tests/unit/coverage-verifier.test.ts tests/unit/trace-fast-path.test.ts tests/unit/anchor-tools.test.ts tests/unit/cli-help.test.ts tests/integration/feature-worker-client.test.ts`，14 files / 82 tests passed。
- Python worker：`python3 -m pytest tests` in `python/nl_rpg_projection_worker`，4 tests passed。
- Static/build：`npm run typecheck`、`npm run build` 均 passed。
- Full：`npm run test:all`，68 files / 307 tests passed。
- Hygiene：`git diff --check` passed。
