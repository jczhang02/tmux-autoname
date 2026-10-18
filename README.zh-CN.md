# tmux-autoname

[English](README.md) | 简体中文

[![CI](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml/badge.svg)](https://github.com/jczhang02/tmux-autoname/actions/workflows/ci.yml)

tmux-autoname 根据窗口所做的项目和任务, 确定性地给 tmux 窗口命名, 并按窗口里运行的程序给每个窗口一个图标. 不调用模型, 不采集屏幕文字, 不需要 API key, 没有 daemon.

```text
patent-value-identification                           会话 partjobs, 在 main 上
patent-value-identification/ch4-selector-improvement  会话 partjobs, 在分支 ch4-selector-improvement 上
paxc-approx-dnn/report-clarity                        会话 partjobs, worktree report-clarity
ch4-selector-improvement                              会话 patent-value-identification
main                                                  会话 tmux-autoname, 在 main 上
gentoo-box                                            ssh gentoo-box
```

名字由 Project `P` 和 Task `T` 组成. Task 是当前分支, `main` 和 `master` 除外:

| P 与会话名不同 | Task | 名字 |
|---|---|---|
| 是 | 有 | `P/T` |
| 是 | 无 | `P` |
| 否 | 有 | `T` |
| 否 | 无 | 分支名, 否则为目录名 |

程序不放进名字, 由图标显示. 设计记录在 [docs/adr/0007-project-and-task-names.md](docs/adr/0007-project-and-task-names.md); 术语定义在 [CONTEXT.md](CONTEXT.md).

## 为什么有这个插件

早期版本用 LLM 从屏幕文字推断任务, 后来改为镜像编码 Agent 自己设置的标题. 两者都被放弃了: 推断出的任务描述的是当前步骤, 不是目标; Agent 标题会随面板焦点变化, 并且让同一会话里的窗口看起来一样. 本插件改用一条本地的确定性规则. 一个窗口通常只在一个项目里做一个任务, 而任务通常有自己的分支, 所以名字只说明这两点.

## 依赖

- tmux 3.3 及以上 (CI 测试 3.3a, 3.4 和 3.5a)
- POSIX `sh` (Linux 和 macOS 默认自带)
- `git` 2.31 及以上, 可选, 用于 Project 和 Task; 更旧的 Git 按没有 Git 处理
- `zsh`, 可选, 用于推荐的 `integrations/tmux-autoname.zsh`
- [Nerd Font](https://www.nerdfonts.com/), 可选, 用于显示图标

没有构建步骤, 除 tmux 外没有运行时依赖.

## 用 TPM 安装

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
```

按 `prefix` + <kbd>I</kbd>.

## 手动安装

```sh
git clone https://github.com/jczhang02/tmux-autoname ~/.tmux/plugins/tmux-autoname
```

在 `~/.tmux.conf` 中加载插件:

```tmux
run-shell '~/.tmux/plugins/tmux-autoname/tmux-autoname.tmux'
```

然后重新加载 tmux:

```sh
tmux source-file ~/.tmux.conf
```

加载脚本总是使用自己所在 checkout 里的 `bin/tmux-autoname`, 并把它的路径作为 `TMUX_AUTONAME_BIN` 导出到 tmux 全局环境, 供 zsh 集成使用. 如果想直接用命令名调用, 把 `bin` 目录加入 `PATH`:

```sh
export PATH="$HOME/.tmux/plugins/tmux-autoname/bin:$PATH"
```

## 显示图标和手动标记

插件把图标写入窗口选项 `@tmux-autoname-icon`. 有 Manual Name 的窗口还会在 `@tmux-autoname-manual` 中得到手动标记 (󰏫, U+F03EB); 自动命名的窗口这个选项为空. 插件从不把它们放进窗口名, 也从不修改你的状态栏格式, 所以需要你自己把它们加入两个格式:

```tmux
set -g window-status-format         '#I #{@tmux-autoname-icon} #W#{?@tmux-autoname-manual, #{@tmux-autoname-manual},}'
set -g window-status-current-format '#I #{@tmux-autoname-icon} #W#{?@tmux-autoname-manual, #{@tmux-autoname-manual},}'
```

如果某个主题插件设置了这两个格式, 请把这个标记加入主题的格式, 或在主题加载之后再设置格式.

## 推荐: zsh 集成

tmux 没有在前台程序或目录变化时触发的钩子. 没有帮助的话, 窗口只在 tmux 自身的事件上同步: 新建窗口, 面板获得焦点, 分屏, 关闭面板, 把面板拆成独立窗口, 新建会话, 客户端 attach. 如果你在 shell 里启动 `claude`, 或 `cd` 到另一个项目, 名字和图标要等到这些事件之一发生后才会变化.

`integrations/tmux-autoname.zsh` 补上了这个缺口. 在 `~/.zshrc` 中加载它:

```sh
source ~/.tmux/plugins/tmux-autoname/integrations/tmux-autoname.zsh
```

它在命令开始 0.3 s 后 (`preexec`), 每次提示符出现前 (`precmd`) 和 `cd` 时 (`chpwd`) 同步. 每次同步都在后台运行并 disown, 所以不会拖慢提示符, 也不会打印 job control 消息. 它使用 `$TMUX_AUTONAME_BIN`, 否则使用自己所在 checkout 里的 `bin/tmux-autoname` (新 server 第一个 pane 的 shell 在加载脚本导出这个变量之前就已启动), 再否则使用 `PATH` 里的 `tmux-autoname`.

## 命名规则

所有部分都取自窗口的**活动**面板.

- **Project** 取第一条适用的规则:
  1. **远程主机.** 对 `ssh` 和 `mosh`, 取远程主机名, 转小写. 名字只有主机名. 它从前台进程的 argv 读取: 跳过选项 (及其值), 取第一个位置参数, 去掉 `user@` 前缀, `ssh://` scheme 和 `:port`. 对 `mosh-client`, 或 argv 给不出结果时, 从面板标题解析主机名. 没有 `/proc` 时 (macOS), argv 来自 `ps`, 它用空格连接参数, 所以含空格的参数 (`-o 'Opt value'`) 可能让主机名错位.
  2. **Git 仓库.** 取 `git rev-parse --show-toplevel` 的 basename. linked worktree 取它的主仓库名: `paxc-approx-dnn/.claude/worktrees/report-clarity` 里的 worktree, Project 是 `paxc-approx-dnn`. submodule 保留自己的名字.
  3. **会话容器.** 不在 Git 里时, 如果 `#{session_path}` 的 basename 等于会话名, 且面板路径在该目录之下: 取它下面的第一级目录.
  4. **会话名.**
- **Task** 是当前分支, 但 `main`, `master` 和 detached HEAD 除外. 开头的 `worktree-` (Claude Code 给 worktree 分支加的前缀) 会被去掉.
- 与会话名相同的 Project 会被省略. Project 和 Task 都没有时, 名字是当前分支 (`main`); 不在 Git 里时, 是目录名 (家目录为 `~`).
- 子目录不放进名字. 同一个项目, 同一个分支上的两个窗口名字相同; 请手动给其中一个命名 (`prefix` + <kbd>,</kbd>).
- **Activity** 是正在运行的程序, 用于选择图标, 并由 `status` 打印: 取 `pane_current_command` 的 basename, 转小写, 去掉 `-coding-agent` 后缀 (`pi-coding-agent` 变成 `pi`), 只保留 `[a-z0-9._+-]`; 结果为空时为 `shell`. 启动器 (`sudo`, `doas`, `env`, `nice`, `timeout`, `systemd-run` 等) 或解释器 (`node`, `bun`, `deno`, `python*`, `ruby`, `perl`) 会通过前台进程的 argv 解析成它运行的程序: `doas emerge -a` 是 `emerge`, `node .../bin/codex` 是 `codex`, `python3 -m http.server` 是 `http.server`. 没有脚本的解释器 (REPL, `-e`, `-c`) 保留自己的名字. `mosh-client` 是 `mosh`.

## 图标

每次 `sync` 都会按 Activity 设置 `@tmux-autoname-icon`, 有 Manual Name 的窗口也一样: Manual Name 只改变名字, 图标仍然显示窗口里在运行什么. 图标是唯一显示程序的地方, 所以内置表覆盖了很多程序.

图标用 sh `case` glob 与解析后的 Activity 匹配. 按以下顺序, 第一个匹配生效:

1. 你在 `@tmux-autoname-icons` 中的条目,
2. 下面的内置表,
3. `@tmux-autoname-icon-default`, 默认 U+F018D (󰆍).

因为匹配使用解析后的 Activity, `doas nvim` 也会得到 vim 图标.

| 模式 | 码位 | 字形 | 含义 |
|---|---|---|---|
| `nvim*` `vim*` `vi` | U+E62B |  | vim |
| `claude*` | U+EC82 |  | Claude Code |
| `codex*` | U+EC81 |  | Codex (OpenAI) |
| `opencode*` `pi` `gemini*` `aider*` `crush*` `goose*` `amp` | U+F06A9 | 󰚩 | 其他 Agent |
| `ssh*` `mosh*` `scp` `sftp` `rsync` | U+F08C0 | 󰣀 | 远程 |
| `btop*` `htop*` `top` `nvtop` `nvidia-smi` `watch` | U+F035B | 󰍛 | 系统监视器 |
| `python*` `ipython*` `uv` `pip*` `pdm` `conda` `mamba` `jupyter*` | U+E606 |  | python |
| `git*` `lazygit*` `tig` | U+F02A2 | 󰊢 | git |
| `gh` | U+F02A4 | 󰊤 | GitHub |
| `yazi*` `lf` `ranger*` | U+F024B | 󰉋 | 文件管理器 |
| `man` `less` `bat` `more` `tail` `journalctl` `dmesg` | U+F0219 | 󰈙 | 分页器和日志 |
| `emerge` `eix*` `equery` `eselect` `euse` `emaint` | U+F30D |  | Gentoo |
| `flatpak` `mise` `pacman` `paru` `yay` `apt*` `dnf` `brew` | U+F03D7 | 󰏗 | 包管理器 |
| `node*` `npm*` `npx*` `pnpm*` `bun*` `deno` `yarn*` | U+F0399 | 󰎙 | Node 和 JS |
| `cargo` `rustc` | U+F1617 | 󱘗 | Rust |
| `go` | U+F07D3 | 󰟓 | Go |
| `docker*` `podman*` `lxc` `incus` | U+F0868 | 󰡨 | 容器 |
| `kubectl` `k9s` | U+F10FE | 󱃾 | Kubernetes |
| `make` `cmake` `ninja` `meson` `just` `gcc` `clang` `cc` | U+F08EA | 󰣪 | 编译构建 |
| `curl` `wget` `aria2c` `ping` `mtr` `dig` `nslookup` `cloudflared` | U+F059F | 󰖟 | 网络 |
| `sqlite3` `psql` `mysql` `redis-cli` `duckdb` | U+F01BC | 󰆼 | 数据库 |
| `systemctl` | U+F0493 | 󰒓 | 系统服务 |
| `tmux` `sesh` | U+EBC8 |  | tmux |
| `latexmk` `tectonic` `xelatex` `pdflatex` `lualatex` `typst` | U+E81F |  | LaTeX 和 Typst |
| `zathura` | U+F0226 | 󰈦 | PDF |
| `typora` `pandoc` | U+E73E |  | Markdown |
| `ffmpeg` `yt-dlp` `mpv` | U+F0381 | 󰎁 | 音视频 |
| `emacs*` | U+E632 |  | Emacs |
| `nano` `micro` `hx` `helix` | U+F0DC8 | 󰷈 | 其他编辑器 |
| `zsh*` `bash*` `fish*` `dash*` `sh` `shell` | U+F489 |  | shell |

所有字形都需要 Nerd Font. U+EC82 和 U+EC81 是 codicons 的 `claude` 和 `openai` 字形, 较旧的 Nerd Font 版本没有. 没有模式匹配的程序使用默认图标; `tmux-autoname status` 会打印它的 Activity, 你可以把它加入 `@tmux-autoname-icons`.

`@tmux-autoname-icons` 是用空白分隔的 `pattern=icon` 对, 每一对在第一个 `=` 处拆分. 图标不能包含空白. 你的条目排在内置表之前, 所以也可以覆盖内置表:

```tmux
set -g @tmux-autoname-icons 'frob*=󰏗 python*=X'
set -g @tmux-autoname-icon-default '·'
```

## 命令

```
tmux-autoname sync [-t pane_or_window]
tmux-autoname auto [-t window]
tmux-autoname status [-t window]
tmux-autoname help
```

- `sync` 设置某个面板或窗口所属窗口的名字和图标, 依据的是该窗口的**活动**面板, 而不是你传入的面板. 钩子和 zsh 集成会调用它; 你很少需要手动执行.
- `auto` 忘记 Manual Name, 并立即同步.
- `status` 打印 `name:`, `applied:` (`sync` 最近一次设置的名字), `manual:`, `activity:`, `icon:`, `project:`, `task:` 和 `synced:` (窗口上次同步是多久以前, 或 `never`) 几行. 你正在这个窗口里工作, 而 `synced:` 却是很久以前, 说明同步没有在运行.

Manual Name (tmux 自带的 `prefix` + <kbd>,</kbd>, 或 `rename-window`) 会一直保留, 直到你运行 `tmux-autoname auto`, 或把窗口名改成空字符串 (`tmux rename-window ""`). 改名会立即设置手动标记, 恢复自动命名会清除它.

## 选项

| 选项 | 默认值 | 含义 |
|---|---|---|
| `@tmux-autoname-icons` | 空 | 你的 `pattern=icon` 对, 在内置表之前检查 |
| `@tmux-autoname-icon-default` | U+F018D (󰆍) | 没有模式匹配时的图标 |
| `@tmux-autoname-manual-mark` | U+F03EB (󰏫) | 手动标记; 设为空值则不显示标记 |
| `@tmux-autoname-key-auto` | 未设置 | `prefix` 键表中对当前窗口执行 `auto` 的按键 |

在插件加载之前设置:

```tmux
set -g @tmux-autoname-key-auto 'M-a'
```

## 可选: tmux-palette

如果使用 [tmux-palette](https://github.com/eduwass/tmux-palette), `integrations/tmux-palette.json` 中有两个 `Windows` 分类的条目:

- **Restore Automatic Window Name** 运行 `rename-window ''`, 插件的钩子把它变成 `tmux-autoname auto`.
- **Show Window Name Status** 用普通的 `display-message` 显示名字, applied 名字, 名字是否为手动, 以及图标.

两个条目都不需要插件的路径. tmux-palette 只从 `~/.config/tmux-palette/commands.json` 读取用户条目, 所以请把这两个条目复制到这个数组中; 插件不会修改它.

## 升级到 2.0

2.0 改变了名字所表达的内容 (见 [ADR 0007](docs/adr/0007-project-and-task-names.md)).

- 名字不再以程序开头: `claude:paxc-approx-dnn` 现在是 `paxc-approx-dnn`. 程序由图标显示.
- `main` 和 `master` 以外的分支是 Task: `patent-value-identification/ch4-selector-improvement`.
- 子目录不再放进名字.
- `@tmux-autoname-area-depth` 和 `@tmux-autoname-omit-session` 已移除. 请从配置中删除它们.
- 如果你的状态栏格式显示 `#W`, 可以用 `#{=/24/…:window_name}` 截断过长的 `P/T` 名字.

## 升级到 1.0

1.0 是一次重写, 不迁移旧安装.

- Activity 后的分隔符现在总是 `:`. 1.0 之前的版本在 omit-session 开启时给出 `zsh/src`; 1.0 给出 `zsh:src`.
- `@tmux-autoname-omit-session` 默认为 `on`. 设为 `off` 可以在每个名字中保留 Workspace, 与 0.7 的行为相同. (2.0 已移除.)
- `@tmux-autoname-bin` 已移除. 请从配置中删除它.
- 把 `#{@tmux-autoname-icon}` 加入你的格式 (见[显示图标](#显示图标)). 如果你的格式中有按窗口名选择图标的 `#{m:...,#W}` 表, 请删除它.
- 加载时会覆盖索引 `[120]` 上的旧钩子. 旧版本的选项和逐窗口状态会保留到 tmux server 重启; 如果想要干净的状态, 运行一次 `tmux kill-server`.

见 [CHANGELOG.md](CHANGELOG.md).

## 局限

- 没有 zsh 集成时, 名字和图标只在 tmux 自身的窗口, 面板和会话事件上更新, 不会因为同一面板中的新前台命令或 `cd` 而更新.
- Project 和 Task 只使用 `git`; 其他版本控制系统会退回到会话容器规则或会话名.
- 程序在运行期间切换分支或进入 worktree 时 (比如编码 Agent), 名字要到下一次 tmux 事件 (切换窗口或面板) 或程序退出时才会更新. 程序运行期间没有钩子会触发.
- 远程主机是传给 `ssh` 的名字 (例如 `~/.ssh/config` 中的 `Host` 别名), 而不是解析后的 `HostName`.

## 开发与验证

```sh
shellcheck tmux-autoname.tmux bin/tmux-autoname test/run.sh
sh test/run.sh
```

`test/run.sh` 启动真实的, 隔离的 tmux server (`tmux -L <name>`), 并用以所需名字 exec 出来的伪造进程驱动它们, 因此测试的是真实的钩子, 而不是它们的副本. 测试需要 `perl` 来设置伪造进程的 `argv[0]`, 使用 `git` 和 `zsh` 的测试还需要这两个程序. CI 在 dash 下用 tmux 3.3a, 3.4 和 3.5a 运行测试.
