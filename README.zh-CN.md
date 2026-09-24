# tmux-autoname

[English](README.md) | 简体中文

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname 把编码 Agent 自己设置的标题直接映射到 tmux 窗口名上。它不调用任何模型，不采集面板文字，也不需要 API key：Claude Code、codex、pi 都会通过 OSC 设置终端标题，tmux 已经把它记录为 `pane_title`，这个插件只是把它复制到窗口名里。

```text
tmux-autoname/Mirror agent titles instead of inferring them
partjobs/查看当前工作情况
website/fix mobile navigation
```

窗口名的格式是 `<workspace>/<title>`；如果还没有任何受支持的 Agent 报告过标题，则只显示 `<workspace>`。完整的设计动机见
[docs/adr/0004-mirror-agent-titles.md](docs/adr/0004-mirror-agent-titles.md)。

## 为什么会有这次重写

早期版本用 LLM 从屏幕文字推断任务，这需要配置文件、API key、常驻 daemon 和 Bun 构建步骤，而且推断出的名字经常描述的是当前步骤而不是目标。既然 Agent 已经会给自己的工作命名，这个版本只是把它读出来。

## 依赖

- tmux 3.3 及以上
- POSIX `sh`（Linux、macOS 默认自带）
- `git`，可选，用于生成 Workspace 名称

没有构建步骤，除 tmux 本身外没有运行时依赖。

## 用 TPM 安装

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

按下 `prefix` + <kbd>I</kbd> 即可，不需要额外构建或配置。

## 手动安装

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
```

在 `~/.tmux.conf` 中加载插件：

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

然后重新加载 tmux：

```sh
tmux source-file ~/.tmux.conf
```

如果想直接用命令名调用（而不是通过加载脚本始终会设置的
`$TMUX_AUTONAME_BIN`），把插件的 `bin` 目录加入 `PATH`：

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

加载脚本总是把可执行文件解析为自己所在 checkout 里的
`bin/tmux-autoname`——它绝不会从进程环境里读回
`$TMUX_AUTONAME_BIN`，所以哪怕某个 shell 碰巧带着这个变量（比如来自旧版安装），也不会把服务器钉死在一个过时的二进制上。如果确实想指定另一个二进制，请在插件加载**之前**设置
`@tmux-autoname-bin`：

```tmux
set -g @tmux-autoname-bin '/path/to/custom/tmux-autoname'
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

## 支持的 Agent

| Agent | `pane_current_command` | 原始标题示例 | 归一化后的 Task |
|---|---|---|---|
| Claude Code | `claude` | `✳ Worktree review` | `Worktree review` |
| codex | `codex` | `查看当前工作情况 \| bllc-reproduction` | `查看当前工作情况` |
| pi | `pi` | `π - reviewer - myproj` | `reviewer` |

占位标题——Claude Code 的 `Claude Code`、codex 设置线程标题之前的状态、或未命名的 pi 会话（`π - <cwd>`，没有会话名）——都算作没有标题，此时窗口只显示 Workspace。只考虑窗口的活动面板，以及（如果不同）刚刚发生标题变化的那个面板；当一个窗口内有多个 Agent 面板时，活动面板优先。一旦记录了 Task，它就会一直贴在这个窗口上——即使 Agent 退出也不会消失，只有窗口内某个 Agent 报告了新的、有意义的标题时才会替换。

用 `@tmux-autoname-agents`（默认 `claude codex pi`）增删受支持的命令。

## pi 会话命名

pi 在会话被 `/name` 或某个扩展命名之前，标题一直是 `π - <cwd>`。
`integrations/pi/session-title.ts` 补上了这一环：在第一轮 Agent 对话结束后，如果会话仍未命名，就向当前模型请求一个简短标题（基于用户的第一条消息），然后调用 `pi.setSessionName()`。它失败时静默处理，不会阻塞对话。

安装方法：让 pi 指向这个文件，例如用 `-e
~/.tmux/plugins/tmux-autoname/integrations/pi/session-title.ts`，或者把它加入 pi 配置的 extensions 列表。

## Workspace

Workspace 只计算一次，之后固定不变（直到执行 `clear`）：

1. **会话容器规则。** 如果 `#{session_path}` 的目录名与 tmux 会话同名，且面板路径就是该目录或在其下，就用会话名。
2. **Git 仓库。** 否则用主仓库的目录名（`git rev-parse
   --path-format=absolute --git-common-dir`）；worktree 会映射到其主仓库。
3. **目录。** 否则用当前目录名；`$HOME` 显示为 `~`。

在记录任何 Task 之前，Workspace 会在每次 sync 时重新计算，随面板当前路径变化。

## 命令

```
tmux-autoname sync [-t pane_or_window]
tmux-autoname set [-t window] <title...>
tmux-autoname clear [-t window]
tmux-autoname auto [-t window]
tmux-autoname status [-t window]
tmux-autoname help
```

- `sync` 重新计算某个窗口的名字。钩子会自动调用它，通常不需要手动执行。
- `set` 固定一个 Agent 标题无法覆盖的标题，例如
  `tmux-autoname set Reviewing the payments PR`。
- `clear` 清除固定标题、粘性 Agent 标题和固定的 Workspace，窗口回到只显示 Workspace 的状态。
- `auto` 忘记手动 `tmux rename-window`，立即重新同步。
- `status` 打印窗口的 Workspace、标题来源、粘性标题、固定标题、完整 label，以及是否被手动改名。

用户手动改名（tmux 自带的 `prefix` + <kbd>,</kbd>，或 `rename-window`）会一直优先，直到运行 `tmux-autoname auto`，或把窗口名改成空字符串（`tmux rename-window ""`）以恢复自动命名。

## 选项

| 选项 | 默认值 | 含义 |
|---|---|---|
| `@tmux-autoname-agents` | `claude codex pi` | 贡献标题的 `pane_current_command` 值，空格分隔 |
| `@tmux-autoname-max-width` | `32` | 窗口名被截断为 `…` 之前的显示宽度 |
| `@tmux-autoname-bin` | 未设置 | 要使用的 `tmux-autoname` 二进制路径，如果不是当前 checkout 里那个——必须在插件加载之前设置 |
| `@tmux-autoname-key-set` | 未设置 | 绑定在 `prefix` 键表中的按键，弹出输入框固定标题，预填当前固定标题，若没有则预填粘性 Agent 标题 |
| `@tmux-autoname-key-clear` | 未设置 | 清除当前窗口的按键 |
| `@tmux-autoname-key-pick` | 未设置 | 打开显示完整 label 的 `choose-tree` 的按键 |

在插件加载之前设置：

```tmux
set -g @tmux-autoname-max-width 40
set -g @tmux-autoname-key-set 'M-r'
set -g @tmux-autoname-key-clear 'M-c'
set -g @tmux-autoname-key-pick 'M-p'
```

完整、未截断的 label 始终可以通过 `#{@tmux-autoname-label}` 获取，可用于你自己的 `window-status-format`。

## 从 0.5 及更早版本升级

0.6 完全移除了 TypeScript/Bun 运行时、推断 daemon、配置文件和窗口标签徽章——没有需要构建或配置的东西。加载新的 `tmux-autoname.tmux` 会自动迁移旧安装：停止旧 daemon、覆盖旧的带索引钩子、从你的
`window-status-format`/`window-status-current-format` 中移除它曾追加的徽章片段，并清除它的过时全局选项。

它还会迁移每个窗口旧的逐窗口状态（`@tmux-autoname-state`，旧 daemon 留下的
base64 编码 JSON，以及 `@tmux-autoname-badge`）：旧 daemon 处于 manual 模式的窗口会保持
manual（sync 永远不会改它的名字）；处于 automatic 模式的窗口会交给新插件从头命名；随后这两个选项都会被清除。完全没有旧状态、但
`automatic-rename` 被显式关闭的窗口（也就是你自己直接 `tmux rename-window`
过、和 tmux-autoname 无关的窗口）同样会被当作 manual，所以不管哪种情况，手动改名都能在升级后保留下来。如果旧状态存在但无法解码，该窗口也会被当作
manual——tmux-autoname 从不覆盖一个它不确定的名字。详见
[CHANGELOG.md](CHANGELOG.md)。

## 局限

- 命名质量现在完全取决于 Agent 自己标题的质量；没有受支持 Agent 的窗口只显示 Workspace。
- Claude Code 会保留第一个话题的标题，在长会话中可能跟不上当前焦点；用
  `tmux-autoname set` 或 Agent 自己的改名命令可以解决。
- 开箱只支持 `claude`、`codex`、`pi`：如果其他工具设置的标题格式不需要特殊归一化，可以直接加入
  `@tmux-autoname-agents`；如果需要，则要在 `bin/tmux-autoname` 的
  `normalize_title()` 里做一点小改动。

## 开发与验证

```sh
shellcheck tmux-autoname.tmux bin/tmux-autoname test/run.sh
sh test/run.sh
```

`test/run.sh` 会启动真实的、隔离的 tmux server（`tmux -L
tmux-autoname-test-*`），并用会发出真实 OSC 标题序列的伪造 `claude`/`codex`/`pi` 进程驱动它，因此测试的是真实的钩子和格式正则，而不是它们的重新实现。
