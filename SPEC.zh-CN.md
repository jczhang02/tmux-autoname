# tmux-autoname v3 规格说明

状态：已确认的实现基线

英文版：[`SPEC.md`](./SPEC.md)

## 1. 目的

tmux-autoname 为 tmux window 生成稳定且有用的名称。它将确定性的终端事实与
AI 生成的任务语义结合起来，同时保留用户手动命名的控制权，且绝不阻塞正常的
终端操作。

语义词汇定义于 [`CONTEXT.md`](./CONTEXT.md)。支持本规格的调研记录见
[`docs/research/naming-landscape.md`](./docs/research/naming-landscape.md) 与
[`docs/research/secret-loading.md`](./docs/research/secret-loading.md)。

## 2. 目标

- 使用 `Scope + Task + Activity` 生成名称。
- AI 是 Task 的唯一生成者；当 Scope 边界存在歧义时，也由 AI 选择 Scope。
- 支持嵌套工作区，例如 session 为 `partjobs`，而活动 pane 位于
  `high-value-patent-rebuild/manuscript`。
- 适用于所有终端程序，不安装也不依赖任何 Agent 专用 extension、hook 或 API。
- tmux 自动执行路径必须静默、非阻塞。
- 用户明确恢复自动模式前，始终保留手动名称。
- 模型、网络、密码管理器或 daemon 失效时，插件仍然可用。

## 3. v3 非目标

- 流式读取 pane 输出，或为每个 session 运行一个 control-mode client。
- 解析 Agent 专用 UI、spinner 或未公开的 transcript 格式。
- 为每一行终端输入或每一条用户 prompt 重新生成 Task。
- popup、TUI、菜单或动态状态提示。
- SQLite、向量检索、embedding 或 prompt 历史数据库。
- 原生 keyring 扩展或公开的 provider/plugin 框架。
- 允许 AI 凭空生成文件系统路径或进程标识。

## 4. 名称模型

```ts
type Scope = {
  workspace: string;
  area?: string;
};

type NameRecord = {
  scope: Scope;
  task: string;
  activity: string;
};
```

各部分职责：

- **Scope**：本地逻辑发现候选项；边界存在歧义时，由 AI 从候选项中选择。
- **Task**：仅由 AI 生成。它描述稳定的用户目标，而不是最近一条命令。
- **Activity**：根据活动 pane 与前台进程在本地确定。
- **Display Profile**：负责渲染 Name Record，不改变语义。

默认 Display Profile：

```text
{activity}:{scope}/{task}
```

`scope` 渲染为 `workspace` 或 `workspace/area`。空字段及其相邻分隔符会被省略。
切换 profile 只重新渲染已有 record，不调用 AI。

Task 始终使用简洁的英文动作短语：由 2 至 5 个小写单词组成，末尾不加标点。

## 5. 运行时与依赖

- TypeScript strict mode。
- 使用 Bun 开发、测试并构建独立可执行文件。
- 使用 Vercel AI SDK 调用不同模型 provider。
- 使用 Zod 校验配置与模型结构化输出。
- 使用一个小型 TPM shell loader 完成安装和 tmux hook 配置。
- 每个 tmux server 运行一个 daemon。
- 使用 `XDG_RUNTIME_DIR` 下的 Unix socket 传递本地事件。
- daemon ping 携带 build identity；launcher 在发送事件前替换旧 build 的 daemon。

正式构建必须关闭 Bun 对 `.env` 与 `bunfig.toml` 的运行时自动加载：

```sh
bun build --compile \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  src/cli.ts \
  --outfile dist/tmux-autoname
```

自动 hook 执行路径不得产生 stdout 或 stderr。诊断信息写入有大小限制的日志，并
通过显式调用的 `explain` 命令展示。

## 6. 架构

```text
tmux hook、有界屏幕监控与 shell 事件
              |
              v
         Window Snapshot
              |
              v
     Scope 与 Activity 候选项
              |
              v
         触发与去重
              |
              v
     AI 选择 Scope + 生成 Task
              |
              v
 revision/manual/schema 接受门禁
              |
              v
         Display Profile
              |
              v
       tmux rename-window
```

daemon 内部封装事件合并、snapshot 收集、进程检查、候选项生成、模型调用、
revision 防陈旧结果、手动所有权、渲染、凭据缓存和 tmux 写入。

实现使用 tmux hook、可选 shell 事件和低频监控。轻量的进程/路径信号覆盖所有
pane，使非活动 window 在 daemon 启动和进程变化后也能收敛；只有已连接 client
当前可见的 pane 会被抓取渲染文本。屏幕在 settle 时段内保持不变后，运行时为
一次推理最多抓取 50 行、8 KiB。实现不使用 tmux control mode，不流式读取 pane
输出，也不安装 Agent extension。

## 7. 证据优先级

证据按以下顺序使用：

1. 显式设置的 Manual Name。
2. 稳定后活动 pane 中有范围限制的渲染文本。
3. 可获取时，带有 cwd 与退出状态的 shell 命令生命周期事件。
4. tmux、进程、git 与路径元数据。
5. 作为低置信度提示的 pane title。

Activity 由活动 pane 决定。其他 pane 可以提供 Scope 与 Task 的辅助证据，但不能
独立重命名整个 window。

模型请求不会发送环境变量、git diff、完整 scrollback、命令参数或不受限制的
输出。终端证据最多 50 行、8 KiB；发送前会删除控制字符，并对常见凭据格式做
尽力而为的脱敏。它只保存在内存中，绝不持久化或写入日志。任意终端文本不可能
被正则完全脱敏，因此配置 AI provider 同时也是用户对路由和隐私的明确选择。

## 8. Scope 候选项生成

本地逻辑从以下信息生成候选项：

- 可获取时，使用 tmux session 的创建目录或起始目录；
- 活动 pane 和辅助 pane 的 cwd；
- git/worktree root；
- 远程主机身份；
- 稳定的公共祖先目录。

当 session 起始目录的 basename 与 session name 一致，且该目录包含活动 cwd 时，
它才被信任为 Workspace。这样可保留 `sesh` 创建的 `partjobs` 等项目容器。否则，
优先使用活动 pane 的 Git/worktree root，避免通用的 `$HOME` session path 产生
`project/dev/project`。session name 与原始 cwd 仍只是证据，不会自动成为 Scope。

每个候选项都包含不透明 ID、label、kind，以及有事实依据的路径或主机信息。
每个 Area 候选项都绑定一个 Workspace ID。AI 只能选择兼容的候选 ID，不能返回
任意路径或把一个 Workspace 的 Area 配给另一个 Workspace。

输入示例：

```text
session       = partjobs
session root  = ~/dev/partjobs
git root      = ~/dev/partjobs/high-value-patent-rebuild
cwd           = ~/dev/partjobs/high-value-patent-rebuild/manuscript
process       = codex
```

预期语义结果：

```text
Workspace = partjobs
Area      = high-value-patent-rebuild/manuscript
Activity  = codex
```

## 9. 标准化事件

daemon 接受一组精简的事件类型：

```ts
type SemanticEventKind =
  | "command_started"
  | "command_finished"
  | "content_settled"
  | "window_changed"
  | "manual_name_changed"
  | "refresh_requested";
```

核心 tmux 集成通过 Unix socket 发送有大小限制的 JSON。zsh lifecycle 集成是
可选的，只发送命令 basename 与退出码。密钥和终端文本绝不出现在 argv 中。
项目不提供 Agent 专用 adapter 或 extension 安装路径。

## 10. AI 触发策略

以下情况触发 AI 生成：

- 活动 pane 的有界渲染内容变化后达到稳定状态；
- Scope 跨越 Workspace 或有意义的 Area 边界；
- 尚无稳定 Task 时，一条有意义的通用 shell 命令执行完成；
- 用户显式运行 `tmux-autoname refresh`。

以下情况本身不会触发 AI 生成：

- 选择 window 或 pane；
- 单个终端输出块到达，或屏幕仍在变化；
- Scope 与 Task 仍然有效时，仅 Activity 发生变化；
- evidence fingerprint 没有变化。

fingerprint 归一化会忽略重复的 prompt 重绘和低信息量 shell 装饰，但不会改变
实际发送给模型的有界终端证据。

初始内部默认值：

```text
debounce                 1000 ms
active-pane scan          3000 ms
content settle            4000 ms
minimum call interval   10000 ms per window
in-flight requests      1 per window
request timeout        15000 ms
automatic model retries 0
automatic calls          每个 window 每小时 6 次
automatic calls          每个 tmux server 每小时 30 次
failure circuit opens    连续失败 3 次后
failure circuit cooldown 10 分钟
```

强制刷新可以绕过 fingerprint 去重与最短调用间隔，但不能绕过手动所有权、请求
校验、每小时额度或熔断器。命令会等待最终的 applied/failed/blocked 结果，而不是
只返回 scheduled。所有 provider 请求都计入同一套额度。当额度或熔断器
阻止推理时，继续使用最近一次有效名称或确定性 fallback 名称。

## 11. AI 请求与结果

请求只包含有范围限制的证据：

- 上一次 Name Record 及其 provenance；
- Scope 候选项与 ID；
- 确定性生成的 Activity；
- 活动 pane 的 cwd、command 与 title；
- 活动 pane 脱敏后的渲染尾部，最多 50 行、8 KiB；
- 活动 pane 的结构化事件；
- 少量辅助 pane 元数据；
- window ID、revision 与 evidence fingerprint。

模型执行一次小型、快速、非流式的结构化生成。

```ts
const NameProposalSchema = z.object({
  workspaceId: z.string(),
  areaId: z.string().nullable(),
  task: z.string(),
  taskDecision: z.enum(["keep", "replace"]),
  confidence: z.number().min(0).max(1),
});
```

后置校验必须：

- 确认返回的 ID 存在于请求提供的候选项中；
- 保留完整 Name Record，不由插件截断；statusline 中的可见截断交由 tmux 原生格式与
  用户布局控制；
- 拒绝控制字符与转义序列；
- 拒绝空白、回答式或拒绝式 Task；
- 当 `taskDecision` 为 `keep` 时保留上一次 Task；
- 将格式错误或低置信度结果视为推理失败。

AI 永远不直接返回最终渲染的 window name。

**Token 与成本范围。** Token 数取决于 provider 与模型 tokenizer，不是协议保证。
在本地 AI SDK 传输测试中，典型证据 prompt 估算约 250-500 个输入 token；完整
8 KiB 终端上下文估算约 2,500-5,000 个输入 token。候选项、路径长度与 provider
计费方式会变化。模型输出上限为 512 token，以便带推理能力的 compatible 模型
完成生成；小型 JSON 对象生成后即停止，因此上限不等于固定消耗。按每个 window
默认额度，典型上限估算为每小时 1,500-3,000 个输入 token；若每次抓取都接近
上限，则约为
15,000-30,000 个输入 token。

## 12. 状态与陈旧结果隔离

```ts
type WindowState = {
  mode: "automatic" | "manual";
  revision: number;
  fingerprint?: string;
  record?: NameRecord;
  provenance?: "fallback" | "ai";
  manualName?: string;
  lastAppliedName?: string;
};
```

推理结果仅在满足以下条件时才会被接受：

- 对应的 tmux server 与 window 仍然存在；
- window ID 匹配；
- revision 仍为当前版本；
- evidence fingerprint 仍为当前值；
- window 仍处于 automatic mode。

取消请求只是一种优化。revision 与 fingerprint 检查才是正确性保证。

恢复手动所有权与最近一次已接受 Name Record 所需的状态，可以存放在 tmux
window user option 中。原始证据、prompt、pane 输出和已解析凭据绝不持久化。
无需数据库。

自动调用时间戳与熔断状态以有界的纯数字 tmux user-option 元数据保存，确保 daemon
重启不能重置配额或冷却期；其中不包含 prompt、路径、模型响应或凭据。

## 13. 手动所有权

Manual Name 始终优先。

- 用户发起的非空 `rename-window` 会进入 manual mode。
- 插件发起的重命名带有内部保护，不会进入 manual mode。
- `tmux rename-window ""` 或 `tmux-autoname auto` 恢复 automatic mode。
- 进入 manual mode 时递增 revision，并使所有进行中的模型结果失效。
- manual mode 下，只有在不会产生模型调用时，才可以继续在内部计算 Automatic
  Name；不得进行任何可见写入。

## 14. 失败与回退

- 新 window 会立即获得由 Scope 与 Activity 确定性生成的临时名称，不虚构
  Task。
- AI 运行期间，继续显示临时名称或最近一次有效名称。
- AI 失败时，保留已有的已接受名称。
- tmux 写入失败时，语义状态仍可重试，且不影响 shell。
- daemon、模型、网络、密码管理器或可选 adapter 缺失时，均不得阻塞 tmux 或
  shell 命令。

## 15. Window tab 徽标

徽标独立于 window name 与 Name Record。

```tmux
set -g @tmux-autoname-badge-style 'plain' # 默认值
set -g @tmux-autoname-badge-style 'nerd'
```

| 状态 | Plain | Nerd |
|---|---:|---:|
| 生成中 | `…` | `󰚩` |
| 失败 | `!` | `` |
| 密钥不可用 | `K!` | `` |
| 手动模式 | `M` | `` |
| 正常 | 空 | 空 |

插件提供一个 window 级 badge option，供 `window-status-format` 和
`window-status-current-format` 使用。默认情况下，安装过程会幂等地追加条件徽标
片段，但不会替换用户已有的 format。用户可以关闭这一行为并手动添加片段。
无效的 badge style 回退为 `plain`。

不提供 popup 或 TUI。详细信息通过 `tmux-autoname explain` 查看。

## 16. 模型 Provider 与凭据

v3.0 内置三种 AI SDK provider：

- `openai`：使用 OpenAI 原生 API；
- `anthropic`：使用 Anthropic 原生 API；
- `openai-compatible`：连接兼容的云端或本地 endpoint。

provider 与 model 都是必填配置。插件不提供隐式 provider、默认 model、gateway
或 provider 自动 fallback。使用兼容 provider 时还必须明确配置 base URL，使
请求路由、隐私与计费决策对用户完全可见。

配置接受 `api_key` 明文或凭据引用，两者必须二选一。明文方案最简单，但密钥会
直接保存在磁盘上，因此 README 必须提醒用户将配置文件权限限制为仅本人可读写。
密码管理器与系统 keyring 场景仍推荐使用凭据引用。

```json
{
  "source": "onepassword",
  "ref": "op://Private/OpenAI/api-key"
}
```

```json
{
  "source": "keyring",
  "service": "tmux-autoname",
  "account": "openai"
}
```

```json
{
  "source": "env",
  "name": "OPENAI_API_KEY"
}
```

解析方式：

- 1Password：`op read --no-newline <reference>`。
- Linux keyring：使用属性精确匹配的 `secret-tool lookup`。
- macOS Keychain：通过 `security` 精确查询 service/account。
- 环境变量：只读取配置中明确指定的变量。

规则：

- 第一次模型调用时才延迟解析。
- 在当前 daemon session 的内存中缓存。
- daemon 退出、显式重新加载密钥，或 provider 返回 401/403 时清除。
- 显式重新加载密钥会关闭认证失败熔断，但保留每小时调用时间戳与额度。
- 解析后的值绝不能写入 tmux option、argv、日志、状态文件、prompt 或崩溃报告。
- 后台解析不得打开交互式终端密码提示。解析失败时显示密钥不可用徽标，等待
  用户显式重试。

## 17. 用户命令

```text
tmux-autoname daemon    daemon 内部生命周期管理
tmux-autoname emit      输入内部 tmux/shell 事件
tmux-autoname refresh   等待额度内的立即推理并输出结果
tmux-autoname auto      清除 Manual Name 并恢复自动模式
tmux-autoname explain   输出人类可读说明（`--json` 输出结构化数据）
tmux-autoname secrets reload
                        重启 daemon 并重新加载配置与凭据
```

只有用户显式调用的诊断命令可以向用户终端写入内容。

## 18. 测试策略

### 18.1 隔离的真实 E2E

E2E 测试使用隔离的 tmux server，绝不修改用户正在使用的 tmux server 或配置：

```sh
tmux -L tmux-autoname-e2e -f /dev/null
```

测试运行正式编译产物、daemon、Unix socket、有界终端抓取、zsh 集成和 tmux hook，并连接本地
OpenAI-compatible HTTP 测试服务器。该服务器保留真实的 AI SDK 传输与结构化
输出处理，同时提供确定性的响应、延迟、失败、请求计数和 payload 捕获。

测试覆盖 window 创建、Scope 变化、Activity 变化、终端上下文生成、手动重命名
及恢复、徽标、daemon 重启、旧 daemon 替换、密钥失败、超时、乱序结果、陈旧
结果拒绝、调用限额和熔断恢复。自动执行路径还必须验证 stdout 与 stderr 均为空。

### 18.2 长时段加速模拟

调度、调用额度和熔断逻辑使用可注入时钟。测试通过推进逻辑时间，模拟至少 24
小时的 window 切换、内容变化、cwd 变化、失败和额度窗口重置，但不等待真实的 24
小时。事件量必须足以暴露无界状态、timer、请求和文件描述符累积问题。

### 18.3 真实时间 Soak Test

release candidate 必须在隔离 tmux server 上执行 30 分钟真实时间 soak test。
测试记录 CPU、RSS、打开的文件描述符、子进程、socket 健康状态、事件数量、AI
请求次数和 payload 大小。daemon 崩溃、失去响应、子进程或文件描述符泄漏、内存
无界增长、突破调用额度、产生终端输出或阻塞 tmux，均视为测试失败。

真实付费 provider 请求只作为显式启用的 smoke test，不属于常规自动测试或 CI。
Plain 与 Nerd 徽标字符串由自动测试验证；Nerd Font 的最终显示效果进行一次人工
目视检查。

不要求执行 24 小时 wall-clock 测试。

## 19. 验收标准

1. 自动 hook 执行时绝不进入 tmux view mode，也不需要按 Enter 才能继续。
2. `partjobs` session 可以保留 `partjobs` 作为 Workspace，同时把嵌套子项目和
   子目录表示为 Area。
3. Task 根据稳定后的活动 pane 内容生成，不依赖任何 Agent extension；内容不变
   时不会产生额外模型调用。
4. evidence 不变时切换 window，不会产生模型调用。
5. 两个模型请求以相反顺序完成时，较旧结果不能生效。
6. 延迟返回的模型结果不能覆盖 Manual Name。
7. AI、provider、网络或凭据失败时，保留有用的已有名称或临时名称。
8. 修改 profile 或 badge style 不会产生模型调用。
9. Plain 与 Nerd Font 徽标表示同一套底层状态。
10. 只有用户显式选择 `api_key` 时，配置文件才保存 provider 密钥明文；密钥绝不
    出现在 tmux option、持久化状态、日志、prompt 或诊断信息中。
11. 凭据成功解析后，在当前 daemon session 内复用，不反复触发密码管理器提示。
12. 多 pane window 使用活动 pane 决定 Activity，非活动 pane 不能独立重命名
    window。
13. 每个 AI 生成的 Task 都是简短的英文动作短语。
14. 终端证据有明确上限，发送前脱敏，且不会出现在 tmux option、持久化状态或日志中。
15. 包括显式 refresh 在内的推理，每个 window 每小时不超过 6 次，每个 tmux
    server 每小时不超过 30 次。
16. 连续 3 次推理失败后，自动调用暂停 10 分钟，且不影响 tmux 操作。
17. 发布前必须通过隔离的真实 E2E、加速的 24 小时逻辑时间模拟，以及 30 分钟
    真实时间 soak test。
