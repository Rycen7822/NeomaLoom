# NoemaLoom

[English](README.md) | 中文

NoemaLoom 是一个本地 MCP server，用于以 repository span 为核心定位仓库级修改范围。它在 `.noemaloom/` 下构建派生索引，为编码智能体提供紧凑、只读的仓库视图，并帮助智能体准备上下文、规划影响范围、在修改后验证覆盖情况。

NoemaLoom 不直接编辑源码文件。它负责定位和验证 repository spans；实际文件修改由 Codex、Hermes 或其他智能体使用自身原生编辑工具完成。

## 能力范围

- 为源码、Markdown/MDX/RST 文档、配置文件、package 元数据、测试、示例和 feature projection 数据建立仓库级 span 索引。
- 建立代码、文档、配置、测试、示例和 feature 之间的跨表面链接。
- 准备任务上下文，并返回排序后的 target、path、line range、decision、reason、confidence 和 evidence。
- 支持可选 top-span 读取；当行号漂移时提供重定位能力。
- 在修改前规划代码、文档、配置、测试、示例和 feature 的影响范围。
- 验证旧术语残留、断链、过期 anchor、未同步文档和 code-doc mismatch。
- 在上下文压缩后，通过派生 repository map 恢复任务上下文，而不需要重新读完整仓库。

## 安全边界

NoemaLoom 只把派生状态写入项目本地的 `.noemaloom/`。

它不会写全局配置，不会安装 Git hooks，不会 patch Codex cache，不会暴露 writer tools，也不会暴露原始后端工具表面。`.noemaloom/` 是可删除、可从仓库内容重建的派生缓存。

## MCP 工具

server 只暴露以下 5 个面向智能体的工具：

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`

其中 `nl_refresh` 会在 `.noemaloom/` 下写入派生缓存文件。其他工具对项目源码文件保持只读。

## 手动 MCP 配置

先让当前仓库工作区中的 `noemaloom` 命令在环境中可用，然后用下面的命令启动 MCP stdio server：

```bash
noemaloom serve --mcp
```

Hermes MCP server 配置项：

```yaml
mcp_servers:
  noemaloom:
    command: noemaloom
    args:
      - serve
      - --mcp
    timeout: 120
    connect_timeout: 60
    enabled: true
```

Codex MCP server 配置项：

```toml
[mcp_servers.noemaloom]
command = "noemaloom"
args = ["serve", "--mcp"]
```

## 推荐智能体工作流

1. 阅读 `skill/noemaloom/SKILL.md` 和对应的 `skill/noemaloom/references/*.md` 工作流。
2. 调用 `nl_status` 检查索引状态和安全标志。
3. 当索引缺失或过期时，调用 `nl_refresh`，使用 `target="all"`。
4. 针对任务目标调用 `nl_prepare_context`。
5. 代码或 API 变更前调用 `nl_plan_change`。
6. 由智能体使用原生文件编辑工具修改文件。
7. 调用 `nl_verify_task` 检查旧术语残留、断链、过期 anchor、未同步文档和 mismatch。
8. 覆盖验证通过后，调用 `nl_refresh`，使用 `target="changed"`。

## 开发

运行要求：

- Node.js 20 或更新版本
- Python 3.11 或更新版本，用于 feature projection worker 测试
- npm

常用命令：

```bash
npm run build
npm run typecheck
npm test
python -m pytest
```

Python 测试配置限定在本仓库的 `tests/` 目录内，最终 Python gate 不会收集 ignored 的 reference 源码树测试。

## 文档入口

- [文档索引](docs/README.md)
- [架构](docs/architecture.md)
- [MCP 工具](docs/mcp-tools.md)
- [数据模型](docs/data-model.md)
- [索引流程](docs/indexing.md)
- [定位流程](docs/locating.md)
- [安全边界](docs/safety.md)
- [故障排查](docs/troubleshooting.md)
