# NoemaLoom

[English](README.md) | 中文

NoemaLoom 是一个本地 span-first 仓库修改定位运行时。它在 `.noemaloom/` 下构建派生索引，为编码智能体提供紧凑、只读的仓库视图，并帮助智能体准备上下文、规划影响范围、在修改后验证覆盖情况。

NoemaLoom 不直接编辑源码文件。它负责定位和验证 repository spans；实际文件修改由 Hermes、Codex 或其他智能体使用自身原生编辑工具完成。

对于 Hermes，推荐使用 `hermes-plugin/noemaloom` 中的原生插件。手动 MCP server 仍保留给 Codex 或其他仅支持 MCP 的客户端。

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

## 面向智能体的工具

Hermes plugin 和 MCP server 都只暴露以下 5 个面向智能体的工具：

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`

其中 `nl_refresh` 会在 `.noemaloom/` 下写入派生缓存文件。其他工具对项目源码文件保持只读。

## Hermes Plugin

当 Hermes 需要直接使用 NoemaLoom 时，使用 `hermes-plugin/noemaloom`。这个路径把 Hermes 侧集成收束到一个插件目录内：工具注册、运行时桥接、bundled usage skill。

使用该 plugin 时，不需要单独添加 Hermes MCP server entry。插件会直接向 Hermes 注册 5 个受控工具，并在每次工具调用时内部启动一个短生命周期的本地 NoemaLoom stdio 进程。

开发 / 源码链接安装：

```bash
cd <NOEMALOOM_REPO>
npm ci --include=dev
ln -sfn "$PWD/hermes-plugin/noemaloom" "${HERMES_HOME:-$HOME/.hermes}/plugins/noemaloom"
hermes plugins enable noemaloom
```

如果不是 symlink，而是复制 `hermes-plugin/noemaloom`，请在启动 Hermes 前设置 `NOEMALOOM_REPO`，这样插件才能找到 TypeScript runtime 和 Python feature worker package：

```bash
export NOEMALOOM_REPO=/path/to/NoemaLoom
```

启用插件后，启动新的 Hermes session 或重启 gateway。任务需要 NoemaLoom 工作流时，显式加载 bundled skill：

```python
skill_view(name="noemaloom:usage")
```

预期 Hermes 验证命令：

```bash
hermes plugins list --plain --no-bundled
hermes tools list
```

然后在目标项目中先调用 `nl_status`，再执行 refresh 或定位工作。

## 手动 MCP 配置

这是给 Codex 或其他直接消费 stdio MCP server 的客户端使用的兼容路径。Hermes 用户默认应优先使用上面的原生 plugin，除非明确需要把 NoemaLoom 配成单独的 MCP server。

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

## Agent 安装 Prompt

当你希望 agent 从这个本地源码仓库安装 NoemaLoom 时，把下面的 prompt 交给它：

```text
从本地源码仓库 <NOEMALOOM_REPO> 安装 NoemaLoom。

对于 Hermes，优先使用 <NOEMALOOM_REPO>/hermes-plugin/noemaloom 中的原生 plugin。除非用户明确要求 MCP 兼容模式，否则不要单独添加 Hermes MCP server entry。

先选择安装范围，并严格区分两种范围。

用户级安装：
- 当这个用户账号下的 Hermes sessions 需要在多个项目中使用 NoemaLoom 时，使用用户级安装。
- 验证或安装 Node.js 20+、Python 3.11+，并在 <NOEMALOOM_REPO> 中运行 `npm ci --include=dev` 安装 npm 依赖。
- 通过 symlink 或 clean-copy，把 <NOEMALOOM_REPO>/hermes-plugin/noemaloom 安装到 `${HERMES_HOME:-$HOME/.hermes}/plugins/noemaloom`。
- 如果使用复制而不是 symlink，在启动 Hermes 前设置 `NOEMALOOM_REPO=<NOEMALOOM_REPO>`。
- 使用 `hermes plugins enable noemaloom` 启用插件，启动新 session 或重启 gateway；需要工作流指导时加载 `skill_view(name="noemaloom:usage")`。

项目级安装：
- 当当前项目需要声明 agent 必须使用 NoemaLoom，但不改变用户范围的 agent 默认配置时，使用项目级安装。
- 把插件安装到 `<target-project>/.hermes/plugins/noemaloom`，并从 `<target-project>` 启动 Hermes，同时设置 `HERMES_ENABLE_PROJECT_PLUGINS=true`。
- 注意 standalone project plugin 仍需要当前 `$HERMES_HOME/config.yaml` 中的 `plugins.enabled` allow-list，除非本次运行刻意使用 project-local `HERMES_HOME`。
- 添加项目说明，例如 `AGENTS.md` 的 NoemaLoom 小节，要求 agent 加载 `skill_view(name="noemaloom:usage")`，并只使用 5 个公开工具。

兼容 MCP 安装：
- 只在 Codex 或其他仅支持 MCP 的客户端中使用。
- 验证或建立一种用户本地方式，让 `noemaloom` 命令从 <NOEMALOOM_REPO> 运行。不要假设已经存在发布到 npm 的包。
- 添加 MCP server entry，command 使用 `noemaloom`，args 使用 `["serve", "--mcp"]`。

规则：
- 不要安装 Git hooks，不要 patch agent cache，不要暴露原始后端工具，也不要修改无关文件。
- 修改任何用户级 agent 配置之前，先展示准确的目标文件和 diff。
- 通过 `hermes plugins list`、fresh plugin loader smoke 验证结果，然后在目标项目中调用 `nl_status`。
```

## 推荐智能体工作流

1. 加载 `skill_view(name="noemaloom:usage")` 和相关 bundled reference workflow。
2. 调用 `nl_status` 检查索引状态和安全标志。
3. 当索引缺失或过期时，调用 `nl_refresh`，使用 `target="all"` 和 `mode="safe"`。
4. 针对任务目标调用 `nl_prepare_context`。
5. 代码或 API 变更前调用 `nl_plan_change`。
6. 由智能体使用原生文件编辑工具修改文件。
7. 调用 `nl_verify_task` 检查旧术语残留、断链、过期 anchor、未同步文档和 mismatch。
8. 覆盖验证通过后，调用 `nl_refresh`，使用 `target="changed"` 和 `mode="safe"`。

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

## 文档

- [Architecture](docs/architecture.md)
- [MCP tools](docs/mcp-tools.md)
- [Data model](docs/data-model.md)
- [Indexing](docs/indexing.md)
- [Locating](docs/locating.md)
- [Safety](docs/safety.md)
- [Troubleshooting](docs/troubleshooting.md)
