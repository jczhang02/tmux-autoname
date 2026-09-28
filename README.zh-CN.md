# tmux-autoname

[English](README.md) | 简体中文

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname 根据当前实际在运行什么、在什么位置，确定性地给 tmux 窗口命名：不调用任何模型，不采集面板文字，不需要 API key，也不镜像 Agent 自己设置的标题。

```text
claude:tmux-autoname
zsh:partjobs/patent-value-identification
codex:partjobs/patent-value-identification
ssh:gentoo-box
```

窗口名的格式是 `<activity>:<workspace>[/<area>]`。完整的设计动机见
[docs/adr/0005-restore-deterministic-naming.md](docs/adr/0005-restore-deterministic-naming.md)。

## 为什么会有这次重写

早期版本用 LLM 从屏幕文字推断任务，后一个版本改为镜像编码 Agent 自己设置的标题。这两种做法都被放弃了：推断出的任务描述的常常是当前步骤而不是目标；Agent 标题大多是 Agent 使用的那种语言，会随面板焦点变化，而且一旦丢掉 Area，同一 session 里的窗口就分不清了。这个版本恢复了维护者在这两者之前每天实际使用的那套确定性、纯本地的规则。

## 依赖

- tmux 3.3 及以上
- POSIX `sh`（Linux、macOS 默认自带）
- `git`，可选，用于 Git Workspace 候选项
- `zsh`，可选，用于推荐的 `integrations/tmux-autoname.zsh`

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

## 推荐：zsh 集成

tmux 没有钩子能在前台程序变化或 shell `cd` 时触发。没有这个集成的话，`tmux-autoname` 只会在 tmux 自身的结构性事件上重新计算窗口名——新建窗口、面板获得焦点、分屏、新建 session、客户端 attach。也就是说，只要你停留在同一个面板里，名字就可能一直跟不上现实：原地从 `zsh` 切换到 `claude`，或者 `cd` 到另一个项目，都不会被反映出来，除非有别的事件顺带触发了一次同步。

`integrations/tmux-autoname.zsh` 补上了这个缺口，也是日常使用推荐的方式。在 `~/.zshrc` 中加载它：

```sh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

它挂载了 `preexec`（命令开始后不久同步一次）、`precmd`（下一次提示符出现前同步一次）和 `chpwd`（`cd` 时同步一次），每一次都在后台运行并 disown，所以既不会拖慢你的提示符，也不会打印任何 job control 消息。它会优先使用
`$TMUX_AUTONAME_BIN`（加载脚本会为你导出这个变量），否则退回到 `$PATH` 里的 `tmux-autoname`。

## 命名规则

- **Activity** 是 `pane_current_command`，转小写后去掉
  `-coding-agent` 后缀（所以 `pi-coding-agent` 会变成 `pi`）。
- **Workspace** 取以下规则中第一个适用的：
  1. 如果是 `ssh` 或 `mosh`，从 pane 标题里解析出的远程主机名。
  2. **会话容器规则。** 如果 `#{session_path}` 的目录名与 tmux 会话同名，且面板路径就是该目录或在其下，就用会话名。
  3. **Git 仓库。** 否则用 `git rev-parse --show-toplevel` 的目录名。
  4. **会话名。** 否则用会话名本身。
- **Area** 是面板路径相对于最终选中的 Workspace 根目录的部分，仅当面板路径严格位于该根目录之下时才会出现（绝不会出现 `..`，在没有根目录的候选项——例如 `ssh`/`mosh`——上也不会出现）。它会被截断为前
  `@tmux-autoname-area-depth` 段路径（默认 `1`）；设为 `0`
  则保留完整的相对路径。

## 命令

```
tmux-autoname sync [-t pane_or_window]
tmux-autoname auto [-t window]
tmux-autoname status [-t window]
tmux-autoname help
```

- `sync` 重新计算某个 pane 或 window 所属窗口的名字，依据的是这个窗口当前**活动**的面板——如果你传入的面板不是活动面板，也会以活动面板为准。钩子（以及 zsh 集成）会自动调用它，通常不需要手动执行。
- `auto` 忘记手动 `tmux rename-window`，立即重新同步。
- `status` 打印窗口当前的名字、`sync` 最近一次应用的名字，以及是否已被手动改名。

用户手动改名（tmux 自带的 `prefix` + <kbd>,</kbd>，或 `rename-window`）会一直优先，直到运行 `tmux-autoname auto`，或把窗口名改成空字符串（`tmux rename-window ""`）以恢复自动命名。

## 选项

| 选项 | 默认值 | 含义 |
|---|---|---|
| `@tmux-autoname-area-depth` | `1` | 保留的 Area 路径段数；`0` 表示保留完整相对路径 |
| `@tmux-autoname-bin` | 未设置 | 要使用的 `tmux-autoname` 二进制路径，如果不是当前 checkout 里那个——必须在插件加载之前设置 |
| `@tmux-autoname-key-auto` | 未设置 | 绑定在 `prefix` 键表中、对当前窗口执行 `auto` 的按键 |

在插件加载之前设置：

```tmux
set -g @tmux-autoname-area-depth 0
set -g @tmux-autoname-key-auto 'M-a'
```

## 从 0.6 及更早版本升级

0.7 移除了 0.6 加入的所有 AI/Agent 标题相关功能：`set`、`clear`、Pin、粘性 Task、固定 Workspace、`@tmux-autoname-agents`、`@tmux-autoname-max-width`、`-key-set`/`-key-clear`/`-key-pick` 按键绑定、`pane-title-changed` 钩子，以及
`integrations/pi/session-title.ts`。命名重新变得确定性；详见
[docs/adr/0005-restore-deterministic-naming.md](docs/adr/0005-restore-deterministic-naming.md)。加载新的 `tmux-autoname.tmux` 会自动迁移旧安装：停止任何仍在运行的
pre-0.6 daemon、覆盖旧的带索引钩子、从你的
`window-status-format`/`window-status-current-format` 中移除 0.5 及更早版本追加的徽章片段，并清除 pre-0.6 daemon 与 0.6 自身留下的所有过时全局及逐窗口选项。

它还会迁移每个窗口 pre-0.6 daemon 留下的旧状态（`@tmux-autoname-state`，base64 编码 JSON，以及
`@tmux-autoname-badge`）：旧 daemon 处于 manual 模式的窗口会保持
manual（sync 永远不会改它的名字）；处于 automatic 模式的窗口会交给新插件从头命名；随后这两个选项都会被清除。完全没有旧状态、但
`automatic-rename` 被显式关闭的窗口（也就是你自己直接 `tmux rename-window`
过、和 tmux-autoname 无关的窗口）同样会被当作 manual，所以不管哪种情况，手动改名都能在升级后保留下来。如果旧状态存在但无法解码，该窗口也会被当作
manual——tmux-autoname 从不覆盖一个它不确定的名字。详见
[CHANGELOG.md](CHANGELOG.md)。

## 局限

- 没有 zsh 集成时，Activity 和 Area 只会在 tmux 自身的窗口/面板/会话事件上更新，不会因为同一个面板里前台命令变化或 `cd` 而更新。
- Workspace 只查询 `git`；其他版本控制系统会退回到会话名或目录名。

## 开发与验证

```sh
shellcheck tmux-autoname.tmux bin/tmux-autoname test/run.sh
sh test/run.sh
```

`test/run.sh` 会启动真实的、隔离的 tmux server（`tmux -L
tmux-autoname-test-*`），并用以测试所需的名字 exec 出来的伪造进程驱动它，因此测试的是真实的钩子，而不是它们的重新实现。
