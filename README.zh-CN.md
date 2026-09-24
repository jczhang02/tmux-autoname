# tmux-autoname

[English](README.md) | 简体中文

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname 根据当前工作内容命名 tmux window，不再只是重复显示前台进程名。

```text
codex:tmux-autoname/improve-process-detection
pi:partjobs/client-a/review-payment-flow
nvim:website/fix-mobile-navigation
```

默认格式是 `activity:scope/task`。

- Activity 来自当前 pane 的前台进程。
- Scope 根据 tmux、cwd、Git 和路径信息生成候选项。模型只能选择本地候选项，不能编造路径。
- Task 根据有限的终端内容生成，由 2 到 5 个小写英文单词组成，单词之间使用连字符。

插件异步运行，不会覆盖手动名称，也不会弹出提示或 popup。window tab 上的小徽标会显示当前状态。

## 工作方式

- 进入子目录后，名称仍会保留这层信息。例如，`partjobs` session 进入 `client-a` 后，可以显示为 `pi:partjobs/client-a/review-payment-flow`。
- 在 Linux 上，进程解析会穿透 `systemd-run` 包装，因此 `codex` 和 `pi` 仍显示自己的名字。
- 屏幕监控直接读取终端内容，不要求安装 Codex、Claude Code、Pi 或编辑器扩展。
- 有效信息发生变化并且屏幕稳定后，插件才会调用 AI。重复绘制的 shell prompt 不会产生新请求。
- window 的 Task 一旦被接受，就是稳定的：即使 Workspace、目录或 activity 发生变化，自动化也不会再替换它。只有显式的 `tmux-autoname refresh`（在有新结果被接受前保留旧名称）或 `tmux-autoname new`（开始新工作，见下文）才能改变它。
- 接受名称前，插件会校验 Scope ID、状态版本和证据指纹。过期或格式错误的结果会被丢弃。
- 所有 pane 的本地进程和路径信息都会更新。终端文本只从已连接客户端当前可见的 pane 中采集。

## 环境要求

- tmux 3.2 或更高版本
- Bun 1.3 或更高版本，用于安装和开发
- OpenAI、Anthropic 或兼容 OpenAI API 的服务
- 只有启用可选的 shell 生命周期集成时才需要 zsh
- 使用相应凭据来源时，需要 `op`、`secret-tool` 或 macOS `security`

## 使用 TPM 安装

在 tmux 配置中加入：

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

按 `prefix` + <kbd>I</kbd>。TPM 会克隆仓库，但仓库目前不提交编译后的二进制文件，因此每次安装或更新后需要构建一次：

```sh
plugin_dir="${TMUX_PLUGIN_MANAGER_PATH:-$HOME/.tmux/plugins}/tmux-autoname"
cd "$plugin_dir"
bun install --frozen-lockfile
bun run build
tmux source-file ~/.tmux.conf
```

如果 TPM 或 tmux 使用 XDG 目录，请改用对应路径。常见路径是 `~/.config/tmux/plugins/tmux-autoname` 和 `~/.config/tmux/tmux.conf`。

## 手动安装

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
cd ~/.tmux/plugins/tmux-autoname
bun install --frozen-lockfile
bun run build
```

在 `~/.tmux.conf` 中加载插件：

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

重新加载 tmux：

```sh
tmux source-file ~/.tmux.conf
```

如果希望直接输入命令名，请把插件的 `bin` 目录加入 `PATH`：

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

## 配置 AI

复制示例配置：

```sh
mkdir -p ~/.config/tmux-autoname
cp config/config.example.toml ~/.config/tmux-autoname/config.toml
```

插件不预设 provider 或 model。下面是 OpenAI 兼容接口与 1Password 引用的最小配置：

```toml
[ai]
provider = "openai-compatible"
model = "your-fast-model"
base_url = "https://api.example.com/v1"
confidence_threshold = 0.6

[ai.credential]
source = "onepassword"
ref = "op://Private/OpenAI/api-key"
```

也可以直接把密钥写进同一个文件：

```toml
[ai]
provider = "openai-compatible"
model = "your-fast-model"
base_url = "https://api.example.com/v1"
api_key = "your-api-key"
```

`api_key` 和 `[ai.credential]` 不能同时使用。明文密钥配置最省事，但密钥会保存在磁盘上。请限制配置文件的访问权限：

```sh
chmod 600 ~/.config/tmux-autoname/config.toml
```

凭据引用支持以下来源：

| 来源 | 配置 | 行为 |
|---|---|---|
| 1Password | `source = "onepassword"` 和 `op://` 引用 | 使用 1Password CLI 及桌面应用集成 |
| Linux keyring | `source = "keyring"`、`service` 和 `account` | 通过 `secret-tool` 读取当前登录会话的 Secret Service |
| macOS Keychain | `source = "keychain"`、`service` 和 `account` | 通过 `security` 读取当前用户已解锁的 Keychain |
| 环境变量 | `source = "env"` 和 `name` | 从 tmux server 环境中读取指定变量 |

daemon 会在第一次模型请求时读取凭据，并缓存在内存里。每次重命名都不会再次访问密码管理器。修改配置或密钥后运行：

```sh
tmux-autoname secrets reload
```

该命令会重启 daemon，清除已缓存的凭据和认证失败状态，同时保留每小时请求计数。服务端返回 401 或 403 时，也会清除缓存的凭据。

默认配置路径是 `~/.config/tmux-autoname/config.toml`。设置 `TMUX_AUTONAME_CONFIG` 可以改用其他文件。

验证配置是否生效：

```sh
tmux-autoname explain
```

最后一行应显示 `Status: ready`。其他状态会说明缺少什么，例如配置或凭据问题。

## 使用

加载插件时会为当前 tmux server 启动一个 daemon。默认每 3 秒检查一次，并等待可见内容稳定 4 秒，再判断是否需要调用 AI。

使用 tmux 原有的 window rename 快捷键，通常是 `prefix` + <kbd>,</kbd>，即可手动接管名称。非空的手动名称会一直保留，直到你恢复自动命名，可以运行：

```sh
tmux-autoname auto
```

也可以用 tmux 自带的重命名命令，把名称清空：

```sh
tmux rename-window ""
```

面向用户的命令如下：

| 命令 | 作用 |
|---|---|
| `tmux-autoname refresh` | 重新识别：立即请求推理，等待 applied、failed 或 blocked 的最终结果并打印。在新结果被接受前保留旧名称，包括推理失败或放弃时 |
| `tmux-autoname new` | 开始新工作：丢弃 window 的 Task，显示仅含 Workspace 的名称，并等待变化的证据后才再次推理。手动模式下会拒绝执行 |
| `tmux-autoname explain` | 显示当前名称记录、模式、徽标、错误、请求计数和熔断状态，不发起推理 |
| `tmux-autoname auto` | 清除手动名称，让 window 恢复自动命名 |
| `tmux-autoname secrets reload` | 重启 daemon，重新读取配置和凭据 |

`refresh`、`new`、`auto` 和 `explain` 支持 `--window @ID` 或 `--pane %ID`。在 tmux 内不指定目标时，它们使用当前 pane。`refresh` 和 `explain` 还支持 `--json`。

`refresh` 会跳过 debounce 和最小请求间隔，但仍受每小时配额与熔断器限制。`new` 不会重置配额，且只影响目标 window。

`refresh` 和 `new` 都不会解锁 Manual Name；只有 `tmux-autoname auto` 或 `tmux rename-window ""` 才能做到。

### 可选的 zsh 生命周期事件

屏幕监控不依赖 shell 集成。如果希望把命令开始和结束作为额外的调度信号，请在 `~/.zshrc` 中加入：

```zsh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

该集成只发送命令 basename 和退出状态，不发送命令参数。

### 可选的按键绑定

默认不绑定任何按键。在插件加载前设置以下任一选项，即可为当前 window 绑定按键，并通过 tmux 状态栏消息反馈结果：

```tmux
set -g @tmux-autoname-key-refresh 'M-r'
set -g @tmux-autoname-key-auto 'M-a'
set -g @tmux-autoname-key-new 'M-n'
```

`@tmux-autoname-key-refresh` 会为当前 window 运行 `tmux-autoname refresh`；`@tmux-autoname-key-auto` 会运行 `tmux-autoname auto`；`@tmux-autoname-key-new` 会运行 `tmux-autoname new`。三者都绑定在 `prefix` 按键表中，因此上面的例子需要按 `prefix` + <kbd>M-r</kbd>、`prefix` + <kbd>M-a</kbd> 或 `prefix` + <kbd>M-n</kbd> 触发。

## Window tab 徽标

插件会把徽标追加到现有的 `window-status-format`，不会替换主题。

| 状态 | 普通字符 | Nerd Font |
|---|---:|---:|
| 正在生成 | `…` | `󰚩` |
| 失败 | `!` | `` |
| 无法读取密钥 | `K!` | `` |
| 手动命名 | `M` | `` |
| 正常 | 空 | 空 |

在加载插件前启用 Nerd Font 徽标：

```tmux
set -g @tmux-autoname-badge-style 'nerd'
```

如果要自己决定徽标在 status format 中的位置：

```tmux
set -g @tmux-autoname-install-badge 'off'
```

window 级别的值是 `#{@tmux-autoname-badge}`。

## tmux 与进程兼容性

加载脚本会关闭 tmux 内置的 `automatic-rename`，安装带索引的 hook，并追加徽标。它不会覆盖无关的 hook 或 status format。

每个 daemon 都会报告 build identity。加载新版本时，旧 daemon 会被替换。

在 Linux 上，如果 tmux 报告的进程是 `systemd-run`，解析器会检查前台进程组，并读取显式 `--` 分隔符之后的可执行文件。通过 `systemd-run --wait --pty -- …` 启动的命令仍会显示为 `codex` 或 `pi`。解析失败时，Activity 会保留为 `systemd-run`。procfs 中的原始命令行不会保存，也不会发送给模型。

Agent 完成提醒与本插件无关。tmux-autoname 不发送或读取 OSC 通知，也不会因为 Agent 结束运行而修改名称。

## 隐私、成本和资源占用

> [!IMPORTANT]
> 模型请求包含当前 pane 的终端尾部内容，以及有限的 tmux、cwd、进程、title、Git 和路径候选、旧名称、辅助 pane 信息。请使用你愿意接收这些数据的 provider 和 endpoint。

终端内容最多 50 行、8 KiB。常见密钥格式会在本地尽力脱敏。内容只保存在内存中，不会写入 tmux 状态或日志。插件不会发送完整 scrollback、环境变量列表、shell history 或 procfs 原始命令行。终端画面中已经显示的命令参数可能被包含。

只有在稳定的有效信息发生变化后，插件才会调用 AI。默认限制为每个 window 每小时最多 6 次、每个 tmux server 每小时最多 30 次，模型输出上限为 512 tokens。常见输入实测约为 250 到 500 tokens；接近 8 KiB 的输入约为 2,500 到 5,000 tokens。实际计数取决于 provider 的 tokenizer。

本地测试中，一个可见 pane 稳态运行 30 秒，平均 CPU 占用为 0.7%，内存与文件描述符数量保持稳定。不同硬件和负载会有差异。需要时可以降低配额：

```toml
[limits]
minimum_call_interval_ms = 120000
max_calls_per_window_hour = 3
max_calls_per_server_hour = 15
```

## 开发与验证

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` 包含类型检查、单元测试、模拟测试、使用本地假 provider 的隔离 tmux E2E 测试和 shell 校验。

可选的发布前 soak 测试会真实运行 30 分钟：

```sh
bun run test:soak
```

模拟测试会推进 24 小时的逻辑时间，不需要等待 24 小时。行为规范见 [SPEC.md](SPEC.md)，中文版本见 [SPEC.zh-CN.md](SPEC.zh-CN.md)。
