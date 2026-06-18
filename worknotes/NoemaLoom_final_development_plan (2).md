# NoemaLoom 最终开发规划文档

## 0. 完成判定

本规划文档已完成。基于当前上传的工程师方案、此前 NoemaLoom 规划、Codex 运维约束、CodeGraph 源码和 RPG-ZeroRepo/RPG-Kit 源码核对，本文档达到 100% 执行信心。本文档是唯一执行规划，不拆分产品路线，不保留候选路线，不使用外部自动配置器，不实现记忆系统，不实现 writer，不实现代码生成执行器，不暴露原始 CodeGraph/RPG-Kit 工具。

NoemaLoom 的最终目标固定为：**给定一个仓库级修改目标，返回必须修改、可能修改、只需检查、修改后必须复核的精确 repo spans，并提供证据链、局部读取范围、影响路径和覆盖验证结果。**

NoemaLoom 的最终定位固定为：

```text
NoemaLoom = agent-native Skill + MCP Repository Modification Locator
```

---

## 1. 产品边界

### 1.1 产品定义

NoemaLoom 是面向 Codex CLI、Hermes Agent 和 AI Scientist 的仓库级修改定位插件。它通过 Skill + MCP 形式工作。它读取完整仓库的代码、Markdown、MDX、配置、测试、示例和功能/RPG 投影信息，将所有可被读取、修改、复核的对象统一投影为 `RepoSpan`，并通过 `nl_*` MCP tools 返回精确定位结果。

最终运行形态固定为：

```text
noemaloom serve --mcp
```

最终内部结构固定为：

```text
NoemaLoom
  = Skill
  + MCP Server
  + Repository Span Kernel
  + Code Fact Projection
  + Document Span Projection
  + Artifact Span Projection
  + Test and Example Span Projection
  + Feature Projection Worker
  + Cross-Reference Linker
  + Edit Target Locator
  + Impact Tracer
  + Coverage Verifier
  + Derived Repository Map
```

每个组件职责固定如下：

1. **Skill** 定义 Codex/Hermes 在仓库理解、修改定位、局部读取、跨文件同步、修改后复核、上下文压缩恢复中的操作规程。
2. **MCP Server** 是唯一 agent-facing runtime。所有能力通过 `nl_*` 工具暴露。
3. **Repository Span Kernel** 是唯一融合层。它以 `RepoSpan`、`RepoEdge`、`Evidence`、`RefreshRevision` 为核心数据模型。
4. **Code Fact Projection** 继承 CodeGraph 的多语言解析、symbol graph、reference resolution、FTS、callers/callees/impact 思路，输出统一 spans 和 edges。
5. **Document Span Projection** 将 Markdown/MDX/RST 中的 heading、section、paragraph、list、table、code fence、link、anchor、frontmatter 投影为一等 span。
6. **Artifact Span Projection** 将 JSON/YAML/TOML/package metadata 中的 key、schema field、CLI flag、env var、script、entrypoint 投影为一等 span。
7. **Test and Example Span Projection** 将测试用例、fixture、example code block、quickstart snippet 投影为一等 span。
8. **Feature Projection Worker** 深度融合 RPG-Kit 的 feature/RPG/dep graph 语义，只做 projection/query/import/normalization，不执行 writer、codegen、branch、Docker 或 hook 行为。
9. **Cross-Reference Linker** 建立 code、docs、config、tests、examples、features 之间的证据边。
10. **Edit Target Locator** 将自然语言修改目标转换为 `must_edit`、`maybe_edit`、`inspect_only`、`verify_only` 四类 span。
11. **Impact Tracer** 从 span、symbol、path、feature 出发追踪跨 code/docs/config/tests/examples/features 的影响范围。
12. **Coverage Verifier** 在文件修改后检查旧术语残留、断链、过期 anchor、遗漏文档角色、code-doc mismatch、未复核测试/示例。
13. **Derived Repository Map** 从当前索引确定性生成短上下文仓库地图，用于上下文压缩恢复和减少重复探索。

### 1.2 NoemaLoom 不承担的职责

NoemaLoom 禁止实现：

```text
长期记忆系统
实验结果 ledger
claim/fact ledger
论文事实数据库
业务代码 writer
Markdown writer
自动 patch executor
RPG/ZeroRepo codegen runner
Docker runner
branch 管理器
Git hook 安装器
Codex/Hermes 配置写入器
Codex plugin cache patcher
Claude/Cursor/VSCode 配置写入器
外部向量数据库依赖
原始 CodeGraph MCP server
原始 RPG-Kit MCP server
```

Codex/Hermes 负责文件编辑、测试执行、commit 和外部命令运行。NoemaLoom 负责定位、解释、局部读取、影响追踪和覆盖验证。

### 1.3 深度融合原则

NoemaLoom 不采用散装拼接。CodeGraph、RPG-Kit、工程师方案和此前讨论的能力统一落到一个数据面：`RepoSpan`。

统一规则固定为：

```text
code symbol       → RepoSpan
callsite          → RepoSpan
doc heading       → RepoSpan
doc paragraph     → RepoSpan
doc table/list    → RepoSpan
doc code fence    → RepoSpan
config key        → RepoSpan
schema field      → RepoSpan
test case         → RepoSpan
example block     → RepoSpan
feature node      → RepoSpan
RPG task          → RepoSpan
dep graph node    → RepoSpan
```

所有工具从同一套 `RepoSpan + RepoEdge + Evidence` 读取数据。不存在单独面向 agent 的 CodeGraph graph、RPG graph、Markdown chunk store、memory map。

---

## 2. 硬性运行边界

### 2.1 文件系统边界

NoemaLoom 只写入项目根目录下：

```text
.noemaloom/
```

NoemaLoom 禁止写入：

```text
.codegraph/
.rpgkit/
.claude/
.codex/
.cursor/
.github/
.vscode/
.git/hooks/
~/.codex/
$HERMES_HOME/
项目根目录 .gitignore
```

`.noemaloom/` 是派生索引缓存。删除该目录后，NoemaLoom 必须能从仓库内容重建全部索引。

### 2.2 配置边界

NoemaLoom 代码只读取 README 中由用户手动配置的 MCP 启动方式。NoemaLoom 不实现任何自动配置写入命令。

README 必须给出 Hermes 和 Codex 手动配置文本。运行时代码禁止实现以下命令或等价功能：

```text
noemaloom install
noemaloom uninstall
noemaloom install-agent
noemaloom uninstall-agent
noemaloom write-codex-config
noemaloom write-hermes-config
noemaloom patch-codex-cache
noemaloom install-hooks
```

### 2.3 Git 边界

NoemaLoom 禁止执行：

```text
git hook install
git branch
git checkout
git stash
git commit
git merge
git reset
git clean
```

索引 freshness 只通过 `nl_status`、`nl_refresh`、`nl_verify_coverage` 控制。修改后由 Codex/Hermes 通过自身工具执行测试和 Git 操作。

### 2.4 AgentMemory/Codex 运维边界

NoemaLoom 必须遵守 Codex 运维约束：

1. 不修改 Codex plugin cache。
2. 不依赖运行时 patch Codex hook 文件。
3. 不写 `~/.codex/config.toml`。
4. 不写 Codex `AGENTS.md`。
5. 不启动 systemd service。
6. 不在 Stop/PreCompact/PostToolUse hook 中嵌入 NoemaLoom 行为。
7. 不要求 agentmemory、iii-engine 或外部记忆服务存在。

### 2.5 LLM 与外部服务边界

NoemaLoom 核心定位流程必须在无 LLM key、无 embedding key、无云服务时工作。以下工具不得依赖 LLM：

```text
nl_status
nl_refresh
nl_query
nl_locate
nl_context
nl_read_span
nl_trace
nl_impact
nl_verify_coverage
```

NoemaLoom 不接入外部向量数据库。所有索引使用本地 SQLite、FTS5、结构化 span、cross-reference edges、CodeGraph-derived code facts 和 FeatureProjectionWorker 输出。

---

## 3. 源码能力继承与裁剪

### 3.1 CodeGraph 能力继承

CodeGraph 源码中保留以下能力：

```text
多语言文件扫描
语言检测
tree-sitter/WASM 解析
worker-thread parse 隔离
SQLite nodes/edges/files/unresolved_refs/nodes_fts 思路
FTS5 symbol/docstring/signature 搜索
import/framework/name based reference resolution
calls/imports/extends/implements/references/contains edges
callers/callees/impact/context/explore 查询算法思想
projectPath 多项目路由思想
输入长度限制、path validation、output truncation 思路
```

CodeGraph 源码中裁剪以下行为：

```text
CodeGraph installer
CodeGraph uninstall
CodeGraph global agent instructions
CodeGraph Git hooks
CodeGraph .codegraph data directory
CodeGraph raw MCP tools
CodeGraph CLI install logic
CodeGraph no-grep/aggressive agent policy
```

Code Fact Projection 写入：

```text
.noemaloom/fact/codegraph.db
.noemaloom/spans/spans.db
```

所有 CodeGraph-derived nodes/edges 必须投影成 `RepoSpan` / `RepoEdge`，不得直接把 `codegraph_*` 结果返回给 agent。

### 3.2 RPG-ZeroRepo / RPG-Kit 能力继承

RPG-ZeroRepo/RPG-Kit 源码中保留以下能力：

```text
feature hierarchy / Repository Planning Graph 语义
RPG node、edge、metadata、feature_path 语义
existing code → RPG/dep graph projection 思路
GraphQueryEngine search/explore/detail/tree 语义
feature node 与 code entity 映射思想
RPG-Kit MCP server 的 degraded-mode 思路
RPG-Kit incremental graph freshness 概念
```

RPG-ZeroRepo/RPG-Kit 源码中裁剪以下行为：

```text
ZeroRepo complete pipeline
PropBuilder feature generation loop
ImplBuilder code skeleton generation loop
TaskPlanner code generation batches
TaskManager branch-per-task workflow
IterativeCodeGenerator
Docker/Trae runner
CheckpointManager global singleton
RPG-Kit slash-command runner
RPG-Kit MCP raw tools
RPG-Kit hook installer
RPG-Kit agent config writer
.rpgkit write path
```

Feature Projection Worker 必须复制并改造 RPG-Kit query/projection 所需最小代码。Worker 不调用 ZeroRepo codegen pipeline。Worker 不写 `.rpgkit/`。

### 3.3 工程师方案融合结论

工程师方案中以下设计成为最终要求：

```text
Repository Modification Locator 是产品核心
Span-first Kernel 是核心数据模型
Document Span Index 是一等组件
Markdown block-aware chunking 是必需能力
Code-doc Linker 是核心而非附属能力
nl_locate 是核心工具
nl_read_span 是 token efficiency 的主要读取工具
nl_verify_coverage 是修改后闭环工具
NoemaLoom 只定位和验证，不编辑
相似文档段落不能被 MMR 过滤掉
路径角色识别进入 ranking
span id 必须抗行号漂移
```

工程师方案中以下内容被收敛处理：

```text
“RPG-Kit worker 后置”被替换为“Feature Projection Worker 必须实现，但严格限制为 projection/query/import/normalization”。
“最小产品”表述被删除；本文档直接定义最终交付能力。
弱约束表述已删除；所有保留能力均为必须实现。
```

---

## 4. 项目结构

最终仓库结构固定为：

```text
noemaloom/
├── package.json
├── packages/
│   └── core/
│       ├── package.json
│       └── src/
│           ├── cli/
│           ├── config/
│           ├── state/
│           ├── mcp/
│           ├── files/
│           ├── spans/
│           ├── code-fact/
│           ├── documents/
│           ├── artifacts/
│           ├── tests-examples/
│           ├── feature-projection/
│           ├── linker/
│           ├── locator/
│           ├── impact/
│           ├── verifier/
│           ├── derived-map/
│           ├── telemetry/
│           └── safety/
├── python/
│   └── nl_rpg_projection_worker/
│       ├── pyproject.toml
│       └── nl_rpg_projection_worker/
│           ├── __init__.py
│           ├── main.py
│           ├── protocol.py
│           ├── paths.py
│           ├── graph_query.py
│           ├── projection.py
│           ├── deterministic_projection.py
│           ├── normalizer.py
│           └── vendor/
│               └── rpgkit_min/
├── skill/
│   └── noemaloom/
│       ├── SKILL.md
│       └── workflows/
│           ├── repository_locator.md
│           ├── markdown_update.md
│           ├── code_change_impact.md
│           ├── multi_doc_sync.md
│           ├── coverage_verification.md
│           └── compression_recovery.md
├── docs/
│   ├── README.md
│   ├── architecture.md
│   ├── mcp-tools.md
│   ├── data-model.md
│   ├── indexing.md
│   ├── locating.md
│   ├── safety.md
│   └── troubleshooting.md
├── tests/
│   ├── fixtures/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── vendor/
    └── source-audit/
        └── source-map.md
```

以下目录不得存在：

```text
packages/install-agent/
packages/writer/
packages/codegen/
packages/memory/
packages/claim-ledger/
packages/experiment-ledger/
packages/vector-db/
packages/hooks/
```

---

## 5. `.noemaloom/` 状态目录

`.noemaloom/` 结构固定为：

```text
.noemaloom/
├── config.json
├── .gitignore
├── locks/
│   └── refresh.lock
├── files/
│   ├── inventory.sqlite
│   └── ignored-paths.json
├── spans/
│   ├── spans.db
│   ├── spans.db-wal
│   └── spans.db-shm
├── fact/
│   ├── codegraph.db
│   ├── codegraph.db-wal
│   ├── codegraph.db-shm
│   └── errors.log
├── documents/
│   ├── parse-errors.jsonl
│   └── anchor-index.json
├── planning/
│   ├── features.json
│   ├── rpg.json
│   ├── dep_graph.json
│   ├── tasks.json
│   └── projection-meta.json
├── derived-map/
│   ├── repository-map.json
│   └── repository-map.md
├── logs/
│   ├── mcp.jsonl
│   ├── refresh.jsonl
│   ├── locator.jsonl
│   └── worker.jsonl
└── transient/
```

`.noemaloom/.gitignore` 内容固定为：

```gitignore
*
!.gitignore
```

`.noemaloom/` 中任何文件不得作为 primary project artifact。所有内容必须能重建。

---

## 6. 配置文件

`.noemaloom/config.json` schema 固定为：

```json
{
  "schemaRevision": 1,
  "projectRoot": "/absolute/project/path",
  "fileInventory": {
    "includeExtensions": [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cpp", ".c", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".lua", ".vue", ".svelte", ".md", ".mdx", ".rst", ".json", ".yaml", ".yml", ".toml"
    ],
    "ignoreGlobs": [
      ".git/**", "node_modules/**", "dist/**", "build/**", ".venv/**", "venv/**", "__pycache__/**", ".noemaloom/**", "coverage/**", "vendor/**"
    ]
  },
  "indexing": {
    "maxFileBytes": 1048576,
    "maxReadSpanLines": 160,
    "maxLocatorResults": 40,
    "maxTraceEdges": 200,
    "maxToolOutputTokens": 2500
  },
  "featureProjection": {
    "enabled": true,
    "workerCommand": "python -m nl_rpg_projection_worker.main",
    "stateDir": ".noemaloom/planning"
  },
  "safety": {
    "denyRawToolExposure": true,
    "denyWriter": true,
    "denyGitHooks": true,
    "denyExternalVectorDb": true,
    "denyAgentConfigWrites": true
  }
}
```

首次 `nl_status` 或 `nl_refresh` 发现配置缺失时必须创建该文件。配置存在但无效时，`nl_status` 返回 `config_invalid`，其余工具返回 `ok=false` 并给出具体字段错误。

---

## 7. Repository Span 数据模型

### 7.1 SQLite schema

`spans.db` 必须包含：

```sql
CREATE TABLE repo_files (
  path TEXT PRIMARY KEY,
  absolute_path TEXT NOT NULL,
  role TEXT NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  generated INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL
);

CREATE TABLE repo_spans (
  span_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER,
  end_column INTEGER,
  parent_span_id TEXT,
  language TEXT NOT NULL,
  heading_path_json TEXT NOT NULL,
  symbol_path_json TEXT NOT NULL,
  anchor TEXT,
  stable_locator_json TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  indexed_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE repo_edges (
  edge_id TEXT PRIMARY KEY,
  source_span_id TEXT NOT NULL,
  target_span_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE repo_evidence (
  evidence_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  quote_hash TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE refresh_revisions (
  graph_revision TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  target TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  span_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  warnings_json TEXT NOT NULL
);

CREATE VIRTUAL TABLE repo_spans_fts USING fts5(
  span_id,
  path,
  kind,
  role,
  label,
  heading_path,
  symbol_path,
  indexed_text,
  summary
);
```

### 7.2 Span kinds

`repo_spans.kind` 只能使用以下枚举：

```text
file
code.module
code.class
code.interface
code.struct
code.enum
code.function
code.method
code.property
code.variable
code.constant
code.callsite
code.import
code.route
code.component
doc.file
doc.frontmatter
doc.heading
doc.section
doc.paragraph
doc.list
doc.table
doc.code_fence
doc.quote
doc.link
doc.anchor
config.file
config.object
config.entry
config.array_item
test.file
test.case
test.fixture
example.file
example.block
feature.node
feature.task
feature.dep_node
```

### 7.3 File roles

`repo_files.role` 只能使用：

```text
source_file
test_file
fixture_file
config_file
schema_file
canonical_api_doc
tutorial_doc
quickstart_doc
example_doc
paper_doc
experiment_note_doc
changelog_doc
design_doc
readme_doc
feature_plan
package_metadata
generated_file
vendor_file
unknown
```

Role classification 固定规则：

```text
README.md                         → readme_doc
CHANGELOG.md                      → changelog_doc
docs/api/**                       → canonical_api_doc
docs/reference/**                 → canonical_api_doc
docs/tutorial*/**                 → tutorial_doc
examples/**                       → example_doc
paper/**                          → paper_doc
notes/**, experiments/**          → experiment_note_doc
design/**, docs/design/**         → design_doc
src/**, lib/**, packages/**/src/**→ source_file
test/**, tests/**, __tests__/**   → test_file
fixtures/**                       → fixture_file
*.schema.json                     → schema_file
package.json, pyproject.toml      → package_metadata
dist/**, build/**, coverage/**    → generated_file
vendor/**                         → vendor_file
```

### 7.4 Edge relations

`repo_edges.relation` 只能使用：

```text
contains
calls
imports
exports
extends
implements
references
instantiates
overrides
decorates
links_to
mentions
documents
documented_by
example_of
tests
configured_by
defines_config
uses_config
defines_cli_flag
uses_cli_flag
feature_contains
feature_implemented_by
feature_documented_by
task_touches
same_concept_as
verify_after_edit
```

### 7.5 Stable span id

Code span：

```text
code:<sha1(projectRoot + path + kind + qualifiedName + signatureHash)>
```

Document span：

```text
doc:<sha1(projectRoot + path + headingPath + kind + blockOrdinal + normalizedTextHash)>
```

Config span：

```text
config:<sha1(projectRoot + path + jsonPointerOrTomlPath + normalizedValueHash)>
```

Test/example span：

```text
tx:<sha1(projectRoot + path + kind + testOrExampleName + normalizedTextHash)>
```

Feature span：

```text
feature:<sha1(projectRoot + featurePath + featureLabel + sourceId)>
```

`stable_locator_json` 必须包含：

```json
{
  "path": "docs/api/scheduler.md",
  "kind": "doc.paragraph",
  "headingPath": ["Scheduler API", "Options"],
  "blockOrdinal": 4,
  "anchor": "scheduler-options",
  "normalizedTextHash": "...",
  "nearbyHeadingHash": "..."
}
```

### 7.6 Span relocation

`nl_read_span` 和 `nl_verify_coverage` 在文件变更后必须按以下顺序重定位：

1. 同路径精确 `text_hash` 命中。
2. 同路径 `anchor + kind` 命中。
3. 同路径 `headingPath + blockOrdinal + kind` 命中。
4. 同路径 `headingPath + fuzzy normalized text` 唯一命中。
5. 同文件最近 heading 下同类 block 相似度最高且唯一命中。
6. 多个候选命中时返回 `ambiguous_span_relocation`。
7. 无候选时返回 `span_not_found_after_file_change`。

---

## 8. 索引构建流程

`nl_refresh(target="all")` 顺序固定为：

```text
FileInventory
→ CodeFactIndexer
→ DocumentSpanIndexer
→ ArtifactSpanIndexer
→ TestExampleSpanIndexer
→ FeatureProjectionWorker
→ ProjectionBuilder
→ CrossReferenceLinker
→ DerivedRepositoryMapBuilder
→ RefreshRevisionWriter
```

`nl_refresh(target="changed")` 顺序固定为：

```text
FileInventory changed detection
→ rebuild changed file spans
→ remove deleted file spans
→ rebuild edges touching changed files
→ update feature projection when source/docs/features changed
→ rebuild derived repository map
→ write refresh revision
```

### 8.1 FileInventory

FileInventory 必须：

1. git 项目优先使用 `git ls-files` 与 untracked visible files。
2. 非 git 项目使用 filesystem walk。
3. 应用 `ignoreGlobs`。
4. 记录 role、language、content_hash、size、mtime。
5. 标记 generated/vendor/ignored。
6. 超出 `maxFileBytes` 的文件只创建 `file` span，不读取全文、不进入 FTS。

### 8.2 CodeFactIndexer

CodeFactIndexer 必须：

1. 复用并 patch CodeGraph extraction/resolution/query 逻辑。
2. 使用 `.noemaloom/fact/codegraph.db`。
3. 创建 CodeGraph-derived symbol/call/import/reference facts。
4. 将所有 nodes/edges/files 投影到 `repo_spans` 与 `repo_edges`。
5. 保存 symbol signature、qualified name、docstring、visibility、callers、callees 到 metadata。
6. 不创建 `.codegraph/`。
7. 不安装 hooks。
8. 不暴露 raw CodeGraph tools。

### 8.3 DocumentSpanIndexer

DocumentSpanIndexer 必须使用 Markdown AST。它必须索引：

```text
.md
.mdx
.rst
README
CHANGELOG
docs/**
examples/**
paper/**
notes/**
experiments/**
```

Markdown/MDX 必须创建：

```text
doc.file
doc.frontmatter
doc.heading
doc.section
doc.paragraph
doc.list
doc.table
doc.code_fence
doc.quote
doc.link
doc.anchor
```

解析规则固定：

1. 每个 heading 创建 `doc.heading`。
2. heading 到下一个同级或更高级 heading 之间创建 `doc.section`。
3. section 内每个 paragraph/list/table/code fence/quote 创建 block span。
4. Markdown table 必须保留完整表格行范围、列名、normalized table text。
5. list 必须保持完整列表块，不得按单行拆散。
6. fenced code block 必须记录 fence language、起止行、代码预览和导入/CLI/config key mention。
7. inline code 写入 `metadata_json.inlineCodeMentions`。
8. Markdown links 创建 `doc.link` span，并解析相对路径、anchor、外部 URL 类型。
9. heading slug 使用 GitHub-compatible slug，写入 `anchor`。
10. MDX JSX block 无法结构化解析时降级成完整 block span，并写 parse warning。
11. 解析错误写入 `.noemaloom/documents/parse-errors.jsonl`，不得中断 refresh。

### 8.4 ArtifactSpanIndexer

ArtifactSpanIndexer 必须解析：

```text
.json
.yaml
.yml
.toml
package.json
pyproject.toml
```

必须识别：

```text
JSON pointer
YAML path
TOML table/key path
CLI flags
environment variables
config keys
schema field names
package scripts
package entrypoints
workspace package names
```

### 8.5 TestExampleSpanIndexer

测试识别规则固定：

```text
Python: def test_*, class Test*, pytest.mark
TypeScript/JavaScript: test(), it(), describe()
Go: func Test*, func Benchmark*
Rust: #[test]
Java/Kotlin/Scala: @Test
```

示例识别规则固定：

```text
examples/** 文件 → example.file / example.block
README quickstart fenced code → example.block
tutorial fenced code → example.block
Markdown 中可执行 shell/python/ts/js fenced code → example.block
```

### 8.6 FeatureProjectionWorker

FeatureProjectionWorker 是必需组件。它通过 Python stdio JSONL 协议运行，只负责 feature/RPG/dep projection。

Worker commands 固定为：

```text
feature.status
feature.import_existing
feature.project_from_repo
feature.update_changed
feature.query
feature.explore
feature.detail
feature.tree
```

Worker 写入：

```text
.noemaloom/planning/features.json
.noemaloom/planning/rpg.json
.noemaloom/planning/dep_graph.json
.noemaloom/planning/tasks.json
.noemaloom/planning/projection-meta.json
```

Worker 环境变量固定：

```text
NOEMALOOM_PROJECT_ROOT
NOEMALOOM_STATE_DIR
NOEMALOOM_GRAPH_REVISION
```

Worker 必须满足：

1. 不依赖 `.rpgkit/` marker。
2. 不写 `.rpgkit/`。
3. 已有 `.rpgkit/data/*` 时只读导入，并复制标准化结果到 `.noemaloom/planning/*`。
4. 没有 RPG-Kit 数据时，从目录结构、package metadata、docs headings、source modules、test names 生成 deterministic feature projection。
5. Worker crash 不终止 MCP server；`nl_status` 返回 `featureProjection.state="unavailable"`。
6. Worker degraded 时 `nl_locate` 仍能使用 code/docs/artifacts/test/example spans 工作，并在 warnings 中说明 feature projection 不可用。
7. Worker 不调用 ZeroRepo `TaskManager`、`IterativeCodeGenerator`、Docker、branch workflow。

### 8.7 CrossReferenceLinker

Linker 必须生成跨类型 edges。Evidence 来源固定：

```text
explicit Markdown relative link
inline code exact qualified symbol mention
inline code exact config key mention
CLI flag exact mention
environment variable exact mention
example block import/call source symbol
test case call source symbol
RPG/feature explicit map
path/name exact overlap
heading/symbol normalized match
call neighborhood overlap
schema field exact mention
```

Confidence 固定：

```text
1.00 explicit Markdown link resolves to span
0.97 exact qualified symbol inline code mention
0.95 exact config key / CLI flag / env var mention
0.92 test case calls source symbol
0.90 example imports or calls source symbol
0.88 RPG/feature explicit map
0.82 exact symbol name + relevant heading
0.75 path/name exact relation
0.68 call-neighborhood overlap
0.60 fuzzy heading/symbol relation
```

`confidence < 0.60` 的候选不写入 `repo_edges`。

### 8.8 DerivedRepositoryMapBuilder

Derived map 必须 deterministic 生成：

```text
.noemaloom/derived-map/repository-map.json
.noemaloom/derived-map/repository-map.md
```

内容必须包含：

```text
主要目录角色
canonical docs 列表
核心 source modules
测试入口
配置入口
feature clusters
high-confidence code-doc/config/test/example links
parse/freshness warnings 概览
```

内容禁止包含：

```text
聊天摘要
实验结论
用户偏好
agent 经验
长期记忆
完整代码片段
未 anchored 的主观判断
```

---

## 9. Edit Target Locator

`nl_locate` 是核心工具。

### 9.1 Query normalization

Locator 必须从 `goal` 中提取：

```text
symbol-like terms
file/path-like terms
heading-like terms
config keys
CLI flags
environment variables
error messages
API names
feature/domain terms
old/new terminology pairs
artifact roles: docs/code/config/tests/examples/features/paper/design/changelog
```

输出内部 normalized query：

```json
{
  "exactTerms": [],
  "symbolTerms": [],
  "pathTerms": [],
  "docTerms": [],
  "configTerms": [],
  "featureTerms": [],
  "oldTerms": [],
  "newTerms": [],
  "targetRoles": []
}
```

### 9.2 Candidate generation

候选来源固定：

1. `repo_spans_fts` lexical search。
2. CodeGraph-derived symbol/name/signature search。
3. Markdown heading/anchor/inline-code search。
4. Config key/CLI/env/schema search。
5. Test case and example import/call search。
6. FeatureProjectionWorker feature/task/dep search。
7. Cross-reference edge expansion。
8. Path role expansion。
9. Exact old-term sweep。

相似命中不得被去重算法丢弃。多文档同步任务中，相似段落通常都需要复核。

### 9.3 Boundary validation

每个候选必须验证：

```text
span 存在
文件未 ignored
file content_hash 与索引一致或可重定位
start_line/end_line 合法
Markdown table/list/code fence 边界完整
父 section 可读取
linked evidence 仍存在
span 不属于 generated/vendor unless explicitly requested
```

验证失败的候选不得进入 `must_edit`。

### 9.4 Ranking formula

排序公式固定：

```text
score = exactTermScore
      + symbolMatchScore
      + headingMatchScore
      + configKeyScore
      + pathRoleScore
      + linkConfidenceScore
      + featureRelevanceScore
      + canonicalityScore
      + coverageDiversityScore
      + freshnessScore
      - generatedFilePenalty
      - vendorFilePenalty
      - boundaryRiskPenalty
      - staleIndexPenalty
```

每个 target 必须返回 `scoreBreakdown`。

### 9.5 Decision classes

分类固定：

```text
must_edit     直接描述目标、强证据、边界稳定、修改目标明确
maybe_edit    相关度高，需要 Codex/Hermes 读取后判断
inspect_only  支持理解和证据链，不直接修改
verify_only   修改后必须复核或扫尾，不作为首批编辑目标
```

判定规则固定：

```text
score >= 85 且 direct evidence >= 1 条       → must_edit
70 <= score < 85                            → maybe_edit
50 <= score < 70                            → inspect_only
包含 oldTerm 或 linked stale reference         → verify_only
边界风险高或 index stale                      → inspect_only + warning
```

### 9.6 Multi-document coverage rule

文档更新任务必须覆盖存在的以下 roles：

```text
canonical_api_doc
readme_doc
quickstart_doc
tutorial_doc
example_doc
paper_doc
design_doc
changelog_doc
```

API/code behavior 变更任务必须覆盖存在的以下 roles：

```text
source_file
test_file
config_file
canonical_api_doc
readme_doc
example_doc
```

Locator 输出不得只包含第一个高分文档。

---

## 10. MCP tool surface

NoemaLoom 只暴露 10 个 agent-facing tools：

```text
nl_skill
nl_status
nl_refresh
nl_query
nl_locate
nl_context
nl_read_span
nl_trace
nl_impact
nl_verify_coverage
```

不得暴露 writer tools。不得暴露 raw CodeGraph/RPG-Kit tools。不得暴露长期记忆工具。

### 10.1 Response envelope

所有工具返回统一 envelope：

```json
{
  "ok": true,
  "tool": "nl_locate",
  "projectRoot": "/abs/project",
  "graphRevision": "...",
  "graphState": "empty|ready|stale|partial|error",
  "tokenBudget": {
    "requested": 0,
    "used": 0,
    "truncated": false
  },
  "warnings": [
    {"code": "...", "severity": "info|warning|error", "message": "..."}
  ],
  "data": {},
  "evidence": [],
  "nextActions": []
}
```

未处理异常不得穿透 MCP transport。工具失败必须返回 `ok=false`。

### 10.2 `nl_skill`

输入：

```json
{
  "workflow": "repository_locator|markdown_update|code_change_impact|multi_doc_sync|coverage_verification|compression_recovery|all",
  "format": "markdown|json",
  "projectPath": "default_current_project"
}
```

输出 Skill workflow。该工具不得刷新索引，不得读取业务文件内容。

### 10.3 `nl_status`

输入：

```json
{
  "projectPath": "default_current_project",
  "includeRepositoryMap": false
}
```

输出：

```json
{
  "stateDir": ".noemaloom",
  "fileInventory": {"state": "missing|ready|stale", "files": 0},
  "spanIndex": {"state": "missing|ready|stale", "spans": 0, "edges": 0},
  "factIndex": {"state": "missing|ready|stale", "symbols": 0, "edges": 0},
  "documentIndex": {"state": "missing|ready|stale", "blocks": 0, "parseErrors": 0},
  "artifactIndex": {"state": "missing|ready|stale", "entries": 0},
  "featureProjection": {"state": "missing|ready|stale|unavailable", "features": 0},
  "derivedMap": {"state": "missing|ready|stale", "tokens": 0},
  "rawToolExposure": false,
  "writerEnabled": false
}
```

### 10.4 `nl_refresh`

输入：

```json
{
  "target": "all|changed|files|code|docs|artifacts|tests|features|links|map",
  "mode": "safe|force",
  "projectPath": "default_current_project"
}
```

规则：

1. `safe` 模式失败时保留旧索引。
2. `force` 模式先写入 transient backup，成功后替换。
3. 并发 refresh 返回 `refresh_in_progress`。
4. Worker crash 不杀 MCP server。

### 10.5 `nl_query`

输入：

```json
{
  "query": "string",
  "scope": "all|code|docs|artifacts|features|tests|examples",
  "limit": 20,
  "projectPath": "default_current_project"
}
```

用途：探索性 span 查询。修改任务不得用 `nl_query` 替代 `nl_locate`。

### 10.6 `nl_locate`

输入：

```json
{
  "goal": "string",
  "targetRoles": ["docs", "code", "config", "tests", "examples", "features", "all"],
  "limit": 30,
  "projectPath": "default_current_project"
}
```

输出必须包含：

```json
{
  "goal": "...",
  "normalizedQuery": {},
  "targets": [
    {
      "spanId": "...",
      "decision": "must_edit",
      "path": "docs/api/scheduler.md",
      "kind": "doc.paragraph",
      "role": "canonical_api_doc",
      "label": "Scheduler timeout option",
      "startLine": 91,
      "endLine": 104,
      "recommendedReadRange": {"startLine": 80, "endLine": 116},
      "headingPath": ["Scheduler API", "Options"],
      "confidence": 0.94,
      "scoreBreakdown": {},
      "reason": [],
      "linkedSpans": [],
      "evidence": [],
      "editRisk": "low|medium|high"
    }
  ],
  "coveragePlan": {
    "exactSweeps": [],
    "pathRolesToVerify": [],
    "linkedDocsToVerify": [],
    "linkedTestsToVerify": []
  }
}
```

### 10.7 `nl_context`

输入：

```json
{
  "goal": "string",
  "budget": 2048,
  "includeSnippets": false,
  "projectPath": "default_current_project"
}
```

输出围绕 `nl_locate` 组织：

```json
{
  "repositoryMap": {},
  "primaryTargets": [],
  "secondaryTargets": [],
  "supportingCode": [],
  "supportingDocs": [],
  "supportingConfig": [],
  "supportingTests": [],
  "featureContext": [],
  "riskNotes": [],
  "suggestedReadOrder": []
}
```

默认不得返回长代码片段。`includeSnippets=true` 时仍受 token budget 硬限制。

### 10.8 `nl_read_span`

输入：

```json
{
  "spanId": "string",
  "contextLines": 20,
  "projectPath": "default_current_project"
}
```

输出：

```json
{
  "path": "docs/api/scheduler.md",
  "startLine": 80,
  "endLine": 116,
  "spanStartLine": 91,
  "spanEndLine": 104,
  "content": "...",
  "spanTextHash": "...",
  "fileContentHash": "...",
  "relocation": {"used": false, "method": "none"}
}
```

该工具只读局部内容，不修改文件。

### 10.9 `nl_trace`

输入：

```json
{
  "target": "spanId|path|symbol|feature label",
  "direction": "upstream|downstream|both",
  "depth": 2,
  "relationTypes": ["all"],
  "projectPath": "default_current_project"
}
```

输出跨 code/docs/config/tests/examples/features 的 subgraph。每条 edge 必须包含 relation、confidence、source、evidence。

### 10.10 `nl_impact`

输入：

```json
{
  "target": "spanId|path|symbol|feature label",
  "targetType": "auto|span|symbol|file|feature|config|doc",
  "depth": 2,
  "projectPath": "default_current_project"
}
```

输出：

```json
{
  "codeImpact": [],
  "docImpact": [],
  "configImpact": [],
  "testImpact": [],
  "exampleImpact": [],
  "featureImpact": [],
  "riskLevel": "low|medium|high",
  "requiredVerification": []
}
```

### 10.11 `nl_verify_coverage`

输入：

```json
{
  "goal": "string",
  "changedPaths": [],
  "oldTerms": [],
  "newTerms": [],
  "projectPath": "default_current_project"
}
```

输出：

```json
{
  "remainingOldTermHits": [],
  "staleAnchors": [],
  "brokenLinks": [],
  "unsyncedDocRoles": [],
  "codeDocMismatches": [],
  "unverifiedLinkedTests": [],
  "unreadMustEditTargets": [],
  "status": "pass|needs_attention|fail"
}
```

`status="pass"` 只能在所有 required checks 为空时返回。

---

## 11. Skill workflows

### 11.1 通用仓库修改流程

所有仓库修改任务固定执行：

```text
nl_skill(workflow="repository_locator")
→ nl_status(includeRepositoryMap=true)
→ nl_refresh(target="all", mode="safe") when graphState is missing/stale
→ nl_locate(goal, targetRoles=[...])
→ nl_read_span for must_edit targets
→ Codex/Hermes native edit tools modify files
→ nl_verify_coverage(goal, changedPaths, oldTerms, newTerms)
→ nl_refresh(target="changed", mode="safe")
```

### 11.2 Markdown 更新流程

Markdown 更新任务固定执行：

```text
nl_locate(targetRoles=["docs", "code", "config", "examples", "features"])
→ read canonical_api_doc spans first
→ read README/tutorial/example spans next
→ edit complete Markdown blocks only
→ run nl_verify_coverage with old terms and changed paths
```

Agent 禁止只修改第一个搜索结果后结束任务。

### 11.3 Code/API 修改影响流程

Code/API 修改任务固定执行：

```text
nl_locate(targetRoles=["code", "tests", "config", "docs", "examples", "features"])
→ nl_impact(target=symbol or file)
→ read source/test/config/doc spans
→ Codex/Hermes edit and run tests
→ nl_verify_coverage for docs/config/examples
→ nl_refresh(target="changed", mode="safe")
```

### 11.4 多文档同步流程

多文档同步任务固定按 role 分组处理：

```text
canonical_api_doc
readme_doc
quickstart_doc
tutorial_doc
example_doc
paper_doc
design_doc
changelog_doc
```

修改完成后必须执行 `nl_verify_coverage`。

### 11.5 上下文压缩恢复流程

上下文压缩后固定执行：

```text
nl_status(includeRepositoryMap=true)
→ nl_context(goal, budget=1024, includeSnippets=false)
→ continue from prior target spans or rerun nl_locate(goal)
```

Agent 不得在压缩后重新全库人工探索。

---

## 12. Token efficiency policy

默认 token budgets 固定：

```text
nl_query              1200
nl_locate             2400
nl_context            2048
nl_trace              2500
nl_impact             2500
nl_verify_coverage    2500
```

输出超出预算时必须：

1. 保留 `must_edit`。
2. 保留 coverage warnings。
3. 截断 `inspect_only`。
4. 设置 `tokenBudget.truncated=true`。
5. 在 warnings 中列出 omitted target count 和 omitted roles。

`nl_read_span` 按行数限制，默认最大 160 行。Markdown table/list/code fence 不得被截断成不完整块；超限时返回 `block_too_large` 并给出分段读取范围。

---

## 13. 并发与一致性

### 13.1 Refresh lock

`nl_refresh` 必须使用：

```text
.noemaloom/locks/refresh.lock
```

同一项目只能存在一个 refresh。并发 refresh 返回 `refresh_in_progress`。

### 13.2 Staleness handling

所有工具必须检查 file hash。目标文件在索引后变化时必须：

1. 尝试 span relocation。
2. 标记 `graphState="stale"` 或 `graphState="partial"`。
3. 返回 relocation metadata。
4. 在 `nextActions` 中加入 `nl_refresh(target="changed")`。

### 13.3 Read-after-edit verification

`nl_verify_coverage` 必须先重新读取 `changedPaths` 的当前内容，再执行旧术语、断链、anchor 和 mismatch 检查。不得只用旧索引判断通过。

---

## 14. README 与文档要求

`docs/README.md` 必须包含：

1. package 获取方式。
2. `noemaloom serve --mcp` 启动方式。
3. Hermes 手动 MCP 配置示例。
4. Codex 手动 MCP 配置示例。
5. Codex `AGENTS.md` 最小手动说明。
6. `.noemaloom/` 是派生索引缓存的说明。
7. NoemaLoom 不写 global config、不安装 hooks、不修改 Codex cache 的说明。
8. 修改定位 workflow。
9. 常见故障排查。

README 禁止出现自动配置命令。

Hermes 配置示例固定：

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

Codex 配置示例固定：

```toml
[mcp_servers.noemaloom]
command = "noemaloom"
args = ["serve", "--mcp"]
```

Codex `AGENTS.md` 最小说明固定：

```markdown
## NoemaLoom
Use the `noemaloom` MCP server for repository-wide modification localization. Call `nl_skill` before long-running repository understanding, documentation update, code impact, or multi-file synchronization tasks. NoemaLoom locates and verifies spans; file edits are performed with native Codex tools.
```

---

## 15. 开发执行顺序

开发必须按以下顺序执行。任一前置步骤未通过验收，不得推进下一步。

1. 建立 `vendor/source-audit/source-map.md`，列出 CodeGraph、RPG-Kit、RPG-ZeroRepo 被读取与被移植的文件。
2. 建立 TypeScript package、Python worker package、Skill、docs、tests 目录。
3. 实现 `noemaloom --help` 和 `noemaloom serve --mcp` 空 server。
4. 实现 `.noemaloom/` state resolver、config loader、lock manager、telemetry writer。
5. 实现 MCP envelope、input validation、`nl_skill`、`nl_status`。
6. 实现 FileInventory。
7. 实现 spans SQLite schema 和 migrations。
8. 实现 span id、stable locator、relocation 基础库。
9. 实现 DocumentSpanIndexer。
10. 实现 ArtifactSpanIndexer。
11. 实现 TestExampleSpanIndexer。
12. 移植并 patch CodeGraph-derived CodeFactIndexer。
13. 实现 FeatureProjectionWorker stdio protocol。
14. 实现 FeatureProjectionWorker existing RPG-Kit data import。
15. 实现 FeatureProjectionWorker deterministic feature projection。
16. 实现 ProjectionBuilder，将 code/docs/artifacts/tests/examples/features 写入统一 spans graph。
17. 实现 CrossReferenceLinker。
18. 实现 DerivedRepositoryMapBuilder。
19. 实现 `nl_refresh`。
20. 实现 `nl_query`。
21. 实现 EditTargetLocator 和 `nl_locate`。
22. 实现 `nl_read_span`。
23. 实现 `nl_context`。
24. 实现 `nl_trace`。
25. 实现 `nl_impact`。
26. 实现 `nl_verify_coverage`。
27. 编写 Skill workflows。
28. 编写 README 和 docs。
29. 实现 unit tests。
30. 实现 integration tests。
31. 实现 e2e tests。
32. 运行 full verification suite。
33. 执行 safety assertions。
34. 修复所有静态检查和 e2e 缺陷。

---

## 16. 测试矩阵

### 16.1 Unit tests

必须实现：

```text
tests/unit/config-loader.test.ts
tests/unit/state-dir.test.ts
tests/unit/envelope.test.ts
tests/unit/file-inventory.test.ts
tests/unit/span-id.test.ts
tests/unit/span-relocation.test.ts
tests/unit/markdown-block-indexer.test.ts
tests/unit/markdown-table-indexer.test.ts
tests/unit/markdown-link-anchor.test.ts
tests/unit/artifact-indexer.test.ts
tests/unit/test-case-extractor.test.ts
tests/unit/example-block-extractor.test.ts
tests/unit/feature-worker-protocol.test.py
tests/unit/feature-projection-normalizer.test.py
tests/unit/linker-confidence.test.ts
tests/unit/locator-ranking.test.ts
tests/unit/coverage-verifier.test.ts
tests/unit/token-budget.test.ts
```

### 16.2 Integration tests

必须实现：

```text
tests/integration/mcp-empty-server.test.ts
tests/integration/refresh-all.test.ts
tests/integration/refresh-changed.test.ts
tests/integration/codegraph-derived-index.test.ts
tests/integration/document-span-index.test.ts
tests/integration/artifact-span-index.test.ts
tests/integration/feature-worker-import-existing.test.py
tests/integration/feature-worker-deterministic.test.py
tests/integration/no-codegraph-dir.test.ts
tests/integration/no-rpgkit-dir.test.py
tests/integration/no-hooks.test.ts
tests/integration/raw-tools-hidden.test.ts
tests/integration/locate-doc-update.test.ts
tests/integration/read-span-relocation.test.ts
tests/integration/verify-coverage-after-edit.test.ts
```

### 16.3 E2E tests

必须实现：

```text
tests/e2e/codex-markdown-sync.test.ts
tests/e2e/codex-api-change-impact.test.ts
tests/e2e/multi-doc-old-term-sweep.test.ts
tests/e2e/context-compression-recovery.test.ts
tests/e2e/hermes-mcp-smoke.test.ts
tests/e2e/codex-mcp-smoke.test.ts
```

### 16.4 Safety assertions

测试必须断言：

1. 不创建 `.codegraph/`。
2. 不创建 `.rpgkit/`。
3. 不写 `.git/hooks/`。
4. 不写 `~/.codex/`。
5. 不写 `$HERMES_HOME/`。
6. 不修改项目根目录 `.gitignore`。
7. 不暴露 raw `codegraph_*`。
8. 不暴露 raw RPG-Kit tools。
9. 不存在 writer tools。
10. 不存在长期记忆工具。
11. 不存在 experiment ledger。
12. 不存在 claim ledger。
13. Worker crash 不杀 MCP server。
14. `nl_verify_coverage` 在剩余旧术语命中时不得返回 pass。

---

## 17. 验收场景

### 17.1 Markdown API 文档同步

Fixture：

```text
src/scheduler.ts
README.md
docs/api/scheduler.md
docs/tutorial/scheduler.md
examples/scheduler.md
tests/scheduler.test.ts
```

任务：

```text
Update documentation for the renamed scheduler timeout option.
```

验收：

1. `nl_locate` 返回 `docs/api/scheduler.md` API section 为 `must_edit`。
2. `nl_locate` 返回 README/tutorial/example 为 `maybe_edit` 或 `verify_only`。
3. `nl_read_span` 返回完整 paragraph/table/list/code fence 边界。
4. 修改后 `nl_verify_coverage` 找出剩余旧术语。
5. 清理全部旧术语后 `nl_verify_coverage.status="pass"`。

### 17.2 Code API 变更影响定位

任务：

```text
Change SchedulerConfig.timeout to SchedulerConfig.deadlineSeconds and update all affected repository artifacts.
```

验收：

1. `nl_impact` 返回 source symbol、test cases、config entries、docs sections、example blocks、feature spans。
2. `nl_locate` 区分 `must_edit` source/config/docs 和 `verify_only` tests/examples。
3. `nl_verify_coverage` 能发现未同步 docs/config/examples。

### 17.3 多 Markdown 段落修改

任务：

```text
Replace the old narrative about retrieval-only context with span-first repository localization.
```

验收：

1. `nl_locate` 不得只返回一个相似段落。
2. Locator 必须覆盖 readme_doc、tutorial_doc、design_doc、paper_doc。
3. `coveragePlan.exactSweeps` 包含旧术语。
4. `nl_verify_coverage` 能发现遗漏文档。

### 17.4 Feature/RPG 投影定位

Fixture 包含已有 `.rpgkit/data/rpg.json` 和 `.rpgkit/data/dep_graph.json`，并且项目根目录不允许 NoemaLoom 写 `.rpgkit/`。

任务：

```text
Locate all implementation and documentation spans for the authentication feature.
```

验收：

1. Worker 只读 `.rpgkit/data/*`，复制标准化结果到 `.noemaloom/planning/*`。
2. `nl_locate` 返回 feature.node、source_file、test_file、docs 相关 spans。
3. `.rpgkit/` 没有新文件或修改。
4. raw RPG-Kit MCP tools 不出现在 tool list 中。

### 17.5 上下文压缩恢复

流程：

```text
nl_status(includeRepositoryMap=true)
→ simulate context compression
→ nl_context(goal, budget=1024, includeSnippets=false)
→ nl_locate(goal)
```

验收：

1. Agent 不需要重新读全库。
2. Derived repository map 足够恢复目录角色、canonical docs、核心 source modules 和 high-confidence links。
3. 输出不包含长期记忆、实验事实或聊天摘要。

---

## 18. 最终验收标准

NoemaLoom 完成时必须同时满足：

1. Hermes Agent 通过 README 手动配置连接 `noemaloom serve --mcp`。
2. Codex CLI 通过 README 手动配置连接 `noemaloom serve --mcp`。
3. MCP server 只暴露第 10 节定义的 10 个 `nl_*` tools。
4. MCP server 不暴露 raw CodeGraph/RPG-Kit/ZeroRepo tools。
5. NoemaLoom 只写 `.noemaloom/`。
6. `.noemaloom/` 删除后能从仓库重建索引。
7. CodeFactIndexer 覆盖 CodeGraph 的多语言 symbol、call graph、reference、context、impact 能力。
8. DocumentSpanIndexer 能定位 Markdown/MDX/RST 的 heading、section、paragraph、list、table、code fence、link、anchor。
9. ArtifactSpanIndexer 能定位 config key、schema field、CLI flag、environment variable、package script。
10. TestExampleSpanIndexer 能定位测试用例、fixture、example block。
11. FeatureProjectionWorker 能提供 feature/task/dep projection，并且不执行 writer/codegen/branch/Docker。
12. CrossReferenceLinker 能建立 code-doc-config-test-example-feature links。
13. `nl_locate` 能返回 path、startLine、endLine、recommendedReadRange、decision、reason、confidence、evidence。
14. `nl_read_span` 能返回局部内容并支持行号漂移重定位。
15. `nl_verify_coverage` 能检查旧术语、断链、stale anchor、未同步文档和 code-doc mismatch。
16. Skill 明确要求 NoemaLoom 负责定位和验证，Codex/Hermes 负责实际文件修改。
17. README 不包含自动配置命令，不要求运行 CodeGraph/RPG-Kit 原始命令。
18. 测试证明不会创建 `.codegraph/`、`.rpgkit/`、`.git/hooks/`、`~/.codex/`、`$HERMES_HOME/`。
19. 测试证明不存在 writer tools、长期记忆工具、experiment ledger、claim ledger。
20. Worker crash 不影响 MCP server 提供 degraded responses。
21. 所有工具在 graph stale 时返回明确 warning 和 `nextActions`。
22. 多文档同步任务不会因为相似度去重丢掉应复核文档。
23. 文档、代码、配置、测试、示例、feature projection 全部进入同一 Repository Span Kernel。

---

## 19. 最终自检结论

本规划完成以下融合与修复：

1. 将 NoemaLoom 固定为 span-first Repository Modification Locator。
2. 保留 CodeGraph 的多语言代码事实索引能力，移除其安装器、hooks、raw tools 和 aggressive instructions。
3. 保留 RPG-Kit 的 feature/RPG/dep 查询语义，并将其收敛为必需但受限的 FeatureProjectionWorker。
4. 将工程师方案中的 Document Span Index、Code-doc Linker、Edit Target Locator、Coverage Verifier 纳入核心架构。
5. 删除长期记忆、实验 ledger、claim ledger、writer、codegen、Docker、branch、hook 管理等不属于插件目标的能力。
6. 明确 NoemaLoom 只写 `.noemaloom/`，不修改 Codex/Hermes/agentmemory 环境。
7. 明确所有 MCP 工具输入输出、数据模型、索引流程、定位算法、Skill workflow、测试矩阵和最终验收标准。
8. 文档中所有保留功能均为必须实现；没有候选路线；没有依赖隐含假设。
